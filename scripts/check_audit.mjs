#!/usr/bin/env node
// Dependency-audit gate (make audit, the CI `audit` job; plan D151, brief l.276, backlog B-86).
// Reads the JSON reports written by `npm audit --json --package-lock-only` and by
// `pip-audit -f json` (the recipe ignores both exit codes: each tool exits non-zero on any
// finding) and compares every advisory with scripts/audit-allowlist.json:
//   { "npm": [...], "python": [...] } with entries { id, package, reason, added, expires },
//   `added` and `expires` as ISO dates (YYYY-MM-DD), `expires` inclusive.
// Fails when:
//   (a) either file is not a report of its tool (npm: an object carrying `vulnerabilities` and
//       `metadata`; pip-audit: an object carrying a `dependencies` array), e.g. after a registry
//       outage; a report that audited nothing (npm `metadata.dependencies.total` 0 or absent,
//       pip-audit an empty `dependencies` array: an empty export); an npm report whose metadata
//       counts vulnerabilities while no `via` array carries an advisory object (a shape change);
//       or pip-audit skipped a dependency (`skip_reason`, refused by `--strict` anyway);
//   (b) an advisory is not allow-listed for its package: npm advisories are the objects of each
//       vulnerability's `via` array (strings there name another vulnerable package, not an
//       advisory) and are identified by the GHSA id of their `url`, or by their numeric `source`
//       when the URL carries none; pip-audit advisories are the `vulns[]` rows of each dependency,
//       identified by `id` and every alias (PYSEC, CVE, GHSA: pip-audit treats them as equivalent);
//   (c) an allow-list entry is malformed, expired (`expires` before today, UTC), added in the
//       future, or expires more than 180 days after `added` (an accepted risk is re-examined at
//       least twice a year); such an entry accepts nothing, so its advisory is reported as not
//       allow-listed as well;
//   (d) an allow-list entry matches no reported advisory (a fixed advisory leaves the list with
//       the fix, the unused-key rule of check_i18n.mjs).
// Ids and package names compare case-insensitively (GHSA ids are lower-case in npm's URLs, CVE
// and PYSEC ids upper-case; Python names are compared in their canonical `-` form).
// Prints one line per tool (what it audited and found), one per accepted entry and a summary.
// Usage: node scripts/check_audit.mjs --npm <npm-audit.json> --python <pip-audit.json>
//        [--allowlist <file>]   (default scripts/audit-allowlist.json; the tests of the gate)
// No dependencies; Node 24 built-ins only.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MAX_ALLOW_DAYS = 180;
const DAY_MS = 86_400_000;
const GHSA_RE = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ENTRY_KEYS = ['id', 'package', 'reason', 'added', 'expires'];

function usage(message) {
  console.error(`check_audit: ${message}`);
  console.error(
    'usage: node scripts/check_audit.mjs --npm <npm-audit.json> --python <pip-audit.json> [--allowlist <file>]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { allowlist: path.resolve(import.meta.dirname, 'audit-allowlist.json') };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--npm', '--python', '--allowlist'].includes(flag)) usage(`unknown argument ${flag}`);
    if (value === undefined) usage(`${flag} needs a file path`);
    args[flag.slice(2)] = value;
  }
  if (!args.npm || !args.python) usage('both --npm and --python are required');
  return args;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readJson(file, what) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { error: `${what}: cannot read ${file} (${error.message})` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: `${what}: ${file} is not JSON (${error.message})` };
  }
}

/** A `YYYY-MM-DD` string as a UTC day number, or null when it is not a real calendar date. */
function dayOf(value) {
  const match = typeof value === 'string' ? ISO_DATE_RE.exec(value) : null;
  if (match === null) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return ms / DAY_MS;
}

const canonicalPackage = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
const canonicalId = (id) => String(id).toUpperCase();

/** npm: `{ vulnerabilities: { <package>: { via: [advisory | string], ... } }, metadata }`. */
function npmAdvisories(report) {
  if (!isObject(report) || !isObject(report.vulnerabilities) || !isObject(report.metadata)) {
    return { error: 'npm: not an `npm audit --json` report (no `vulnerabilities` and `metadata`)' };
  }
  const counts = isObject(report.metadata.vulnerabilities) ? report.metadata.vulnerabilities : {};
  const packages = isObject(report.metadata.dependencies) ? report.metadata.dependencies : {};
  if (!(Number(packages.total) > 0)) {
    return {
      error: 'npm: the report audited no dependency (`metadata.dependencies.total` is 0 or absent)',
    };
  }
  const advisories = [];
  for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
    const via = isObject(vuln) && Array.isArray(vuln.via) ? vuln.via : [];
    for (const item of via) {
      if (!isObject(item)) continue; // a dependent of a vulnerable package, not an advisory
      const ghsa = typeof item.url === 'string' ? GHSA_RE.exec(item.url) : null;
      const id = ghsa !== null ? ghsa[0] : `npm-${String(item.source)}`;
      advisories.push({
        ecosystem: 'npm',
        package: typeof item.name === 'string' ? item.name : name,
        ids: [id],
        detail: `${String(item.severity)} ${String(item.title)} (${String(item.range)})`,
      });
    }
  }
  if (Number(counts.total ?? 0) > 0 && advisories.length === 0) {
    return {
      error:
        'npm: `metadata.vulnerabilities.total` counts vulnerabilities but no `via` array carries an advisory object (report shape changed?)',
    };
  }
  return {
    advisories,
    line: `npm audit: ${String(packages.total ?? '?')} packages, ${String(counts.total ?? '?')} vulnerabilities (${['critical', 'high', 'moderate', 'low', 'info'].map((k) => `${k} ${String(counts[k] ?? 0)}`).join(', ')})`,
  };
}

/** pip-audit: `{ dependencies: [{ name, version, vulns: [{ id, aliases, fix_versions }] } | { name, skip_reason }], fixes }`. */
function pythonAdvisories(report) {
  if (!isObject(report) || !Array.isArray(report.dependencies)) {
    return { error: 'python: not a `pip-audit -f json` report (no `dependencies` array)' };
  }
  if (report.dependencies.length === 0) {
    return { error: 'python: pip-audit audited no dependency (an empty requirements export?)' };
  }
  const advisories = [];
  const skipped = [];
  for (const dep of report.dependencies) {
    if (!isObject(dep)) continue;
    if (dep.skip_reason !== undefined) {
      skipped.push(`${String(dep.name)}: ${String(dep.skip_reason)}`);
      continue;
    }
    for (const vuln of Array.isArray(dep.vulns) ? dep.vulns : []) {
      if (!isObject(vuln)) continue;
      const aliases = Array.isArray(vuln.aliases) ? vuln.aliases.map(String) : [];
      const fixes = Array.isArray(vuln.fix_versions) ? vuln.fix_versions.map(String) : [];
      advisories.push({
        ecosystem: 'python',
        package: String(dep.name),
        ids: [String(vuln.id), ...aliases],
        detail: `${String(dep.name)} ${String(dep.version)}, fixed in ${fixes.join(', ') || 'no release'}`,
      });
    }
  }
  if (skipped.length > 0) {
    return {
      error: `python: pip-audit skipped ${skipped.length} dependency(ies): ${skipped.join('; ')}`,
    };
  }
  return {
    advisories,
    line: `pip-audit: ${report.dependencies.length} packages, ${advisories.length} vulnerabilities`,
  };
}

function validateAllowlist(list, today) {
  const findings = [];
  const entries = [];
  if (!isObject(list) || !Array.isArray(list.npm) || !Array.isArray(list.python)) {
    return { findings: ['allow-list: expected { "npm": [...], "python": [...] }'], entries };
  }
  for (const ecosystem of ['npm', 'python']) {
    list[ecosystem].forEach((entry, index) => {
      const where = `allow-list ${ecosystem}[${index}]`;
      if (!isObject(entry)) {
        findings.push(`${where}: not an object`);
        return;
      }
      const before = findings.length;
      const extra = Object.keys(entry).filter((key) => !ENTRY_KEYS.includes(key));
      if (extra.length > 0) findings.push(`${where}: unknown key(s) ${extra.join(', ')}`);
      for (const key of ENTRY_KEYS) {
        if (typeof entry[key] !== 'string' || entry[key].trim() === '')
          findings.push(`${where}: ${key} must be a non-empty string`);
      }
      const added = dayOf(entry.added);
      const expires = dayOf(entry.expires);
      if (added === null) findings.push(`${where}: added is not an ISO date (YYYY-MM-DD)`);
      else if (added > today) findings.push(`${where}: added is in the future`);
      if (expires === null) findings.push(`${where}: expires is not an ISO date (YYYY-MM-DD)`);
      if (added !== null && expires !== null) {
        if (expires < added) findings.push(`${where}: expires before added`);
        else if (expires - added > MAX_ALLOW_DAYS)
          findings.push(`${where}: expires more than ${MAX_ALLOW_DAYS} days after added`);
        if (expires < today) findings.push(`${where}: expired on ${entry.expires}`);
      }
      // An entry with a finding of its own accepts nothing (its advisory then fails too).
      entries.push({ ...entry, ecosystem, where, valid: findings.length === before, used: false });
    });
  }
  return { findings, entries };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const findings = [];
  const today = Math.floor(Date.now() / DAY_MS);

  const reports = {};
  for (const tool of ['npm', 'python']) {
    const raw = readJson(args[tool], tool);
    if (raw.error) reports[tool] = raw;
    else reports[tool] = tool === 'npm' ? npmAdvisories(raw.value) : pythonAdvisories(raw.value);
    if (reports[tool].error) findings.push(reports[tool].error);
  }
  const allow = readJson(args.allowlist, 'allow-list');
  const { findings: listFindings, entries } = allow.error
    ? { findings: [allow.error], entries: [] }
    : validateAllowlist(allow.value, today);
  findings.push(...listFindings);

  const advisories = ['npm', 'python'].flatMap((tool) => reports[tool].advisories ?? []);
  let accepted = 0;
  for (const advisory of advisories) {
    const ids = new Set(advisory.ids.map(canonicalId));
    const match = entries.find(
      (entry) =>
        entry.valid &&
        entry.ecosystem === advisory.ecosystem &&
        canonicalPackage(entry.package) === canonicalPackage(advisory.package) &&
        ids.has(canonicalId(entry.id)),
    );
    if (match === undefined) {
      findings.push(
        `${advisory.ecosystem}: ${advisory.package} ${advisory.ids.join(' / ')} is not allow-listed: ${advisory.detail}`,
      );
      continue;
    }
    match.used = true;
    accepted += 1;
    console.log(
      `accepted: ${advisory.ecosystem} ${advisory.package} ${advisory.ids.join(' / ')} (${match.reason}; added ${match.added}, expires ${match.expires})`,
    );
  }
  for (const entry of entries) {
    if (entry.valid && !entry.used)
      findings.push(
        `${entry.where}: ${entry.package} ${entry.id} matches no reported advisory (unused)`,
      );
  }

  for (const tool of ['npm', 'python']) {
    if (reports[tool].line) console.log(reports[tool].line);
  }
  console.log(
    `audit: ${advisories.length} advisories (${accepted} accepted), ${entries.length} allow-list entries, ${findings.length} findings`,
  );
  if (findings.length > 0) {
    for (const line of findings) console.error(`  ${line}`);
    process.exit(1);
  }
}

main();
