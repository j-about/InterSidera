#!/usr/bin/env node
// Container image gate (make images, the CI `docker` job; docs/architecture.md "Deployment",
// docs/testing.md "Delivery (M7)"; brief l.270, l.274, l.299, l.489). Docker is invoked with
// argument arrays only (execFileSync, and spawn for the two tar streams), never a shell string;
// every HTTP probe goes through node:http (the slim images have no curl and the gate must not
// depend on one). Checks, in order:
//   (a) the store line (`docker info`: storage driver and server version);
//   (b) `docker image inspect` per image: linux, the architecture, a non-root `Config.User` on the
//       api, the HEALTHCHECK present with the documented timings, the OCI labels, the exposed ports,
//       the api's exec-form CMD without an ENTRYPOINT (so `docker compose run --rm api sky-data ...`
//       replaces it);
//   (c) the size gate of brief l.299 (decimal MB: API_BUDGET_BYTES and WEB_BUDGET_BYTES): the figure
//       of record is the store-independent unpacked size, measured as the payload of
//       `docker export` on a created container (the sum of the regular-file `size` fields of the
//       tar stream: 12 octal bytes at offset 124 of each 512-byte header, data rounded up to whole
//       blocks, GNU `L`/`K` and pax `x`/`g` headers skipped with their data, two zero blocks end
//       the stream); printed beside it and never gated: `docker image inspect .Size` (the
//       compressed content on a containerd store), the containerd `Unpacked` and `Content` figures
//       from the Docker API (`GET /images/<ref>/json?manifests=true` over the unix socket, at the
//       daemon's own API version), and the compressed size (`docker save` piped through gzip -9);
//       `--api-reading compressed` gates the api on the compressed figure instead (only ever with
//       backlog row B-111 cited beside the flag);
//   (d) `docker run --rm <web> nginx -t` in http mode and in tls mode with a throwaway EC pair
//       (openssl, one day): the image entrypoint renders the templates first, so a leftover
//       `${SKY_*}` placeholder or a bad server block fails here;
//   (e) the web runtime on 127.0.0.1:<web-port>, the container started as compose starts `web`
//       (`--read-only`, the three tmpfs mounts at mode 0755, every capability dropped but CHOWN,
//       SETGID, SETUID, NET_BIND_SERVICE and KILL, `no-new-privileges`): `/`, `/nowhere` (the SPA
//       fallback, also with a query string), `/index.html`, `/manifest.webmanifest`,
//       `/favicon.svg`, the entry script and stylesheet of index.html, `/api/v1/docs` and
//       `/api/v1/docs/` 404, `/.vite/manifest.json` 404, `/healthz` 204: the seven headers
//       byte-equal to `securityHeaders({ geocoderOrigin })` on every response (404s included), the
//       Cache-Control classes, `Server: nginx`, no HSTS on plain HTTP, `Content-Encoding: gzip` +
//       `Vary: Accept-Encoding` under `Accept-Encoding: gzip` on the HTML, the script, the
//       stylesheet and the manifest, an `ETag` on the document; the access log (the container's
//       stdout; brief l.275): the line of the query-string request carries `"path":"/index.html"`,
//       every request but `/healthz` leaves exactly one line and no line holds `lat=`, `lon=`, a
//       `?` or an IPv4 address; then `docker exec <c> nginx -s reload` (the certificate-rotation
//       step): exit 0, every worker replaced (`docker top`), `/healthz` still 204 and no `failed`
//       line in the error log (the container's stderr) apart from the resolver's; plus `nginx -T`
//       with `SKY_GEOCODER_ORIGIN=https://geocoder.example.org` naming that origin in
//       `connect-src`. Nothing under a proxied `/api/` path is requested: outside compose no
//       embedded DNS answers the upstream's resolver at 127.0.0.11, so its `recv() failed ...
//       while resolving` lines are expected there (the exact-match docs 404s never reach it);
//   (f) the api without data on 127.0.0.1:<api-port> (`SKYAPI_AUTO_FETCH=false`,
//       `SKYAPI_EPHEMERIS=de440s.bsp`, `--read-only` with tmpfs /tmp and /data mounts as compose
//       runs it, /data writable by uid 1000): `/api/v1/health` 503,
//       `Retry-After: 5`, `Cache-Control: no-store`, `nosniff`, the API's own policy, body
//       `status: starting` with the remedy in `detail`;
//   (g) the HEALTHCHECK command turns that 503 into `unhealthy`: the container runs the image's
//       test with shortened timings (`--health-start-period 1s --health-interval 2s
//       --health-retries 1`), so the run proves the probe's verdict without the production
//       start period (the timings themselves are asserted in (b)); the last entry of the health
//       log must carry `ExitCode` 1 and urllib's `HTTP Error 503` in its output, because a probe
//       that cannot run (126, 127, a usage error 2) or that fails before it reaches the API (1
//       without that line) also yields `unhealthy`;
//   (h) `id -u` inside the api container is 1000;
//   (i) the runtime imports (`skyapi.main`, `skyapi.cli.sky_data`, pandas, numpy, the pyarrow
//       parquet, dataset and fs modules, `skyfield.api`) and `sky-data status` exit 0, so the
//       size trims of the Dockerfile removed nothing the API loads;
//   (j) `python -c "import pip"` fails and `uv` is absent from the final image.
// `--static` stops after (c). Containers are named isd-check-<pid>-* and removed in `finally` and
// on SIGINT/SIGTERM, the temporary directories (the throwaway certificate pair, the stderr half of
// `docker logs`) with them. Exit 0 when every check passed,
// 1 with one finding per line on stderr, 2 on a usage error. `--self-test` builds two small tars
// with GNU tar (gnu and pax formats: a long file name, an empty file, a directory, a symlink and a
// hard link) and asserts the parsed payload equals the sum of the file sizes in four chunkings.
// Usage: node scripts/check_images.mjs --api <ref> --web <ref> [--static] [--api-port 18000]
//          [--web-port 18080] [--geocoder-origin <origin>] [--api-reading unpacked|compressed]
//        node scripts/check_images.mjs --self-test
// No dependencies; Node 24 built-ins plus ../frontend/security-headers.ts through type stripping.
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';
import { CSP_GEOCODER_ORIGIN_DEFAULT, securityHeaders } from '../frontend/security-headers.ts';

/** brief l.299: `api` < 400 MB, `web` < 50 MB, decimal megabytes. */
const API_BUDGET_BYTES = 400_000_000;
const WEB_BUDGET_BYTES = 50_000_000;

/** The HEALTHCHECK timings of both Dockerfiles, in nanoseconds as `docker image inspect` reports them. */
const SECOND_NS = 1_000_000_000;
const API_HEALTHCHECK = {
  Interval: 30 * SECOND_NS,
  Timeout: 5 * SECOND_NS,
  StartPeriod: 300 * SECOND_NS,
  StartInterval: 5 * SECOND_NS,
  Retries: 3,
};
const WEB_HEALTHCHECK = {
  Interval: 30 * SECOND_NS,
  Timeout: 3 * SECOND_NS,
  StartPeriod: 10 * SECOND_NS,
  StartInterval: 2 * SECOND_NS,
  Retries: 3,
};
/** The exec-form CMD of the api image; compose appends `--workers`. */
const API_CMD = ['fastapi', 'run', '--host', '0.0.0.0', '--port', '8000'];
/** The API's own policy (backend `middleware/headers.py`), the second policy on `/api` behind nginx. */
const API_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
/** The bootstrap's remedy for a missing required file without auto-fetch (backend `bootstrap.py`). */
const API_MISSING_DETAIL =
  'de440s.bsp is missing from DATA_DIR and SKYAPI_AUTO_FETCH is false: run `sky-data fetch`';
/** What the HEALTHCHECK command prints when the API answers 503: urllib's uncaught HTTPError. */
const HEALTH_PROBE_503 = 'HTTP Error 503';
/** The origin `nginx -T` must render into `connect-src` when the environment names one. */
const RENDER_TEST_ORIGIN = 'https://geocoder.example.org';
/** How long a container may take to answer its first probe. */
const START_TIMEOUT_MS = 90_000;
/** How long the shortened healthcheck of (g) may take to reach `unhealthy`. */
const UNHEALTHY_TIMEOUT_MS = 60_000;
/** How long an access line may take to reach `docker logs` after its response. */
const LOG_TIMEOUT_MS = 10_000;
/** How long nginx may take to replace its workers after `nginx -s reload`. */
const RELOAD_TIMEOUT_MS = 30_000;
/**
 * The web container as compose.yaml runs `web`: a read-only root, the three tmpfs mounts at mode
 * 0755 (Docker's default 1777 would let the uid-101 workers write the configuration directory
 * the root master re-reads on a reload), every capability dropped but the five of the root
 * master, no-new-privileges.
 */
const WEB_HARDENING = [
  '--read-only',
  '--tmpfs',
  '/etc/nginx/conf.d:size=1m,mode=0755',
  '--tmpfs',
  '/var/cache/nginx:size=256m,mode=0755',
  '--tmpfs',
  '/run:size=1m,mode=0755',
  '--cap-drop',
  'ALL',
  '--cap-add',
  'CHOWN',
  '--cap-add',
  'SETGID',
  '--cap-add',
  'SETUID',
  '--cap-add',
  'NET_BIND_SERVICE',
  '--cap-add',
  'KILL',
  '--security-opt',
  'no-new-privileges=true',
];
/** What an access line must never hold (brief l.275): a query string, a coordinate, an address. */
const ACCESS_LEAK_RE = /\?|lat=|lon=|\b\d{1,3}(?:\.\d{1,3}){3}\b/;
/** The error-log line of the upstream's resolver, expected outside compose (no embedded DNS). */
const RESOLVER_NOISE_RE = /while resolving, resolver: /;
const POLL_MS = 500;
const TAR_BLOCK = 512;
/** The tar type flags whose data is file payload (`\0` is the pre-POSIX regular file, `7` contiguous). */
const PAYLOAD_TYPES = new Set(['0', '\0', '7']);

const USAGE =
  'usage: node scripts/check_images.mjs --api <ref> --web <ref> [--static] [--api-port 18000] [--web-port 18080] [--geocoder-origin <origin>] [--api-reading unpacked|compressed] | --self-test';

function usageError(message) {
  console.error(`check_images: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseCommandLine() {
  let values;
  try {
    values = parseArgs({
      options: {
        api: { type: 'string' },
        web: { type: 'string' },
        static: { type: 'boolean', default: false },
        'api-port': { type: 'string', default: '18000' },
        'web-port': { type: 'string', default: '18080' },
        'geocoder-origin': { type: 'string', default: CSP_GEOCODER_ORIGIN_DEFAULT },
        'api-reading': { type: 'string', default: 'unpacked' },
        'self-test': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (values['self-test']) {
    return { selfTest: true };
  }
  if (!values.api || !values.web) usageError('both --api and --web are required');
  const apiPort = Number(values['api-port']);
  const webPort = Number(values['web-port']);
  for (const [name, port] of [
    ['--api-port', apiPort],
    ['--web-port', webPort],
  ]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) usageError(`${name} must be a port`);
  }
  if (!['unpacked', 'compressed'].includes(values['api-reading'])) {
    usageError('--api-reading must be unpacked or compressed');
  }
  let geocoderOrigin;
  try {
    geocoderOrigin = new URL(values['geocoder-origin']).origin;
  } catch {
    usageError(`--geocoder-origin ${JSON.stringify(values['geocoder-origin'])} is not a URL`);
  }
  if (geocoderOrigin !== values['geocoder-origin']) {
    usageError(`--geocoder-origin must be an origin (no path, slash or query): ${geocoderOrigin}`);
  }
  return {
    selfTest: false,
    api: values.api,
    web: values.web,
    static: values.static,
    apiPort,
    webPort,
    geocoderOrigin,
    apiReading: values['api-reading'],
  };
}

// --- tar payload parser (pure; proven by --self-test) --------------------------------------------

/**
 * The `size` field of a tar header: 12 octal bytes at offset 124, or GNU base-256 when the high bit
 * of the first byte is set. Only that header field is read: a pax `size` record (an entry above
 * 8 GiB in the pax format) is not honoured, which no image under a 400 MB budget can reach.
 */
function tarEntrySize(header) {
  const field = header.subarray(124, 136);
  if (field[0] & 0x80) {
    let value = field[0] & 0x7f;
    for (let i = 1; i < field.length; i += 1) value = value * 256 + field[i];
    return value;
  }
  const text = field
    .toString('latin1')
    .replace(/\0[\s\S]*$/, '')
    .trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar: malformed size field ${JSON.stringify(text)}`);
  return Number.parseInt(text, 8);
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i += 1) if (block[i] !== 0) return false;
  return true;
}

/**
 * An incremental counter over a tar stream fed in arbitrary chunks: `push(chunk)` consumes what it
 * can, `finish()` returns `{ payload, entries }` (the regular-file bytes and their count) or throws
 * on a truncated stream. Every entry's data (long-name and pax headers included) is skipped in whole
 * 512-byte blocks; two consecutive zero blocks end the archive and anything after them is ignored.
 */
function createTarPayloadCounter() {
  let pending = Buffer.alloc(0);
  let skip = 0;
  let zeroBlocks = 0;
  let ended = false;
  let payload = 0;
  let entries = 0;
  return {
    push(chunk) {
      if (ended) return;
      const buf = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let offset = 0;
      for (;;) {
        if (skip > 0) {
          const take = Math.min(skip, buf.length - offset);
          skip -= take;
          offset += take;
          if (skip > 0) break;
        }
        if (buf.length - offset < TAR_BLOCK) break;
        const header = buf.subarray(offset, offset + TAR_BLOCK);
        offset += TAR_BLOCK;
        if (isZeroBlock(header)) {
          zeroBlocks += 1;
          if (zeroBlocks === 2) {
            ended = true;
            break;
          }
          continue;
        }
        zeroBlocks = 0;
        const size = tarEntrySize(header);
        if (PAYLOAD_TYPES.has(String.fromCharCode(header[156]))) {
          payload += size;
          entries += 1;
        }
        skip = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
      }
      pending = ended ? Buffer.alloc(0) : Buffer.from(buf.subarray(offset));
    },
    finish() {
      if (!ended && (pending.length !== 0 || skip !== 0)) throw new Error('tar: truncated stream');
      return { payload, entries };
    },
  };
}

/** The payload of a whole tar held in memory (the self-test's form of the counter). */
function tarPayloadBytes(buffer) {
  const counter = createTarPayloadCounter();
  counter.push(buffer);
  return counter.finish();
}

/** The same tar fed in `chunkSize` pieces, so a header or a size field split across chunks is exercised. */
function tarPayloadBytesChunked(buffer, chunkSize) {
  const counter = createTarPayloadCounter();
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    counter.push(buffer.subarray(offset, Math.min(buffer.length, offset + chunkSize)));
  }
  return counter.finish();
}

function selfTest() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'isd-check-selftest-'));
  try {
    const src = path.join(dir, 'src');
    mkdirSync(path.join(src, 'nested', 'deeper'), { recursive: true });
    const longName = `${'n'.repeat(120)}.bin`;
    const files = [
      ['a.bin', 1],
      ['b.bin', 511],
      ['c.bin', 512],
      ['d.bin', 513],
      ['empty', 0],
      [path.join('nested', 'deeper', longName), 70_000],
      ['x'.repeat(150), 1234],
    ];
    let expected = 0;
    for (const [name, size] of files) {
      writeFileSync(path.join(src, name), Buffer.alloc(size, 0x5a));
      expected += size;
    }
    // Neither a symlink nor a hard link carries payload (types 2 and 1, size 0).
    symlinkSync('a.bin', path.join(src, 'link-to-a'));
    linkSync(path.join(src, 'b.bin'), path.join(src, 'hard-to-b'));
    const failures = [];
    const chunkings = [];
    for (const format of ['gnu', 'pax']) {
      const tarFile = path.join(dir, `${format}.tar`);
      execFileSync('tar', ['--format', format, '-cf', tarFile, '-C', src, '.'], { stdio: 'pipe' });
      const buffer = readFileSync(tarFile);
      const results = [
        ['whole', tarPayloadBytes(buffer)],
        ['1000 B chunks', tarPayloadBytesChunked(buffer, 1000)],
        ['512 B chunks', tarPayloadBytesChunked(buffer, 512)],
        ['1 B chunks', tarPayloadBytesChunked(buffer, 1)],
      ];
      for (const [chunking, result] of results) {
        chunkings.push(`${format}/${chunking}`);
        if (result.payload !== expected || result.entries !== files.length) {
          failures.push(
            `${format} tar, ${chunking}: payload ${String(result.payload)} B in ${String(result.entries)} entries, expected ${String(expected)} B in ${String(files.length)}`,
          );
        }
      }
    }
    if (failures.length > 0) {
      for (const line of failures) console.error(`  ${line}`);
      console.error(`check_images self-test: ${String(failures.length)} failure(s)`);
      process.exit(1);
    }
    console.log(
      `check_images self-test: gnu and pax tars, ${String(files.length)} regular files, payload ${String(expected)} B in ${String(chunkings.length)} chunkings, ok`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- process helpers -----------------------------------------------------------------------------

/** Run docker with an argument array and return its trimmed stdout; a non-zero exit throws. */
function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trimEnd();
}

/** Run docker and return `{ status, stdout, stderr }` whatever the exit code. */
function dockerResult(args) {
  try {
    const stdout = docker(args);
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    if (error.status === undefined || error.status === null) throw error;
    return {
      status: error.status,
      stdout: String(error.stdout ?? '').trimEnd(),
      stderr: String(error.stderr ?? '').trimEnd(),
    };
  }
}

const nonEmptyLines = (text) => text.split('\n').filter((line) => line.trim() !== '');

/** The container's stdout as lines: the nginx image links its access log there. */
function accessLogLines(container) {
  return nonEmptyLines(docker(['logs', container]));
}

/**
 * The container's stderr as lines: the nginx image links its error log there. execFileSync
 * returns stdout only, so `docker logs` writes its stderr to a file in a private temporary
 * directory.
 */
function errorLogLines(container) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'isd-check-logs-'));
  tempDirs.add(dir);
  try {
    const file = path.join(dir, 'stderr.log');
    const fd = openSync(file, 'w');
    try {
      docker(['logs', container], { stdio: ['ignore', 'pipe', fd] });
    } finally {
      closeSync(fd);
    }
    return nonEmptyLines(readFileSync(file, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }
}

/** The PIDs of the container's nginx workers, from `docker top` (the daemon's `ps -ef` table). */
function nginxWorkerPids(container) {
  const [header = '', ...rows] = nonEmptyLines(docker(['top', container]));
  const pidColumn = header.trim().split(/\s+/).indexOf('PID');
  if (pidColumn < 0) throw new Error(`docker top ${container}: no PID column in "${header}"`);
  return rows
    .filter((row) => row.includes('nginx: worker process'))
    .map((row) => row.trim().split(/\s+/)[pidColumn]);
}

/** Spawn `file args` and hand every stdout chunk to `onChunk`; resolves once the process exited 0. */
function streamCommand(file, args, onChunk) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let failed = null;
    child.stdout.on('data', (chunk) => {
      if (failed !== null) return;
      try {
        onChunk(chunk);
      } catch (error) {
        failed = error;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (failed !== null) reject(failed);
      else if (code === 0) resolve();
      else reject(new Error(`${file} ${args.join(' ')} exited ${String(code)}: ${stderr.trim()}`));
    });
  });
}

/** The payload of `docker export <container>` without holding the tar in memory. */
async function exportPayloadBytes(container) {
  const counter = createTarPayloadCounter();
  await streamCommand('docker', ['export', container], (chunk) => counter.push(chunk));
  return counter.finish();
}

/** `docker save <ref> | gzip -9 | wc -c`, streamed through zlib. */
function compressedSizeBytes(ref) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['save', ref], { stdio: ['ignore', 'pipe', 'pipe'] });
    const gzip = createGzip({ level: 9 });
    let bytes = 0;
    let stderr = '';
    let gzipEnded = false;
    let exitCode = null;
    const settle = () => {
      if (!gzipEnded || exitCode === null) return;
      if (exitCode === 0) resolve(bytes);
      else reject(new Error(`docker save ${ref} exited ${String(exitCode)}: ${stderr.trim()}`));
    };
    gzip.on('data', (chunk) => {
      bytes += chunk.length;
    });
    gzip.on('end', () => {
      gzipEnded = true;
      settle();
    });
    gzip.on('error', reject);
    child.stdout.pipe(gzip);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      exitCode = code ?? 1;
      settle();
    });
  });
}

/** One GET on the Docker unix socket (DOCKER_HOST=unix://... honoured); `{ status: 0 }` when unreachable. */
function dockerApi(pathname) {
  const dockerHost = process.env.DOCKER_HOST ?? '';
  const socketPath = dockerHost.startsWith('unix://')
    ? dockerHost.slice('unix://'.length)
    : '/var/run/docker.sock';
  return new Promise((resolve) => {
    const request = http.request(
      { socketPath, path: pathname, method: 'GET', headers: { Host: 'docker' } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ status: 0, body: error.message }));
    request.end();
  });
}

/** The containerd figures of the platform the daemon holds, or nulls (a graphdriver store, an older API). */
async function containerdSizes(ref, architecture) {
  const version = await dockerApi('/version');
  let apiVersion = null;
  try {
    apiVersion = version.status === 200 ? JSON.parse(version.body).ApiVersion : null;
  } catch {
    apiVersion = null;
  }
  if (typeof apiVersion !== 'string') return { unpacked: null, content: null };
  const inspect = await dockerApi(
    `/v${apiVersion}/images/${encodeURIComponent(ref)}/json?manifests=true`,
  );
  if (inspect.status !== 200) return { unpacked: null, content: null };
  let manifests;
  try {
    manifests = JSON.parse(inspect.body).Manifests;
  } catch {
    return { unpacked: null, content: null };
  }
  if (!Array.isArray(manifests)) return { unpacked: null, content: null };
  const own = manifests.find(
    (manifest) =>
      manifest.Available === true &&
      manifest.Kind === 'image' &&
      manifest.ImageData?.Platform?.architecture === architecture,
  );
  if (own === undefined) return { unpacked: null, content: null };
  const unpacked = own.ImageData?.Size?.Unpacked;
  const content = own.Size?.Content;
  return {
    unpacked: typeof unpacked === 'number' ? unpacked : null,
    content: typeof content === 'number' ? content : null,
  };
}

/**
 * One GET on 127.0.0.1:<port>; the body is returned as a Buffer, the header names lower-cased by
 * Node. `agent: false` opens a connection of its own instead of reusing a kept-alive one.
 */
function httpGet(port, pathname, headers = {}, agent = undefined) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers, agent },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.setTimeout(15_000, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `probe` (a promise of a truthy value, or a rejection) until it answers or the timeout passes. */
async function waitFor(label, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${label}: no answer after ${String(timeoutMs / 1000)} s${lastError === null ? '' : ` (${lastError instanceof Error ? lastError.message : String(lastError)})`}`,
      );
    }
    await sleep(POLL_MS);
  }
}

// --- the checks ----------------------------------------------------------------------------------

const findings = [];
let checks = 0;
/** Record a check: a false condition is a finding. */
function check(letter, condition, message) {
  checks += 1;
  if (!condition) findings.push(`(${letter}) ${message}`);
  return condition;
}

const megabytes = (bytes) => (bytes / 1e6).toFixed(1);

/** (b) and (c) for one image. */
async function inspectImage(ref, role, args) {
  const inspected = JSON.parse(docker(['image', 'inspect', '--format', '{{json .}}', ref]));
  const config = inspected.Config ?? {};
  const architecture = String(inspected.Architecture);
  check('b', inspected.Os === 'linux', `${ref}: Os is ${String(inspected.Os)}, expected linux`);
  const user = String(config.User ?? '');
  if (role === 'api') {
    check(
      'b',
      /^[1-9]\d*(:[1-9]\d*)?$/.test(user),
      `${ref}: Config.User is ${JSON.stringify(user)}, expected a non-root uid[:gid]`,
    );
    check(
      'b',
      JSON.stringify(config.Cmd) === JSON.stringify(API_CMD) &&
        (config.Entrypoint === null || config.Entrypoint === undefined),
      `${ref}: Cmd ${JSON.stringify(config.Cmd)} / Entrypoint ${JSON.stringify(config.Entrypoint)}, expected ${JSON.stringify(API_CMD)} and no ENTRYPOINT`,
    );
    check(
      'b',
      '8000/tcp' in (config.ExposedPorts ?? {}),
      `${ref}: ExposedPorts ${JSON.stringify(config.ExposedPorts)} lacks 8000/tcp`,
    );
  } else {
    const ports = config.ExposedPorts ?? {};
    check(
      'b',
      '80/tcp' in ports && '443/tcp' in ports,
      `${ref}: ExposedPorts ${JSON.stringify(config.ExposedPorts)} lacks 80/tcp or 443/tcp`,
    );
  }
  const healthcheck = config.Healthcheck ?? null;
  const test = Array.isArray(healthcheck?.Test) ? healthcheck.Test : [];
  const hasHealthcheck = test.length > 1 && test[0] === 'CMD';
  check('b', hasHealthcheck, `${ref}: no exec-form HEALTHCHECK (Test ${JSON.stringify(test)})`);
  const expectedTimings = role === 'api' ? API_HEALTHCHECK : WEB_HEALTHCHECK;
  for (const [key, expected] of Object.entries(expectedTimings)) {
    check(
      'b',
      healthcheck?.[key] === expected,
      `${ref}: Healthcheck.${key} is ${String(healthcheck?.[key])}, expected ${String(expected)}`,
    );
  }
  const labels = config.Labels ?? {};
  for (const key of [
    'org.opencontainers.image.title',
    'org.opencontainers.image.source',
    'org.opencontainers.image.version',
    'org.opencontainers.image.revision',
  ]) {
    check(
      'b',
      typeof labels[key] === 'string' && labels[key] !== '',
      `${ref}: label ${key} missing`,
    );
  }
  check(
    'b',
    labels['org.opencontainers.image.licenses'] === 'MIT',
    `${ref}: label org.opencontainers.image.licenses is ${JSON.stringify(labels['org.opencontainers.image.licenses'])}, expected MIT`,
  );

  // (c) the export payload on a created (never started) container.
  const container = `isd-check-${String(process.pid)}-export-${role}`;
  containers.add(container);
  docker(['create', '--name', container, ref]);
  let exported;
  try {
    exported = await exportPayloadBytes(container);
  } finally {
    dockerResult(['rm', '-f', container]);
    containers.delete(container);
  }
  const sizes = await containerdSizes(ref, architecture);
  const compressed = await compressedSizeBytes(ref);
  const budget = role === 'api' ? API_BUDGET_BYTES : WEB_BUDGET_BYTES;
  const reading = role === 'api' ? args.apiReading : 'unpacked';
  const gated = reading === 'compressed' ? compressed : exported.payload;
  console.log(
    `image ${ref}: export ${String(exported.payload)} B (${megabytes(exported.payload)} MB of ${megabytes(budget)} MB, ${String(exported.entries)} files); inspect .Size ${String(inspected.Size)} B; unpacked ${sizes.unpacked === null ? 'n/a' : String(sizes.unpacked)} B; content ${sizes.content === null ? 'n/a' : String(sizes.content)} B; compressed ${String(compressed)} B; ${String(inspected.Os)}/${architecture}; user ${user === '' ? 'root' : user}; healthcheck ${hasHealthcheck ? 'yes' : 'no'}${reading === 'compressed' ? '; gated on the compressed figure (backlog B-111)' : ''}`,
  );
  check(
    'c',
    gated < budget,
    `${ref}: ${reading} size ${String(gated)} B is not under the ${megabytes(budget)} MB budget of brief l.299`,
  );
  return { architecture };
}

/** The seven headers of the web tier, compared case-insensitively on the name and byte-equal on the value. */
function checkSecurityHeaders(letter, where, headers, expected) {
  for (const [name, value] of Object.entries(expected)) {
    const got = headers[name.toLowerCase()];
    check(
      letter,
      got === value,
      `${where}: ${name} is ${JSON.stringify(got)}, expected ${JSON.stringify(value)}`,
    );
  }
}

/** (d) `nginx -t` in both modes; (e) the runtime probes and the rendered `connect-src`. */
async function checkWeb(ref, args) {
  // (d) http mode.
  const httpTest = dockerResult(['run', '--rm', ref, 'nginx', '-t']);
  check(
    'd',
    httpTest.status === 0,
    `${ref}: nginx -t (http mode) exited ${String(httpTest.status)}: ${httpTest.stderr}`,
  );
  // (d) tls mode with a throwaway EC pair.
  const certDir = mkdtempSync(path.join(os.tmpdir(), 'isd-check-certs-'));
  tempDirs.add(certDir);
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-noenc',
        '-keyout',
        path.join(certDir, 'privkey.pem'),
        '-out',
        path.join(certDir, 'fullchain.pem'),
        '-subj',
        '/CN=localhost',
        '-days',
        '1',
      ],
      { stdio: 'pipe' },
    );
    chmodSync(certDir, 0o755);
    for (const file of ['privkey.pem', 'fullchain.pem']) chmodSync(path.join(certDir, file), 0o644);
    const tlsTest = dockerResult([
      'run',
      '--rm',
      '-e',
      'SKY_WEB_MODE=tls',
      '-v',
      `${certDir}:/etc/nginx/certs:ro`,
      ref,
      'nginx',
      '-t',
    ]);
    check(
      'd',
      tlsTest.status === 0,
      `${ref}: nginx -t (tls mode) exited ${String(tlsTest.status)}: ${tlsTest.stderr}`,
    );
  } finally {
    rmSync(certDir, { recursive: true, force: true });
    tempDirs.delete(certDir);
  }
  // (e) the rendered connect-src with another origin.
  const rendered = dockerResult([
    'run',
    '--rm',
    '-e',
    `SKY_GEOCODER_ORIGIN=${RENDER_TEST_ORIGIN}`,
    ref,
    'nginx',
    '-T',
  ]);
  check(
    'e',
    rendered.status === 0 && rendered.stdout.includes(`connect-src 'self' ${RENDER_TEST_ORIGIN};`),
    `${ref}: nginx -T with SKY_GEOCODER_ORIGIN=${RENDER_TEST_ORIGIN} does not render it into connect-src (exit ${String(rendered.status)})`,
  );

  // (e) the runtime probes, on a container started as compose.yaml starts `web`.
  const container = `isd-check-${String(process.pid)}-web`;
  containers.add(container);
  docker([
    'run',
    '-d',
    '--name',
    container,
    '-p',
    `127.0.0.1:${String(args.webPort)}:80`,
    '-e',
    `SKY_GEOCODER_ORIGIN=${args.geocoderOrigin}`,
    ...WEB_HARDENING,
    ref,
  ]);
  const expected = securityHeaders({ geocoderOrigin: args.geocoderOrigin });
  try {
    await waitFor(`${ref} on 127.0.0.1:${String(args.webPort)}`, START_TIMEOUT_MS, async () => {
      const response = await httpGet(args.webPort, '/healthz');
      return response.status === 204;
    });
  } catch (error) {
    // A start that fails under the hardening says why in the container's error log.
    const tail = errorLogLines(container).slice(-5).join(' | ');
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; container error log: ${tail === '' ? 'empty' : tail}`,
    );
  }
  // Every request but /healthz (`access_log off`) leaves exactly one access line, so the count of
  // the requests sent tells which line belongs to which request.
  let logged = 0;
  const get = async (pathname, headers) => {
    const response = await httpGet(args.webPort, pathname, headers);
    if (pathname !== '/healthz') logged += 1;
    return response;
  };
  /** The access lines once `count` of them arrived, or what arrived within the wait. */
  const accessLines = async (count) => {
    try {
      return await waitFor(`${ref} access log`, LOG_TIMEOUT_MS, () => {
        const lines = accessLogLines(container);
        return lines.length >= count ? lines : null;
      });
    } catch {
      return accessLogLines(container);
    }
  };
  const index = await get('/');
  const html = index.body.toString('utf8');
  const entryJs = /<script[^>]*\ssrc="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? null;
  const entryCss =
    /<link[^>]*rel="stylesheet"[^>]*\shref="(\/assets\/[^"]+\.css)"/.exec(html)?.[1] ?? null;
  check('e', entryJs !== null, `${ref}: index.html names no /assets/*.js module script`);
  check('e', entryCss !== null, `${ref}: index.html names no /assets/*.css stylesheet`);
  check('e', typeof index.headers.etag === 'string', `${ref}: GET / carries no ETag`);
  const probes = [
    { path: '/', status: 200, type: /^text\/html/, cache: 'no-cache', gzip: true },
    { path: '/nowhere', status: 200, type: /^text\/html/, cache: 'no-cache' },
    { path: '/nowhere?lat=48.86&lon=2.35', status: 200, type: /^text\/html/, cache: 'no-cache' },
    { path: '/index.html', status: 200, type: /^text\/html/, cache: 'no-cache' },
    {
      path: '/manifest.webmanifest',
      status: 200,
      type: /^application\/manifest\+json/,
      cache: 'public, max-age=3600',
      gzip: true,
    },
    { path: '/favicon.svg', status: 200, type: /^image\/svg\+xml/, cache: 'public, max-age=3600' },
    { path: '/api/v1/docs', status: 404, cache: null },
    { path: '/api/v1/docs/', status: 404, cache: null },
    { path: '/.vite/manifest.json', status: 404, cache: null },
    { path: '/healthz', status: 204, cache: null },
  ];
  if (entryJs !== null) {
    probes.push({
      path: entryJs,
      status: 200,
      type: /javascript/,
      cache: 'public, max-age=31536000, immutable',
      gzip: true,
    });
  }
  if (entryCss !== null) {
    probes.push({
      path: entryCss,
      status: 200,
      type: /^text\/css/,
      cache: 'public, max-age=31536000, immutable',
      gzip: true,
    });
  }
  const indexLength = index.body.length;
  for (const probe of probes) {
    const where = `${ref} GET ${probe.path}`;
    const hasQuery = probe.path.includes('?');
    // The lines of the earlier requests first, so that the next line is this request's.
    if (hasQuery) await accessLines(logged);
    const plain = await get(probe.path);
    check(
      'e',
      plain.status === probe.status,
      `${where}: status ${String(plain.status)}, expected ${String(probe.status)}`,
    );
    if (probe.type !== undefined) {
      check(
        'e',
        probe.type.test(String(plain.headers['content-type'] ?? '')),
        `${where}: Content-Type ${JSON.stringify(plain.headers['content-type'])} does not match ${String(probe.type)}`,
      );
    }
    check(
      'e',
      (plain.headers['cache-control'] ?? null) === probe.cache,
      `${where}: Cache-Control ${JSON.stringify(plain.headers['cache-control'])}, expected ${JSON.stringify(probe.cache)}`,
    );
    check(
      'e',
      plain.headers.server === 'nginx',
      `${where}: Server ${JSON.stringify(plain.headers.server)}, expected nginx`,
    );
    check(
      'e',
      plain.headers['strict-transport-security'] === undefined,
      `${where}: HSTS sent on plain HTTP`,
    );
    check(
      'e',
      plain.headers['content-encoding'] === undefined,
      `${where}: Content-Encoding ${JSON.stringify(plain.headers['content-encoding'])} without Accept-Encoding`,
    );
    checkSecurityHeaders('e', where, plain.headers, expected);
    if (probe.path.startsWith('/nowhere')) {
      check(
        'e',
        plain.body.length === indexLength,
        `${where}: body ${String(plain.body.length)} B differs from index.html (${String(indexLength)} B)`,
      );
    }
    if (hasQuery) {
      // brief l.275: the access line of a request with a query string records its path only.
      const lines = await accessLines(logged);
      let record = null;
      try {
        record = JSON.parse(lines.length === logged ? lines[logged - 1] : '');
      } catch {
        record = null;
      }
      check(
        'e',
        record?.path === '/index.html' && record.status === 200 && record.method === 'GET',
        `${where}: ${String(lines.length)} access lines for ${String(logged)} requests, the last one ${JSON.stringify(lines.at(-1) ?? null)}, expected this request's line with "path":"/index.html" and status 200`,
      );
    }
    if (probe.gzip) {
      const gzipped = await get(probe.path, { 'Accept-Encoding': 'gzip' });
      const gzipWhere = `${where} (Accept-Encoding: gzip)`;
      check('e', gzipped.status === probe.status, `${gzipWhere}: status ${String(gzipped.status)}`);
      check(
        'e',
        gzipped.headers['content-encoding'] === 'gzip',
        `${gzipWhere}: Content-Encoding ${JSON.stringify(gzipped.headers['content-encoding'])}, expected gzip (a missing .gz sibling in the image)`,
      );
      check(
        'e',
        String(gzipped.headers.vary ?? '')
          .toLowerCase()
          .split(/\s*,\s*/)
          .includes('accept-encoding'),
        `${gzipWhere}: Vary ${JSON.stringify(gzipped.headers.vary)} lacks Accept-Encoding`,
      );
      checkSecurityHeaders('e', gzipWhere, gzipped.headers, expected);
    }
  }
  // (e) the certificate-rotation step under the hardening: `nginx -s reload` makes the root
  // master re-read conf.d from its tmpfs and replace every uid-101 worker.
  const workersBefore = nginxWorkerPids(container);
  const reload = dockerResult(['exec', container, 'nginx', '-s', 'reload']);
  check(
    'e',
    reload.status === 0,
    `${ref}: nginx -s reload exited ${String(reload.status)}: ${reload.stderr}`,
  );
  let replaced = false;
  try {
    replaced = await waitFor(`${ref} workers after the reload`, RELOAD_TIMEOUT_MS, () => {
      const workers = nginxWorkerPids(container);
      return workers.length > 0 && !workers.some((pid) => workersBefore.includes(pid));
    });
  } catch {
    replaced = false;
  }
  check(
    'e',
    workersBefore.length > 0 && replaced,
    `${ref}: the ${String(workersBefore.length)} workers (${workersBefore.join(' ')}) were not all replaced within ${String(RELOAD_TIMEOUT_MS / 1000)} s of nginx -s reload`,
  );
  // A connection of its own: the kept-alive one went with the worker that held it.
  let afterReload = 0;
  try {
    afterReload = (await httpGet(args.webPort, '/healthz', {}, false)).status;
  } catch {
    afterReload = 0;
  }
  check(
    'e',
    afterReload === 204,
    `${ref}: /healthz answered ${afterReload === 0 ? 'nothing' : String(afterReload)} after nginx -s reload, expected 204`,
  );
  // (e) the logs of the whole run: the access log (stdout), then the error log (stderr).
  const lines = await accessLines(logged);
  check(
    'e',
    lines.length === logged,
    `${ref}: ${String(lines.length)} access lines for ${String(logged)} requests outside /healthz, expected one each`,
  );
  const leaks = lines.filter((line) => ACCESS_LEAK_RE.test(line));
  check(
    'e',
    leaks.length === 0,
    `${ref}: ${String(leaks.length)} access line(s) hold a query string, a coordinate or an address (brief l.275), the first: ${leaks[0] ?? ''}`,
  );
  const failures = errorLogLines(container).filter(
    (line) => line.includes('failed') && !RESOLVER_NOISE_RE.test(line),
  );
  check(
    'e',
    failures.length === 0,
    `${ref}: ${String(failures.length)} \`failed\` line(s) in the error log after nginx -s reload, the first: ${failures[0] ?? ''}`,
  );
  dockerResult(['rm', '-f', container]);
  containers.delete(container);
}

/** (f) to (j) on the api image without data, on a read-only root as compose runs it. */
async function checkApi(ref, args) {
  const container = `isd-check-${String(process.pid)}-api`;
  containers.add(container);
  docker([
    'run',
    '-d',
    '--name',
    container,
    '-p',
    `127.0.0.1:${String(args.apiPort)}:8000`,
    '-e',
    'SKYAPI_AUTO_FETCH=false',
    '-e',
    'SKYAPI_EPHEMERIS=de440s.bsp',
    // The root stays read-only as under compose (read_only: true, a tmpfs /tmp); /data is a tmpfs
    // writable by uid 1000 (the bootstrap takes its flock there before the presence check).
    '--read-only',
    '--tmpfs',
    '/tmp:size=64m,mode=1777',
    '--tmpfs',
    '/data:mode=1777',
    // (g) the image's probe command with shortened timings: the verdict, not the production wait.
    '--health-start-period',
    '1s',
    '--health-interval',
    '2s',
    '--health-timeout',
    '5s',
    '--health-retries',
    '1',
    ref,
  ]);
  // (f) the health answer once the bootstrap has failed on the missing ephemeris.
  const health = await waitFor(
    `${ref} on 127.0.0.1:${String(args.apiPort)}`,
    START_TIMEOUT_MS,
    async () => {
      const response = await httpGet(args.apiPort, '/api/v1/health');
      let body = null;
      try {
        body = JSON.parse(response.body.toString('utf8'));
      } catch {
        return null;
      }
      return typeof body?.detail === 'string' ? { response, body } : null;
    },
  );
  const where = `${ref} GET /api/v1/health`;
  check(
    'f',
    health.response.status === 503,
    `${where}: status ${String(health.response.status)}, expected 503`,
  );
  check(
    'f',
    health.response.headers['retry-after'] === '5',
    `${where}: Retry-After ${JSON.stringify(health.response.headers['retry-after'])}, expected 5`,
  );
  check(
    'f',
    health.response.headers['cache-control'] === 'no-store',
    `${where}: Cache-Control ${JSON.stringify(health.response.headers['cache-control'])}, expected no-store`,
  );
  check(
    'f',
    health.response.headers['x-content-type-options'] === 'nosniff',
    `${where}: X-Content-Type-Options ${JSON.stringify(health.response.headers['x-content-type-options'])}`,
  );
  check(
    'f',
    health.response.headers['content-security-policy'] === API_POLICY,
    `${where}: Content-Security-Policy ${JSON.stringify(health.response.headers['content-security-policy'])}, expected ${JSON.stringify(API_POLICY)}`,
  );
  check(
    'f',
    health.body.status === 'starting',
    `${where}: status field ${JSON.stringify(health.body.status)}, expected starting`,
  );
  check(
    'f',
    health.body.detail.includes(API_MISSING_DETAIL),
    `${where}: detail ${JSON.stringify(health.body.detail)} does not contain ${JSON.stringify(API_MISSING_DETAIL)}`,
  );
  // (g) the healthcheck verdict, read from the probe's own record: `unhealthy` alone would also be
  // the outcome of a probe that cannot run, so the last entry of the health log must show the
  // command exiting 1 on urllib's HTTPError for the 503.
  const readVerdict = () => {
    let state = null;
    try {
      state = JSON.parse(docker(['inspect', '--format', '{{json .State.Health}}', container]));
    } catch {
      state = null;
    }
    const last = Array.isArray(state?.Log) ? (state.Log.at(-1) ?? null) : null;
    return {
      status: state?.Status ?? null,
      exitCode: last?.ExitCode ?? null,
      output: String(last?.Output ?? ''),
    };
  };
  let verdict;
  try {
    verdict = await waitFor(`${ref} health status`, UNHEALTHY_TIMEOUT_MS, () => {
      const current = readVerdict();
      return current.status === 'unhealthy' &&
        current.exitCode === 1 &&
        current.output.includes(HEALTH_PROBE_503)
        ? current
        : null;
    });
  } catch {
    verdict = readVerdict();
  }
  check(
    'g',
    verdict.status === 'unhealthy',
    `${ref}: health status ${JSON.stringify(verdict.status)} after ${String(UNHEALTHY_TIMEOUT_MS / 1000)} s with the shortened timings, expected unhealthy`,
  );
  check(
    'g',
    verdict.exitCode === 1,
    `${ref}: the last health-log entry has ExitCode ${JSON.stringify(verdict.exitCode)}, expected 1 (the probe judging the 503; 126, 127 or 2 is a probe that cannot run)`,
  );
  check(
    'g',
    verdict.output.includes(HEALTH_PROBE_503),
    `${ref}: the last health-log entry does not name "${HEALTH_PROBE_503}", its output ends ${JSON.stringify(verdict.output.trimEnd().slice(-160))}`,
  );
  // (h) the runtime uid.
  const uid = dockerResult(['exec', container, 'id', '-u']);
  check(
    'h',
    uid.status === 0 && uid.stdout === '1000',
    `${ref}: id -u printed ${JSON.stringify(uid.stdout)} (exit ${String(uid.status)}), expected 1000`,
  );
  // (i) the runtime imports and the CLI.
  const imports = dockerResult([
    'exec',
    container,
    'python',
    '-c',
    'import skyapi.main, skyapi.cli.sky_data, pandas, numpy, pyarrow.parquet, pyarrow.dataset, pyarrow.fs, skyfield.api',
  ]);
  check(
    'i',
    imports.status === 0,
    `${ref}: the runtime imports failed (exit ${String(imports.status)}): ${imports.stderr}`,
  );
  const status = dockerResult(['exec', container, 'sky-data', 'status']);
  check(
    'i',
    status.status === 0,
    `${ref}: sky-data status exited ${String(status.status)}: ${status.stderr}`,
  );
  // (j) nothing of the build tooling survives.
  const pip = dockerResult(['exec', container, 'python', '-c', 'import pip']);
  check(
    'j',
    pip.status !== 0,
    `${ref}: \`import pip\` succeeds; pip was not removed from the final image`,
  );
  const uv = dockerResult(['exec', container, 'uv', '--version']);
  check('j', uv.status !== 0, `${ref}: uv is present in the final image (${uv.stdout})`);
  dockerResult(['rm', '-f', container]);
  containers.delete(container);
}

// --- lifecycle -----------------------------------------------------------------------------------

/** Containers this run created and may still hold; removed in `finally` and by the signal handler. */
const containers = new Set();
/** Temporary directories (the throwaway certificate pair). */
const tempDirs = new Set();

function cleanup() {
  for (const name of containers) dockerResult(['rm', '-f', name]);
  containers.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

async function main() {
  const args = parseCommandLine();
  if (args.selfTest) {
    selfTest();
    return;
  }
  try {
    // (a) the store.
    const store = docker(['info', '--format', '{{.Driver}} {{.ServerVersion}}']);
    console.log(`docker: ${store} (storage driver, server version)`);
    check('a', store.trim() !== '', 'docker info printed no storage driver');
    const api = await inspectImage(args.api, 'api', args);
    const web = await inspectImage(args.web, 'web', args);
    check(
      'b',
      api.architecture === web.architecture,
      `the images differ in architecture (${api.architecture} vs ${web.architecture})`,
    );
    if (!args.static) {
      await checkWeb(args.web, args);
      await checkApi(args.api, args);
    }
  } finally {
    cleanup();
  }
  console.log(
    `check_images: ${args.static ? 'static checks (a)-(c)' : 'checks (a)-(j)'}, ${String(checks)} assertions, ${String(findings.length)} findings`,
  );
  if (findings.length > 0) {
    for (const line of findings) console.error(`  ${line}`);
    process.exit(1);
  }
}

main().catch((error) => {
  cleanup();
  // The findings collected before the abort keep their context (the record lines are on stdout).
  for (const line of findings) console.error(`  ${line}`);
  console.error(
    `check_images: aborted after ${String(checks)} assertions and ${String(findings.length)} findings: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
