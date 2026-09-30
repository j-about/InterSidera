#!/usr/bin/env node
// The nginx edge diffed against frontend/security-headers.ts (make check-delivery, the CI frontend
// job; brief l.274 "standard security headers set by nginx", l.275 no query strings or coordinates
// in logs, l.370 and l.489-490 frontend/nginx.conf: SPA fallback, immutable hashed assets, /api
// proxy, security headers, optional TLS, l.556 index.html no-cache and hashed assets immutable;
// docs/architecture.md "Deployment"). Hermetic: Node built-ins and committed files, no Docker.
// The web image's entrypoint renders frontend/nginx/templates/*.template with envsubst restricted
// to the SKY_* variables into /etc/nginx/conf.d/, which frontend/nginx.conf includes at http level.
// This script emulates that rendering for mode in {http, tls} x origin in {the module's default,
// https://geocoder.example:8443, --origin}, splices every include (/etc/nginx/conf.d/*.conf -> the
// rendered templates sorted by name, /etc/nginx/sky/<name> -> nginx/sky/<name>, mime.types kept and
// skipped, anything else a finding), tokenizes the result the way nginx does (ngx_conf_read_token:
// `#` opens a comment at the start of a token; an unquoted word ends at space, tab, CR, LF, `;` or
// `{`, never `}`; `{` right after `$` continues the word; `\" \' \\ \t \r \n` are the only escapes,
// in quoted and unquoted words alike) into {name, args, block?, file, line} nodes and asserts:
//   (1) exactly nine http-level `add_header ... always`: the seven of securityHeaders() byte for
//       byte, `Cache-Control $sky_cache_control` and `Strict-Transport-Security $sky_hsts`; no
//       add_header below http (a scope declaring one loses every inherited header), no
//       add_header_inherit, no Content-Security-Policy-Report-Only;
//   (2) the maps: $sky_hsts exactly `default ""` + `on "max-age=31536000; includeSubDomains"` (no
//       preload); $sky_cache_control volatile and evaluated with nginx map semantics (string keys
//       case-insensitively first, `~` regexes in order of appearance, then default) over a URI
//       table; no duplicate string key (nginx refuses a "conflicting parameter") and no capturing
//       group in a regex key (it would overwrite the request's $1..$9; `(?:...)` only);
//   (3) the servers of the mode, each with `server_name _`: http = one `listen 80 default_server`
//       server without ssl_* serving app.conf; tls = the :80 redirect (`/healthz` 204, `return 301
//       https://$host$request_uri`) and the :443 server (http2, the certificate pair, TLSv1.2 and
//       TLSv1.3, ECDHE-only ciphers, the session settings, tickets off, no stapling, no
//       ssl_dhparam, no ssl_early_data) serving app.conf;
//   (4) the application locations: `try_files $uri /index.html`, the three `return 404`, the proxy
//       set with `proxy_hide_header Server`, the three proxy timeouts present and no
//       `proxy_intercept_errors on`, `/healthz`, root, index, `gzip_static on`, `gzip_vary on`;
//   (5) `gzip on` nowhere; a `gzip_types` names neither application/octet-stream nor `*`;
//       `gzip_static` never `always`;
//   (6) `server_tokens off` at http level and no other server_tokens value anywhere,
//       `client_max_body_size`, `log_not_found off`, http-level `error_log` at crit;
//   (7) `upstream skyapi`: `server api:8000 resolve`, `zone`, `resolver 127.0.0.11`, `keepalive`;
//   (8) the access_log format references none of the request line, query string, referer, user
//       agent, client address, X-Forwarded-For, $arg_*, $cookie_* or $http_cookie; every access_log
//       is `off` or uses that format;
//   (9) mime.types included and a `types` block mapping webmanifest to application/manifest+json;
//   (10) the rendering: only ${SKY_GEOCODER_ORIGIN} and ${SKY_WEB_MODE} in the templates, no
//        leftover placeholder, every remaining $variable in the allow-list, every include resolved,
//        no syntax error;
//   (11) frontend/Dockerfile's final stage sets SKY_GEOCODER_ORIGIN to CSP_GEOCODER_ORIGIN_DEFAULT,
//        SKY_WEB_MODE=http and NGINX_ENVSUBST_FILTER=^SKY_.
// A self-test then applies 19 textual mutations to an in-memory copy of the tree (never to the
// files) and requires each to add at least one finding the unmutated tree does not have; a mutation
// nobody catches, or whose text is no longer in the tree, is a finding of its own in the same shape
// (`<file>:<line> self-test: mutation <n> (<what>) not caught` or `... did not apply: ...`,
// anchored on the mutation's file and on the line its text starts at).
// Output: findings one per line (`file:line directive: message`) on stderr and exit 1; otherwise
// exit 0. Both end with one summary line on stdout:
//   nginx headers: 2 modes x 2 origins, <n> checks, 0 findings; self-test 19/19 mutations caught
// Usage: node scripts/check_nginx_headers.mjs [--root <dir>] [--origin <origin>] [--no-self-test]
//   --root defaults to <repo>/frontend; --origin adds a third origin (3 origins in the summary);
//   any argument error prints one line plus the usage line and exits 2.
// No dependencies; Node 24 built-ins only (the .ts import relies on Node's type stripping).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import {
  CSP_GEOCODER_ORIGIN_DEFAULT,
  geocoderOriginFromEnv,
  securityHeaders,
} from '../frontend/security-headers.ts';

const USAGE =
  'usage: node scripts/check_nginx_headers.mjs [--root <dir>] [--origin <origin>] [--no-self-test]';
const MODES = ['http', 'tls'];
const SECOND_ORIGIN = 'https://geocoder.example:8443';
/** The names the image entrypoint substitutes (NGINX_ENVSUBST_FILTER=^SKY_, defined names only). */
const TEMPLATE_VARIABLES = ['SKY_GEOCODER_ORIGIN', 'SKY_WEB_MODE'];
/** Every `$name` the rendered tree may reference. */
const VARIABLE_ALLOW_LIST = new Set([
  'uri',
  'host',
  'https',
  'scheme',
  'request_uri',
  'proxy_add_x_forwarded_for',
  'status',
  'request_method',
  'body_bytes_sent',
  'request_time',
  'upstream_response_time',
  'upstream_http_x_request_id',
  'time_iso8601',
  'sky_cache_control',
  'sky_hsts',
]);
/** Variables the access log format may never reference (brief l.275). */
const LOG_FORBIDDEN_VARIABLES = new Set([
  'request',
  'request_uri',
  'args',
  'query_string',
  'http_referer',
  'http_user_agent',
  'remote_addr',
  'http_x_forwarded_for',
  'http_cookie',
]);
const LOG_FORBIDDEN_PREFIXES = ['arg_', 'cookie_'];
const HSTS_VALUE = 'max-age=31536000; includeSubDomains';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const HOURLY = 'public, max-age=3600';
/** Assertion (2): what the $sky_cache_control map must answer per request URI. */
const CACHE_CONTROL_TABLE = [
  ['/index.html', 'no-cache'],
  ['/assets/index-BIJzuB5Y.css', IMMUTABLE],
  ['/assets/babylon-uo9-43xz.js', IMMUTABLE],
  ['/assets/x.js', IMMUTABLE],
  ['/favicon.svg', HOURLY],
  ['/manifest.webmanifest', HOURLY],
  ['/apple-touch-icon.png', HOURLY],
  ['/icon-192.png', HOURLY],
  ['/icon-512.png', HOURLY],
  ['/icon-192-maskable.png', HOURLY],
  ['/icon-512-maskable.png', HOURLY],
  ['/', ''],
  ['/nowhere', ''],
  ['/api/v1/health', ''],
  ['/api/v1/catalogs/stars', ''],
  ['/healthz', ''],
  ['/.vite/manifest.json', ''],
  ['/index.html.gz', ''],
];
const TLS_CERT = '/etc/nginx/certs/fullchain.pem';
const TLS_KEY = '/etc/nginx/certs/privkey.pem';
const WEB_ROOT = '/usr/share/nginx/html';
const MIME_TYPES = '/etc/nginx/mime.types';
const CONF_D_GLOB = '/etc/nginx/conf.d/*.conf';
const MAX_INCLUDE_DEPTH = 8;

const MAIN = 'nginx.conf';
const HEADERS = 'nginx/templates/00-headers.conf.template';
const APP = 'nginx/sky/app.conf';
const TLS = 'nginx/sky/mode-tls.conf';
/** The self-test: each mutation of the in-memory tree must add at least one finding. */
const MUTATIONS = [
  {
    file: HEADERS,
    from: 'add_header X-Frame-Options "DENY" always;\n',
    to: '',
    what: 'delete X-Frame-Options',
  },
  { file: HEADERS, from: '"DENY"', to: '"SAMEORIGIN"', what: 'X-Frame-Options DENY -> SAMEORIGIN' },
  {
    file: HEADERS,
    from: '"strict-origin-when-cross-origin" always;',
    to: '"strict-origin-when-cross-origin";',
    what: 'drop one always',
  },
  {
    file: APP,
    from: '    try_files $uri /index.html;\n',
    to: '    try_files $uri /index.html;\n    add_header X-Debug 1 always;\n',
    what: 'add_header X-Debug inside location /',
  },
  { file: HEADERS, from: 'immutable"', to: 'immutabel"', what: 'immutable -> immutabel' },
  { file: HEADERS, from: '"no-cache"', to: '"no-store"', what: 'no-cache -> no-store' },
  { file: APP, from: 'gzip_static on;', to: 'gzip on;', what: 'gzip_static on -> gzip on' },
  {
    file: APP,
    from: null,
    to: '\ngzip_types application/octet-stream;\n',
    what: 'append gzip_types application/octet-stream',
  },
  {
    file: MAIN,
    from: '"path":"$uri"',
    to: '"path":"$request"',
    what: '$uri -> $request in the log format',
  },
  {
    file: APP,
    from: 'location = /api/v1/docs/ { return 404; }\n',
    to: '',
    what: 'delete the /api/v1/docs/ location',
  },
  {
    file: APP,
    from: '    proxy_hide_header Server;\n',
    to: '',
    what: 'delete proxy_hide_header Server',
  },
  { file: MAIN, from: '    server_tokens off;\n', to: '', what: 'delete server_tokens off' },
  {
    file: HEADERS,
    from: '${SKY_GEOCODER_ORIGIN}',
    to: '${SKY_GEOCODER}',
    what: '${SKY_GEOCODER_ORIGIN} -> ${SKY_GEOCODER}',
  },
  {
    file: HEADERS,
    from: `"${HSTS_VALUE}"`,
    to: '"max-age=0; includeSubDomains"',
    what: 'HSTS max-age=0',
  },
  { file: HEADERS, from: `"${HSTS_VALUE}"`, to: `"${HSTS_VALUE}; preload"`, what: 'HSTS preload' },
  {
    file: TLS,
    from: '    ssl_session_tickets off;\n',
    to: '',
    what: 'delete ssl_session_tickets off',
  },
  {
    file: APP,
    from: 'try_files $uri /index.html;',
    to: 'try_files $uri =404;',
    what: 'try_files $uri =404',
  },
  { file: MAIN, from: '    log_not_found off;\n', to: '', what: 'delete log_not_found off' },
  { file: MAIN, from: 'resolve;', to: ';', what: 'server api:8000 without resolve' },
];

function usageError(message) {
  console.error(`check_nginx_headers: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

/** The options; an unknown option, a positional or a missing value exits 2, never a stack trace. */
function parseCommandLine() {
  try {
    return parseArgs({
      options: {
        root: { type: 'string' },
        origin: { type: 'string' },
        'no-self-test': { type: 'boolean', default: false },
      },
    }).values;
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------------------------
// The tree: the committed files as an in-memory map of root-relative paths (the self-test mutates
// copies of this map, never the files).

function loadTree(root) {
  const files = new Map();
  const read = (rel) => files.set(rel, readFileSync(path.join(root, rel), 'utf8'));
  read(MAIN);
  for (const [dir, suffix] of [
    ['nginx/templates', '.template'],
    ['nginx/sky', '.conf'],
  ]) {
    const abs = path.join(root, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)
      .filter((n) => n.endsWith(suffix))
      .sort()) {
      read(`${dir}/${name}`);
    }
  }
  if (existsSync(path.join(root, 'Dockerfile'))) read('Dockerfile');
  return files;
}

// ---------------------------------------------------------------------------------------------
// The tokenizer (ngx_conf_read_token) and the tree builder.

/** The unescaping ngx_conf_read_token applies while copying a word: `\" \' \\ \t \r \n` only. */
function unescapeWord(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === '"' || next === "'" || next === '\\') {
        out += next;
        i += 1;
        continue;
      }
      if (next === 't' || next === 'r' || next === 'n') {
        out += { t: '\t', r: '\r', n: '\n' }[next];
        i += 1;
        continue;
      }
    }
    out += raw[i];
  }
  return out;
}

const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

/**
 * Parses one configuration text into `{ nodes, errors }`: nodes are `{ name, args, block?, file,
 * line }` (`line` is where the directive's name starts), errors are `{ line, message }` in nginx's
 * own words. Every state of ngx_conf_read_token is mirrored: `sharp` (a comment), `quoted` (the
 * character after a backslash), `needSpace` (after a closing quote only whitespace, `;`, `{` or `)`
 * may follow), `lastSpace` (between words), the two quote flags and `variable` (`$`, so that `{`
 * continues the word).
 */
function parseConf(text, file) {
  const nodes = [];
  const errors = [];
  const stack = [nodes];
  let words = [];
  const endDirective = (opensBlock, line) => {
    if (words.length === 0) {
      errors.push({ line, message: `unexpected "${opensBlock ? '{' : ';'}"` });
      return;
    }
    const node = {
      name: words[0].value,
      args: words.slice(1).map((w) => w.value),
      file,
      line: words[0].line,
    };
    if (opensBlock) node.block = [];
    stack[stack.length - 1].push(node);
    if (opensBlock) stack.push(node.block);
    words = [];
  };
  let line = 1;
  let start = 0;
  let startLine = 1;
  let sharp = false;
  let quoted = false;
  let needSpace = false;
  let lastSpace = true;
  let dQuoted = false;
  let sQuoted = false;
  let variable = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      line += 1;
      sharp = false;
    }
    if (sharp) continue;
    if (quoted) {
      quoted = false;
      continue;
    }
    if (needSpace) {
      needSpace = false;
      lastSpace = true;
      if (isSpace(ch)) continue;
      if (ch === ';') {
        endDirective(false, line);
        continue;
      }
      if (ch === '{') {
        endDirective(true, line);
        continue;
      }
      if (ch !== ')') {
        errors.push({ line, message: `unexpected "${ch}" after a quoted word` });
        continue;
      }
      // `)` after a quote starts a new word, as in nginx.
    }
    if (lastSpace) {
      start = i;
      startLine = line;
      if (isSpace(ch)) continue;
      if (ch === ';' || ch === '{') {
        endDirective(ch === '{', line);
        continue;
      }
      if (ch === '}') {
        if (words.length > 0) {
          errors.push({ line, message: 'unexpected "}"' });
          words = [];
        }
        if (stack.length === 1) errors.push({ line, message: 'unexpected "}"' });
        else stack.pop();
        continue;
      }
      if (ch === '#') {
        sharp = true;
        continue;
      }
      lastSpace = false;
      if (ch === '\\') quoted = true;
      else if (ch === '"') {
        start += 1;
        dQuoted = true;
      } else if (ch === "'") {
        start += 1;
        sQuoted = true;
      } else if (ch === '$') variable = true;
      continue;
    }
    if (ch === '{' && variable) continue;
    variable = false;
    if (ch === '\\') {
      quoted = true;
      continue;
    }
    if (ch === '$') {
      variable = true;
      continue;
    }
    let found = false;
    if (dQuoted) {
      if (ch === '"') {
        dQuoted = false;
        needSpace = true;
        found = true;
      }
    } else if (sQuoted) {
      if (ch === "'") {
        sQuoted = false;
        needSpace = true;
        found = true;
      }
    } else if (isSpace(ch) || ch === ';' || ch === '{') {
      lastSpace = true;
      found = true;
    }
    if (found) {
      words.push({ value: unescapeWord(text.slice(start, i)), line: startLine });
      if (ch === ';') endDirective(false, line);
      else if (ch === '{') endDirective(true, line);
    }
  }
  if (dQuoted || sQuoted) {
    errors.push({ line, message: 'unexpected end of file, expecting the closing quote' });
  } else if (!lastSpace && !needSpace) {
    words.push({ value: unescapeWord(text.slice(start)), line: startLine });
  }
  if (words.length > 0) {
    errors.push({ line, message: 'unexpected end of file, expecting ";" or "}"' });
  }
  if (stack.length > 1) errors.push({ line, message: 'unexpected end of file, expecting "}"' });
  return { nodes, errors };
}

// ---------------------------------------------------------------------------------------------
// Tree helpers.

function walk(nodes, visit, ancestors = []) {
  for (const node of nodes) {
    visit(node, ancestors);
    if (node.block) walk(node.block, visit, [...ancestors, node]);
  }
}

const describe = (node) => [node.name, ...node.args].join(' ');
const contextOf = (ancestors) =>
  ancestors.length === 0 ? 'main' : ancestors.map(describe).join(' > ');
const children = (node, name) => (node.block ?? []).filter((n) => n.name === name);
const argsEqual = (node, expected) =>
  node.args.length === expected.length && node.args.every((a, i) => a === expected[i]);

/** Every `$name` / `${name}` reference in a text. */
function variableNames(text) {
  const names = [];
  for (const match of text.matchAll(/\$(?:\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))/g)) {
    names.push(match[1] ?? match[2]);
  }
  return names;
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

// ---------------------------------------------------------------------------------------------
// The check context: a counter and a de-duplicated, ordered set of findings. Every rendering runs
// the whole suite, so a mode- and origin-independent defect yields one line, not four.

function createContext(root) {
  return { root, checks: 0, findings: new Set() };
}

function displayPath(ctx, rel) {
  const abs = path.join(ctx.root, rel);
  const relative = path.relative(process.cwd(), abs);
  return relative === '' || relative.startsWith('..') ? abs : relative;
}

function finding(ctx, rel, line, directive, message) {
  ctx.findings.add(`${displayPath(ctx, rel)}:${line} ${directive}: ${message}`);
}

/** One assertion: counts as a check, records a finding when `ok` is false, returns `ok`. */
function check(ctx, ok, rel, line, directive, message) {
  ctx.checks += 1;
  if (!ok) finding(ctx, rel, line, directive, message);
  return ok;
}

/** One assertion over a list of offending nodes (a "nowhere" rule): each offender is a finding. */
function checkNone(ctx, offenders, message) {
  ctx.checks += 1;
  for (const [node, ancestors] of offenders) {
    finding(ctx, node.file, node.line, describe(node), `${message} (${contextOf(ancestors)})`);
  }
  return offenders.length === 0;
}

/** Collects `[node, ancestors]` pairs matching `predicate` anywhere under `nodes`. */
function collect(nodes, predicate) {
  const out = [];
  walk(nodes, (node, ancestors) => {
    if (predicate(node, ancestors)) out.push([node, ancestors]);
  });
  return out;
}

/** `name args...` present exactly as given among the direct children of `block`. */
function expectDirective(ctx, block, name, args, label) {
  const matches = children(block, name);
  const exact = matches.find((n) => argsEqual(n, args));
  const anchor = exact ?? matches[0] ?? block;
  const wanted = `\`${[name, ...args].join(' ')}\``;
  const message =
    matches.length === 0
      ? `${label}missing ${wanted}`
      : `${label}expected ${wanted}, found \`${describe(matches[0])}\``;
  return check(ctx, exact !== undefined, anchor.file, anchor.line, name, message);
}

/** `name` present (any value) among the direct children of `block`. */
function expectPresent(ctx, block, name, label) {
  const matches = children(block, name);
  return check(
    ctx,
    matches.length > 0,
    block.file,
    block.line,
    name,
    `${label}missing \`${name}\``,
  );
}

// ---------------------------------------------------------------------------------------------
// Rendering (envsubst on the SKY_* names) and include expansion.

function renderTemplate(ctx, rel, text, vars) {
  let unknown = 0;
  const rendered = text.replace(
    /\$(?:\{(SKY_[A-Za-z0-9_]*)\}|(SKY_[A-Za-z0-9_]*))/g,
    (match, braced, bare, offset) => {
      const name = braced ?? bare;
      if (Object.hasOwn(vars, name)) return vars[name];
      unknown += 1;
      finding(
        ctx,
        rel,
        lineAt(text, offset),
        `\${${name}}`,
        `unknown template variable: the entrypoint renders ${TEMPLATE_VARIABLES.join(' and ')} only, so it would stay in the rendered file (outside a comment nginx refuses it as an unknown variable)`,
      );
      return match;
    },
  );
  ctx.checks += 1;
  if (unknown === 0) {
    const left = /\$\{?SKY_[A-Za-z0-9_]*\}?/.exec(rendered);
    check(
      ctx,
      left === null,
      rel,
      left === null ? 1 : lineAt(rendered, left.index),
      'template',
      `leftover placeholder ${left?.[0] ?? ''} after rendering`,
    );
  }
  return rendered;
}

/** Parses `text` (from `rel`), records its syntax errors and splices its includes. */
function parseTree(ctx, files, rendered, rel, text, depth) {
  const { nodes, errors } = parseConf(text, rel);
  for (const error of errors) finding(ctx, rel, error.line, 'syntax', error.message);
  return expandIncludes(ctx, files, rendered, nodes, depth);
}

function expandIncludes(ctx, files, rendered, nodes, depth) {
  const out = [];
  for (const node of nodes) {
    if (node.block) node.block = expandIncludes(ctx, files, rendered, node.block, depth);
    if (node.name !== 'include') {
      out.push(node);
      continue;
    }
    const target = node.args[0] ?? '';
    if (target === MIME_TYPES) {
      out.push(node); // present, and its body is not ours to check
      continue;
    }
    if (depth >= MAX_INCLUDE_DEPTH) {
      finding(
        ctx,
        node.file,
        node.line,
        'include',
        `${target}: includes nest deeper than ${MAX_INCLUDE_DEPTH}`,
      );
      continue;
    }
    if (target === CONF_D_GLOB) {
      if (rendered.size === 0) {
        finding(
          ctx,
          node.file,
          node.line,
          'include',
          `${target}: no nginx/templates/*.template to render`,
        );
      }
      for (const name of [...rendered.keys()].sort()) {
        const { rel, text } = rendered.get(name);
        out.push(...parseTree(ctx, files, rendered, rel, text, depth + 1));
      }
      continue;
    }
    const sky = /^\/etc\/nginx\/sky\/([^/]+)$/.exec(target);
    if (sky !== null) {
      const rel = `nginx/sky/${sky[1]}`;
      const text = files.get(rel);
      if (text === undefined) {
        finding(ctx, node.file, node.line, 'include', `${target}: no such file (${rel})`);
        continue;
      }
      out.push(...parseTree(ctx, files, rendered, rel, text, depth + 1));
      continue;
    }
    finding(
      ctx,
      node.file,
      node.line,
      'include',
      `${target} is outside the include table (${CONF_D_GLOB}, /etc/nginx/sky/<name>, ${MIME_TYPES})`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The map evaluator (ngx_http_map_module): string keys are matched case-insensitively (the module
// lowercases both the keys and the looked-up value), then the `~` (case-sensitive) and `~*`
// (case-insensitive) regexes in order of appearance, then `default`. A leading `\~` is a literal
// tilde. `hostnames` and `include` are outside this file's needs and refused.

/**
 * Whether a PCRE source has a capturing group: an unescaped `(` outside a character class that
 * is not followed by `?`, or a named group (`(?<name>`, `(?'name'`, `(?P<name>`); `(?:...)` and
 * the lookarounds capture nothing.
 */
function hasCapturingGroup(source) {
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      if (source[i + 1] === '^') i += 1;
      if (source[i + 1] === ']') i += 1;
      continue;
    }
    if (ch !== '(') continue;
    const rest = source.slice(i + 1);
    if (!rest.startsWith('?') || /^\?(?:P?<[A-Za-z_]|')/.test(rest)) return true;
  }
  return false;
}

function compileMap(ctx, mapNode) {
  const strings = new Map();
  const regexes = [];
  let defaultValue = '';
  let ok = true;
  const label = `map ${mapNode.args.join(' ')}`;
  for (const entry of mapNode.block ?? []) {
    const key = entry.name;
    if (key === 'volatile' && entry.args.length === 0) continue;
    if (key === 'default' && entry.args.length === 1) {
      defaultValue = entry.args[0];
      continue;
    }
    if (key === 'hostnames' || key === 'include') {
      ok = check(
        ctx,
        false,
        entry.file,
        entry.line,
        label,
        `${key} is not supported by this evaluator`,
      );
      continue;
    }
    if (
      !check(
        ctx,
        entry.args.length === 1,
        entry.file,
        entry.line,
        label,
        `"${key}" needs exactly one value`,
      )
    ) {
      ok = false;
      continue;
    }
    const value = entry.args[0];
    if (
      !check(
        ctx,
        !value.startsWith('$'),
        entry.file,
        entry.line,
        label,
        `"${key}" maps to a variable; literal values only`,
      )
    ) {
      ok = false;
      continue;
    }
    if (key.startsWith('~')) {
      const caseless = key.startsWith('~*');
      const source = key.slice(caseless ? 2 : 1);
      check(
        ctx,
        !hasCapturingGroup(source),
        entry.file,
        entry.line,
        label,
        `regex ${key}: a capturing group would overwrite the request's $1..$9 when the map is evaluated; use (?:...)`,
      );
      try {
        regexes.push({ re: new RegExp(source, caseless ? 'i' : ''), value });
      } catch (error) {
        ok = check(
          ctx,
          false,
          entry.file,
          entry.line,
          label,
          `regex ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    const lowered = (key.startsWith('\\~') ? key.slice(1) : key).toLowerCase();
    check(
      ctx,
      !strings.has(lowered),
      entry.file,
      entry.line,
      label,
      `duplicate key "${key}" (nginx refuses it: conflicting parameter)`,
    );
    strings.set(lowered, value);
  }
  if (!ok) return undefined;
  return (input) => {
    const exact = strings.get(input.toLowerCase());
    if (exact !== undefined) return exact;
    const regex = regexes.find((r) => r.re.test(input));
    return regex === undefined ? defaultValue : regex.value;
  };
}

// ---------------------------------------------------------------------------------------------
// The assertions of one rendering.

function valueDiff(actual, expected, origin) {
  let at = 0;
  while (at < actual.length && at < expected.length && actual[at] === expected[at]) at += 1;
  const window = (s) => JSON.stringify(s.slice(Math.max(0, at - 24), at + 24));
  return `value differs from securityHeaders() at offset ${at}: got ${window(actual)}, expected ${window(expected)} (origin ${origin})`;
}

/** (1) The nine http-level headers and nothing below http. */
function checkHeaders(ctx, nodes, httpBlock, origin) {
  const expected = {
    ...securityHeaders({ geocoderOrigin: origin }),
    'Cache-Control': '$sky_cache_control',
    'Strict-Transport-Security': '$sky_hsts',
  };
  const names = Object.keys(expected);
  const headers = children(httpBlock, 'add_header');
  check(
    ctx,
    headers.length === 9,
    httpBlock.file,
    httpBlock.line,
    'http',
    `expected nine http-level add_header directives, found ${headers.length}`,
  );
  const seen = new Set();
  for (const header of headers) {
    const name = header.args[0] ?? '';
    const directive = `add_header ${name}`;
    if (
      !check(
        ctx,
        Object.hasOwn(expected, name),
        header.file,
        header.line,
        directive,
        `unexpected header; the nine are ${names.join(', ')}`,
      )
    ) {
      continue;
    }
    check(ctx, !seen.has(name), header.file, header.line, directive, 'duplicate header');
    seen.add(name);
    check(
      ctx,
      header.args.length === 3 && header.args[2] === 'always',
      header.file,
      header.line,
      directive,
      header.args.length < 3
        ? 'missing "always" (error responses would lose the header)'
        : `expected \`add_header <name> <value> always\`, found ${header.args.length - 1} arguments`,
    );
    const value = header.args[1] ?? '';
    check(
      ctx,
      value === expected[name],
      header.file,
      header.line,
      directive,
      valueDiff(value, expected[name], origin),
    );
  }
  for (const name of names) {
    check(
      ctx,
      seen.has(name),
      httpBlock.file,
      httpBlock.line,
      'add_header',
      `missing ${name} at http level`,
    );
  }
  checkNone(
    ctx,
    collect(
      nodes,
      (node, ancestors) =>
        node.name === 'add_header' && ancestors[ancestors.length - 1] !== httpBlock,
    ),
    'add_header below http level: this scope would drop every http-level header',
  );
  checkNone(
    ctx,
    collect(nodes, (node) => node.name === 'add_header_inherit'),
    'add_header_inherit is not part of the edge',
  );
  checkNone(
    ctx,
    collect(
      nodes,
      (node) =>
        node.name === 'add_header' &&
        (node.args[0] ?? '').toLowerCase() === 'content-security-policy-report-only',
    ),
    'no report-only policy: the brief forbids a report endpoint (l.275)',
  );
}

/** (2) The two maps. */
function checkMaps(ctx, httpBlock) {
  const maps = children(httpBlock, 'map');
  const hsts = maps.find((m) => argsEqual(m, ['$https', '$sky_hsts']));
  if (
    check(
      ctx,
      hsts !== undefined,
      httpBlock.file,
      httpBlock.line,
      'map',
      'missing `map $https $sky_hsts`',
    )
  ) {
    const entries = hsts.block ?? [];
    const label = 'map $https $sky_hsts';
    check(
      ctx,
      entries.length === 2,
      hsts.file,
      hsts.line,
      label,
      `expected exactly two entries (default and on), found ${entries.length}`,
    );
    const def = entries.find((e) => e.name === 'default');
    check(
      ctx,
      def !== undefined && argsEqual(def, ['']),
      (def ?? hsts).file,
      (def ?? hsts).line,
      label,
      'default must be "" (no HSTS on plain http)',
    );
    const on = entries.find((e) => e.name === 'on');
    check(
      ctx,
      on !== undefined && argsEqual(on, [HSTS_VALUE]),
      (on ?? hsts).file,
      (on ?? hsts).line,
      label,
      `on must be "${HSTS_VALUE}" exactly (never preload without the maintainer)`,
    );
    checkNone(
      ctx,
      collect([hsts], (node) => node !== hsts && node.args.some((a) => /preload/i.test(a))),
      'HSTS preload is never sent',
    );
  }
  const cache = maps.find((m) => argsEqual(m, ['$uri', '$sky_cache_control']));
  if (
    check(
      ctx,
      cache !== undefined,
      httpBlock.file,
      httpBlock.line,
      'map',
      'missing `map $uri $sky_cache_control`',
    )
  ) {
    const label = 'map $uri $sky_cache_control';
    check(
      ctx,
      (cache.block ?? []).some((e) => e.name === 'volatile' && e.args.length === 0),
      cache.file,
      cache.line,
      label,
      'the $uri map must be volatile ($uri changes on the try_files internal redirect)',
    );
    const evaluate = compileMap(ctx, cache);
    if (evaluate !== undefined) {
      for (const [uri, want] of CACHE_CONTROL_TABLE) {
        const got = evaluate(uri);
        check(
          ctx,
          got === want,
          cache.file,
          cache.line,
          label,
          `${uri} -> ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
        );
      }
    }
  }
}

const sslDirectives = (server) =>
  collect(
    server.block ?? [],
    (node) => node.name.startsWith('ssl_') || (node.name === 'listen' && node.args.includes('ssl')),
  );
const includesApp = (server) => (server.block ?? []).some((node) => node.file === APP);

/** (3) The server set of the mode; returns the server that serves the application. */
function checkServers(ctx, httpBlock, mode) {
  const servers = children(httpBlock, 'server');
  const label = `${mode} mode: `;
  for (const server of servers) expectDirective(ctx, server, 'server_name', ['_'], label);
  if (mode === 'http') {
    if (
      !check(
        ctx,
        servers.length === 1,
        httpBlock.file,
        httpBlock.line,
        'server',
        `${label}expected exactly one server block, found ${servers.length}`,
      )
    ) {
      return undefined;
    }
    const [server] = servers;
    expectDirective(ctx, server, 'listen', ['80', 'default_server'], label);
    checkNone(ctx, sslDirectives(server), `${label}ssl directive in the plain server`);
    check(
      ctx,
      includesApp(server),
      server.file,
      server.line,
      'server',
      `${label}the server does not include /etc/nginx/sky/app.conf`,
    );
    return server;
  }
  if (
    !check(
      ctx,
      servers.length === 2,
      httpBlock.file,
      httpBlock.line,
      'server',
      `${label}expected two server blocks (the :80 redirect and :443), found ${servers.length}`,
    )
  ) {
    return undefined;
  }
  const byPort = (port) =>
    servers.find((s) => children(s, 'listen').some((l) => l.args[0] === port));
  const plain = byPort('80');
  if (
    check(
      ctx,
      plain !== undefined,
      httpBlock.file,
      httpBlock.line,
      'server',
      `${label}no server listens on 80`,
    )
  ) {
    expectDirective(ctx, plain, 'listen', ['80', 'default_server'], label);
    checkNone(ctx, sslDirectives(plain), `${label}ssl directive in the :80 redirect server`);
    check(
      ctx,
      !includesApp(plain),
      plain.file,
      plain.line,
      'server',
      `${label}the :80 server must redirect, not serve app.conf`,
    );
    const healthz = children(plain, 'location').find((l) => argsEqual(l, ['=', '/healthz']));
    if (
      check(
        ctx,
        healthz !== undefined,
        plain.file,
        plain.line,
        'location',
        `${label}missing \`location = /healthz\` in the :80 server (the healthcheck never follows the redirect)`,
      )
    ) {
      expectDirective(ctx, healthz, 'access_log', ['off'], label);
      expectDirective(ctx, healthz, 'return', ['204'], label);
    }
    const root = children(plain, 'location').find((l) => argsEqual(l, ['/']));
    if (
      check(
        ctx,
        root !== undefined,
        plain.file,
        plain.line,
        'location',
        `${label}missing \`location /\` in the :80 server`,
      )
    ) {
      expectDirective(ctx, root, 'return', ['301', 'https://$host$request_uri'], label);
    }
  }
  const tls = byPort('443');
  if (
    !check(
      ctx,
      tls !== undefined,
      httpBlock.file,
      httpBlock.line,
      'server',
      `${label}no server listens on 443`,
    )
  ) {
    return undefined;
  }
  expectDirective(ctx, tls, 'listen', ['443', 'ssl', 'default_server'], label);
  expectDirective(ctx, tls, 'http2', ['on'], label);
  expectDirective(ctx, tls, 'ssl_certificate', [TLS_CERT], label);
  expectDirective(ctx, tls, 'ssl_certificate_key', [TLS_KEY], label);
  const protocols = children(tls, 'ssl_protocols')[0];
  check(
    ctx,
    protocols !== undefined && [...protocols.args].sort().join(' ') === 'TLSv1.2 TLSv1.3',
    (protocols ?? tls).file,
    (protocols ?? tls).line,
    'ssl_protocols',
    `${label}expected \`ssl_protocols TLSv1.2 TLSv1.3\``,
  );
  const ciphers = children(tls, 'ssl_ciphers')[0];
  const suites = ciphers === undefined ? [] : (ciphers.args[0] ?? '').split(':');
  check(
    ctx,
    suites.length > 0 && suites.every((s) => s.startsWith('ECDHE-')),
    (ciphers ?? tls).file,
    (ciphers ?? tls).line,
    'ssl_ciphers',
    `${label}every suite must be an ECDHE- suite (Mozilla intermediate), found ${suites.filter((s) => !s.startsWith('ECDHE-')).join(', ') || 'none'}`,
  );
  expectDirective(ctx, tls, 'ssl_prefer_server_ciphers', ['off'], label);
  expectDirective(ctx, tls, 'ssl_session_timeout', ['1d'], label);
  expectDirective(ctx, tls, 'ssl_session_cache', ['shared:SkyTLS:10m'], label);
  expectDirective(ctx, tls, 'ssl_session_tickets', ['off'], label);
  checkNone(
    ctx,
    collect([tls], (node) => node.name === 'ssl_stapling' && node.args[0] === 'on'),
    `${label}no OCSP stapling`,
  );
  checkNone(
    ctx,
    collect([tls], (node) => node.name === 'ssl_early_data' && node.args[0] === 'on'),
    `${label}no 0-RTT`,
  );
  checkNone(
    ctx,
    collect([tls], (node) => node.name === 'ssl_dhparam'),
    `${label}no ssl_dhparam (the ECDHE-only suites use none)`,
  );
  check(
    ctx,
    includesApp(tls),
    tls.file,
    tls.line,
    'server',
    `${label}the :443 server does not include /etc/nginx/sky/app.conf`,
  );
  return tls;
}

/** (4) The application body inside the serving server. */
function checkApp(ctx, server, mode) {
  const label = `${mode} mode: `;
  expectDirective(ctx, server, 'root', [WEB_ROOT], label);
  expectDirective(ctx, server, 'index', ['index.html'], label);
  expectDirective(ctx, server, 'gzip_static', ['on'], label);
  expectDirective(ctx, server, 'gzip_vary', ['on'], label);
  const locations = children(server, 'location');
  const location = (args, hint) => {
    const found = locations.find((l) => argsEqual(l, args));
    check(
      ctx,
      found !== undefined,
      server.file,
      server.line,
      'location',
      `${label}missing \`location ${args.join(' ')}\`${hint}`,
    );
    return found;
  };
  const spa = location(['/'], ' (the SPA fallback)');
  if (spa !== undefined) expectDirective(ctx, spa, 'try_files', ['$uri', '/index.html'], label);
  const dotfiles = location(['~', '/\\.'], ' (dotfiles such as .vite/ answer 404)');
  if (dotfiles !== undefined) expectDirective(ctx, dotfiles, 'return', ['404'], label);
  for (const uri of ['/api/v1/docs', '/api/v1/docs/']) {
    const docs = location(['=', uri], ' (Swagger UI stays inside the network)');
    if (docs !== undefined) expectDirective(ctx, docs, 'return', ['404'], label);
  }
  const api = location(['^~', '/api/'], ' (the proxy)');
  if (api !== undefined) {
    expectDirective(ctx, api, 'proxy_pass', ['http://skyapi'], label);
    expectDirective(ctx, api, 'proxy_http_version', ['1.1'], label);
    const setHeaders = children(api, 'proxy_set_header');
    for (const [name, value] of [
      ['Connection', ''],
      ['Host', '$host'],
      ['X-Forwarded-For', '$proxy_add_x_forwarded_for'],
      ['X-Forwarded-Proto', '$scheme'],
    ]) {
      const set = setHeaders.find((s) => s.args[0] === name);
      check(
        ctx,
        set !== undefined && argsEqual(set, [name, value]),
        (set ?? api).file,
        (set ?? api).line,
        'proxy_set_header',
        `${label}expected \`proxy_set_header ${name} ${JSON.stringify(value)}\`${set === undefined ? ' (missing)' : `, found \`${describe(set)}\``}`,
      );
    }
    expectDirective(ctx, api, 'proxy_hide_header', ['Server'], label);
    for (const name of [
      'proxy_connect_timeout',
      'proxy_read_timeout',
      'proxy_max_temp_file_size',
    ]) {
      expectPresent(ctx, api, name, label);
    }
  }
  const healthz = location(['=', '/healthz'], ' (the container healthcheck)');
  if (healthz !== undefined) {
    expectDirective(ctx, healthz, 'access_log', ['off'], label);
    expectDirective(ctx, healthz, 'return', ['204'], label);
  }
  checkNone(
    ctx,
    collect([server], (node) => node.name === 'proxy_intercept_errors' && node.args[0] === 'on'),
    `${label}the API's own 503 body must reach the splash`,
  );
}

/** (5), (6), (7), (9): compression, tokens and logging switches, the upstream, the types. */
function checkHttpSettings(ctx, nodes, httpBlock) {
  checkNone(
    ctx,
    collect(nodes, (node) => node.name === 'gzip' && node.args[0] === 'on'),
    'no on-the-fly gzip: it weakens ETags and clears Accept-Ranges',
  );
  checkNone(
    ctx,
    collect(
      nodes,
      (node) =>
        node.name === 'gzip_types' &&
        node.args.some((a) => a === 'application/octet-stream' || a === '*'),
    ),
    'gzip_types must never cover the binary catalog',
  );
  checkNone(
    ctx,
    collect(nodes, (node) => node.name === 'gzip_static' && node.args[0] === 'always'),
    'gzip_static always ignores Accept-Encoding',
  );
  expectDirective(ctx, httpBlock, 'server_tokens', ['off'], '');
  checkNone(
    ctx,
    collect(nodes, (node) => node.name === 'server_tokens' && node.args[0] !== 'off'),
    'server_tokens must be off',
  );
  expectPresent(ctx, httpBlock, 'client_max_body_size', '');
  expectDirective(ctx, httpBlock, 'log_not_found', ['off'], '');
  const errorLogs = children(httpBlock, 'error_log');
  check(
    ctx,
    errorLogs.length > 0 && errorLogs.every((e) => e.args[1] === 'crit'),
    (errorLogs[0] ?? httpBlock).file,
    (errorLogs[0] ?? httpBlock).line,
    'error_log',
    'the http-level error_log must be at crit (request-bound lines carry the client address and the query string)',
  );
  const upstream = children(httpBlock, 'upstream').find((u) => u.args[0] === 'skyapi');
  if (
    check(
      ctx,
      upstream !== undefined,
      httpBlock.file,
      httpBlock.line,
      'upstream',
      'missing `upstream skyapi`',
    )
  ) {
    const servers = children(upstream, 'server');
    check(
      ctx,
      servers.length === 1 &&
        servers[0].args[0] === 'api:8000' &&
        servers[0].args.includes('resolve'),
      (servers[0] ?? upstream).file,
      (servers[0] ?? upstream).line,
      'server',
      'expected one `server api:8000 resolve` (re-resolved on every recreate of api, never a parse-time lookup)',
    );
    expectPresent(ctx, upstream, 'zone', '');
    const resolver = children(upstream, 'resolver')[0];
    check(
      ctx,
      resolver !== undefined && resolver.args.includes('127.0.0.11'),
      (resolver ?? upstream).file,
      (resolver ?? upstream).line,
      'resolver',
      'expected the Docker embedded DNS 127.0.0.11',
    );
    expectPresent(ctx, upstream, 'keepalive', '');
  }
  check(
    ctx,
    children(httpBlock, 'include').some((i) => i.args[0] === MIME_TYPES),
    httpBlock.file,
    httpBlock.line,
    'include',
    `missing \`include ${MIME_TYPES}\``,
  );
  const types = children(httpBlock, 'types');
  check(
    ctx,
    types.some((t) =>
      (t.block ?? []).some(
        (e) => e.name === 'application/manifest+json' && e.args.includes('webmanifest'),
      ),
    ),
    (types[0] ?? httpBlock).file,
    (types[0] ?? httpBlock).line,
    'types',
    'missing `types { application/manifest+json webmanifest; }` (nginx 1.30 mime.types has none)',
  );
}

const forbiddenInLog = (name) =>
  LOG_FORBIDDEN_VARIABLES.has(name) || LOG_FORBIDDEN_PREFIXES.some((p) => name.startsWith(p));

/** (8) The access log is `off` or the private format. */
function checkLogging(ctx, nodes, httpBlock) {
  const httpAccess = children(httpBlock, 'access_log')[0];
  if (
    !check(
      ctx,
      httpAccess !== undefined,
      httpBlock.file,
      httpBlock.line,
      'access_log',
      'missing the http-level access_log',
    )
  ) {
    return;
  }
  let formatName;
  if (httpAccess.args[0] !== 'off') {
    formatName = httpAccess.args[1];
    check(
      ctx,
      formatName !== undefined,
      httpAccess.file,
      httpAccess.line,
      'access_log',
      'no format named: "combined" logs the request line, referer, user agent and client address',
    );
  }
  if (formatName !== undefined) {
    const format = children(httpBlock, 'log_format').find((f) => f.args[0] === formatName);
    if (
      check(
        ctx,
        format !== undefined,
        httpAccess.file,
        httpAccess.line,
        'access_log',
        `log_format ${formatName} is not defined at http level`,
      )
    ) {
      const body = format.args
        .slice(1)
        .filter((a) => !a.startsWith('escape='))
        .join('');
      const names = variableNames(body);
      check(
        ctx,
        names.length > 0,
        format.file,
        format.line,
        `log_format ${formatName}`,
        'the format references no variable',
      );
      for (const name of names) {
        check(
          ctx,
          !forbiddenInLog(name),
          format.file,
          format.line,
          `log_format ${formatName}`,
          `$${name} logs the request line, query string, referer, user agent or client address (brief l.275)`,
        );
      }
    }
  }
  for (const [node] of collect(nodes, (n) => n.name === 'access_log')) {
    check(
      ctx,
      node.args[0] === 'off' || (formatName !== undefined && node.args[1] === formatName),
      node.file,
      node.line,
      'access_log',
      `must be \`off\` or use the ${formatName ?? 'private'} format`,
    );
  }
}

function analyseRendering(ctx, files, mode, origin) {
  const vars = { SKY_GEOCODER_ORIGIN: origin, SKY_WEB_MODE: mode };
  const rendered = new Map();
  for (const [rel, text] of files) {
    if (!rel.startsWith('nginx/templates/')) continue;
    const name = path.basename(rel, '.template');
    check(
      ctx,
      name.endsWith('.conf'),
      rel,
      1,
      'template',
      `renders to ${name}, which ${CONF_D_GLOB} never includes`,
    );
    rendered.set(name, { rel, text: renderTemplate(ctx, rel, text, vars) });
  }
  const nodes = parseTree(ctx, files, rendered, MAIN, files.get(MAIN), 0);
  // (10) Every remaining variable is one nginx defines or one of our two maps.
  ctx.checks += 1;
  walk(nodes, (node) => {
    for (const arg of node.args) {
      for (const name of variableNames(arg)) {
        if (!VARIABLE_ALLOW_LIST.has(name)) {
          finding(
            ctx,
            node.file,
            node.line,
            node.name,
            `variable $${name} is not in the allow-list`,
          );
        }
      }
    }
  });
  const httpBlocks = nodes.filter((n) => n.name === 'http');
  if (
    !check(
      ctx,
      httpBlocks.length === 1,
      MAIN,
      1,
      'http',
      `expected one http block, found ${httpBlocks.length}`,
    )
  ) {
    return;
  }
  const [httpBlock] = httpBlocks;
  checkHeaders(ctx, nodes, httpBlock, origin);
  checkMaps(ctx, httpBlock);
  const serving = checkServers(ctx, httpBlock, mode);
  if (serving !== undefined) checkApp(ctx, serving, mode);
  checkHttpSettings(ctx, nodes, httpBlock);
  checkLogging(ctx, nodes, httpBlock);
}

// ---------------------------------------------------------------------------------------------
// (11) The web image's ENV defaults.

/** Dockerfile instructions with continuations joined and comment lines skipped. */
function dockerInstructions(text) {
  const out = [];
  let buffer = null;
  let startLine = 0;
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    if (buffer === null) {
      if (line.trim() === '' || line.trim().startsWith('#')) return;
      buffer = '';
      startLine = index + 1;
    } else if (line.trim().startsWith('#')) {
      return;
    }
    const continues = /\\\s*$/.test(line);
    buffer += continues ? `${line.replace(/\\\s*$/, '')} ` : line;
    if (!continues) {
      out.push({ text: buffer.trim(), line: startLine });
      buffer = null;
    }
  });
  if (buffer !== null) out.push({ text: buffer.trim(), line: startLine });
  return out;
}

/** The words of an ENV instruction: whitespace-separated, quoted (" or '), backslash escapes. */
function dockerWords(text) {
  const words = [];
  let current = '';
  let inWord = false;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      current += text[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

/** `[key, value]` pairs of `ENV k=v k2=v2` or the legacy `ENV k v...`. */
function parseEnv(rest) {
  const words = dockerWords(rest);
  if (words.length > 0 && !words[0].includes('=')) return [[words[0], words.slice(1).join(' ')]];
  return words.map((word) => {
    const eq = word.indexOf('=');
    return [word.slice(0, eq), word.slice(eq + 1)];
  });
}

function checkDockerfile(ctx, files) {
  const text = files.get('Dockerfile');
  if (
    !check(
      ctx,
      text !== undefined,
      'Dockerfile',
      1,
      'ENV',
      'missing (the ENV defaults of the web image are part of the contract)',
    )
  ) {
    return;
  }
  const instructions = dockerInstructions(text);
  const lastFrom = instructions.reduce((acc, ins, i) => (/^FROM\b/i.test(ins.text) ? i : acc), -1);
  const env = new Map();
  for (const instruction of instructions.slice(lastFrom + 1)) {
    const match = /^ENV\s+([\s\S]*)$/i.exec(instruction.text);
    if (match === null) continue;
    for (const [key, value] of parseEnv(match[1])) env.set(key, { value, line: instruction.line });
  }
  const fromLine = instructions[lastFrom]?.line ?? 1;
  for (const [key, want] of [
    ['SKY_GEOCODER_ORIGIN', CSP_GEOCODER_ORIGIN_DEFAULT],
    ['SKY_WEB_MODE', 'http'],
    ['NGINX_ENVSUBST_FILTER', '^SKY_'],
  ]) {
    const got = env.get(key);
    check(
      ctx,
      got !== undefined && got.value === want,
      'Dockerfile',
      got?.line ?? fromLine,
      'ENV',
      got === undefined
        ? `${key} is not set in the final stage (expected ${want})`
        : `${key}=${got.value}, expected ${want}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The suite over a tree, and the self-test.

function analyse(files, root, origins) {
  const ctx = createContext(root);
  for (const mode of MODES) {
    for (const origin of origins) analyseRendering(ctx, files, mode, origin);
  }
  checkDockerfile(ctx, files);
  return { checks: ctx.checks, findings: [...ctx.findings] };
}

/**
 * Applies each mutation to a copy of the tree and requires a finding the unmutated tree lacks.
 * Its own findings keep the `file:line directive: message` shape: the mutation's file, the line
 * its text starts at (the line after the existing content for an append, 1 when the text is
 * absent) and the directive `self-test`.
 */
function selfTest(files, root, origins, baseFindings) {
  const base = new Set(baseFindings);
  const ctx = createContext(root);
  MUTATIONS.forEach((mutation, index) => {
    const what = `mutation ${index + 1} (${mutation.what})`;
    const copy = new Map(files);
    const text = copy.get(mutation.file);
    if (text === undefined) {
      finding(ctx, mutation.file, 1, 'self-test', `${what} did not apply: the file is missing`);
      return;
    }
    const at = mutation.from === null ? text.length : text.indexOf(mutation.from);
    if (at === -1) {
      finding(
        ctx,
        mutation.file,
        1,
        'self-test',
        `${what} did not apply: ${JSON.stringify(mutation.from)} not found`,
      );
      return;
    }
    copy.set(
      mutation.file,
      mutation.from === null ? text + mutation.to : text.replace(mutation.from, () => mutation.to),
    );
    const { findings } = analyse(copy, root, origins);
    if (!findings.some((f) => !base.has(f))) {
      finding(ctx, mutation.file, lineAt(text, at), 'self-test', `${what} not caught`);
    }
  });
  return { failures: [...ctx.findings], total: MUTATIONS.length };
}

function main() {
  const args = parseCommandLine();
  const root = path.resolve(args.root ?? path.join(import.meta.dirname, '..', 'frontend'));
  if (!existsSync(path.join(root, MAIN))) usageError(`--root ${root} holds no ${MAIN}`);
  const origins = [CSP_GEOCODER_ORIGIN_DEFAULT, SECOND_ORIGIN];
  if (args.origin !== undefined) {
    let origin;
    try {
      origin = geocoderOriginFromEnv({ SKY_GEOCODER_ORIGIN: args.origin });
    } catch (error) {
      usageError(`--origin: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  const files = loadTree(root);
  const { checks, findings } = analyse(files, root, origins);
  let selfTestSummary = 'self-test skipped (--no-self-test)';
  if (!args['no-self-test']) {
    const { failures, total } = selfTest(files, root, origins, findings);
    findings.push(...failures);
    selfTestSummary = `self-test ${total - failures.length}/${total} mutations caught`;
  }
  for (const line of findings) console.error(line);
  console.log(
    `nginx headers: ${MODES.length} modes x ${origins.length} origins, ${checks} checks, ${findings.length} findings; ${selfTestSummary}`,
  );
  if (findings.length > 0) process.exit(1);
}

main();
