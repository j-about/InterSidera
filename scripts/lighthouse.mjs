#!/usr/bin/env node
// Lighthouse accessibility audit (make lighthouse, the CI e2e job; plan D155; brief l.290, l.578:
// "Lighthouse accessibility >= 90 on the main view"). Lighthouse is not a dependency of the
// project: the CLI is pinned and run through `npm --prefix frontend exec --package=lighthouse@X`
// (the npx cache, never a floating root `npx`), so the 116-package tree stays out of the lockfile
// while the version that produced a number is fixed; `--prefer-offline` makes npm use the cached
// pin without a registry round trip (a transient ECONNRESET on that check lost one run at M6) and
// still fetch it on a cold cache. The script expects the API on 8000 and the
// e2e preview on 4173 (`make dev-api`, `make build-e2e`, `npm --prefix frontend run preview`),
// checks both before the first run, scores six URLs (the e2e `appUrl` query of e2e/support.ts:
// Greenwich, paused at TT 2460409.25, looking north, atmosphere off, the WebGL2 engine hash) in
// the mobile emulation and with `--preset=desktop`, in night mode, in French with a selection and
// on the bare root (the geolocation flow), asserts `categories.accessibility.score >= --min-score`
// (default 0.9) and an empty `runWarnings` per run, prints one row per URL (score, failing audits
// with their weight, the axe-core version) and writes reports/lighthouse/summary.json beside the
// `<name>.report.{json,html}` pairs (`/reports/` is gitignored). Chrome is the Playwright Chromium
// (`@playwright/test`'s `chromium.executablePath()`) unless CHROME_PATH is set, with the SwiftShader
// flags the Playwright projects use so the sky boots headless; `--extra-chrome-flags` appends more
// (a host GPU run). Two chrome-launcher behaviours are worked around: on WSL it takes its Windows
// branch and hands Chromium a `C:\Users\...` profile path, which Chromium creates relative to its
// cwd and nobody removes, so the child runs in a temporary directory and `--user-data-dir=<tmp>`
// is the LAST chrome flag (the last occurrence of a switch wins), both removed in `finally` and,
// since `process.exit` pre-empts `finally`, by the signal handler on Ctrl-C too; and
// without `--enable-error-reporting=false` the CLI prompts for Sentry on a TTY.
// The verdict of a run is its own: the run's `<name>.report.{json,html}` pair is removed before the
// CLI starts (a stale pair from an earlier run would otherwise score a failed launch), and a
// non-zero exit code or a timeout fails the run whatever the report says. On a timeout the CLI is
// spawned detached, so its whole process group (npm, the Lighthouse node process) gets SIGKILL;
// chrome-launcher spawns Chrome detached in turn (its own group), so the processes holding our
// `--user-data-dir` are found through /proc and killed too, and the profile directory is removed
// only once they are gone (Chrome writes into it as it exits). Ctrl-C kills the same processes,
// then removes the run's cwd and profile directories (best effort: a Chrome still dying may write
// once more) before leaving. A `--only` subset writes `summary-only.json` (with `only` listing the
// names), never the six-URL `summary.json` the CI artifact carries. Every argument error (an
// unknown option, an empty `--only`, a `--min-score` outside [0, 1]) prints one line and exits 2.
// Usage: node scripts/lighthouse.mjs [--base-url http://127.0.0.1:4173] [--min-score 0.9]
//          [--out-dir reports/lighthouse] [--extra-chrome-flags "--flag ..."] [--only name,...]
// No dependencies; Node 24 built-ins only (fetch, parseArgs, mkdtemp, /proc).
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const frontend = path.join(root, 'frontend');

/** The pinned CLI (Apache-2.0); bump deliberately, the score is recorded against it. */
const LIGHTHOUSE_VERSION = '13.5.0';
/** The e2e boot state of e2e/support.ts::appUrl (Greenwich, paused, north, atmosphere off). */
const APP_QUERY = 'body=earth&lat=51.48&lon=0&elev=0&t=2460409.25&speed=0&az=0&alt=45&fov=60&atm=0';
const ENGINE_HASH = '#engine=webgl2';
/**
 * Headless Chromium with the SwiftShader WebGL2 the Playwright projects rely on. `--no-sandbox`
 * is what Playwright passes by default (`chromiumSandbox: false`): Ubuntu 24.04 and later, the CI
 * runner included, restrict unprivileged user namespaces through AppArmor, the Playwright binary
 * ships no AppArmor profile, and chrome-launcher then never sees the DevTools port ("waiting for
 * dynamic debugging port in chrome-err.log", the first remote e2e job). The audit loads the
 * project's own pages on loopback, so the sandbox buys nothing here.
 */
const CHROME_FLAGS = [
  '--headless=new',
  '--no-sandbox',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];
/** One SwiftShader boot takes 4-8 s here; the CLI's own load wait is capped at this. */
const MAX_WAIT_FOR_LOAD_MS = 90_000;
/** Hard cap per run (the CLI hung on a dead server would otherwise block CI). */
const RUN_TIMEOUT_MS = 5 * 60_000;
/** How long a killed Chrome may take to disappear from /proc before the profile is removed. */
const REAP_TIMEOUT_MS = 10_000;
/** The exit code recorded for a run the cap ended. */
const TIMEOUT_EXIT = 'timeout';

const USAGE =
  'usage: node scripts/lighthouse.mjs [--base-url URL] [--min-score 0.9] [--out-dir DIR] [--extra-chrome-flags "..."] [--only name,name]';

/** The parsed options; an unknown option or a missing value is an argument error (exit 2), not a stack trace. */
function parseCommandLine() {
  try {
    return parseArgs({
      options: {
        'base-url': { type: 'string', default: 'http://127.0.0.1:4173' },
        'min-score': { type: 'string', default: '0.9' },
        'out-dir': { type: 'string', default: 'reports/lighthouse' },
        'extra-chrome-flags': { type: 'string', default: '' },
        only: { type: 'string', default: '' },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch (error) {
    console.error(`lighthouse: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    process.exit(2);
  }
}

const args = parseCommandLine();
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
const baseUrl = args['base-url'].replace(/\/$/, '');
const minScore = Number(args['min-score']);
if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
  console.error(`lighthouse: --min-score must be a number in [0, 1], got ${args['min-score']}`);
  process.exit(2);
}
const outDir = path.resolve(root, args['out-dir']);
const extraChromeFlags = args['extra-chrome-flags'].split(/\s+/).filter((flag) => flag !== '');
const only = new Set(args.only.split(',').filter((name) => name !== ''));

/** The six URLs of plan D155: mobile emulation unless `preset` says desktop. */
const RUNS = [
  { name: 'main', path: `/?${APP_QUERY}${ENGINE_HASH}`, preset: null },
  { name: 'main-desktop', path: `/?${APP_QUERY}${ENGINE_HASH}`, preset: 'desktop' },
  { name: 'night', path: `/?${APP_QUERY}&night=1${ENGINE_HASH}`, preset: null },
  { name: 'night-desktop', path: `/?${APP_QUERY}&night=1${ENGINE_HASH}`, preset: 'desktop' },
  {
    name: 'french-selection',
    path: `/?${APP_QUERY}&lang=fr&sel=hip:32349${ENGINE_HASH}`,
    preset: null,
  },
  { name: 'root', path: '/', preset: null },
].filter((run) => only.size === 0 || only.has(run.name));
if (RUNS.length === 0) {
  console.error(
    `lighthouse: --only names none of main, main-desktop, night, night-desktop, french-selection, root`,
  );
  process.exit(2);
}

/** The Playwright Chromium unless the caller points CHROME_PATH elsewhere. */
function chromePath() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  const require = createRequire(path.join(frontend, 'package.json'));
  const { chromium } = require('@playwright/test');
  return chromium.executablePath();
}

/** The npm beside the running node (fnm puts both in one directory), else the PATH's. */
function npmCommand() {
  const beside = path.join(path.dirname(process.execPath), 'npm');
  return existsSync(beside) ? beside : 'npm';
}

/** Both servers must answer before Chrome is launched: a dead stack would score the error page. */
async function preflight() {
  const health = await fetch(`${baseUrl}/api/v1/health`).catch((error) => {
    throw new Error(
      `the preview at ${baseUrl} does not answer (${String(error)}); start the API on 8000 and the e2e preview on 4173 first`,
    );
  });
  if (health.status === 503) {
    throw new Error(
      `/api/v1/health answers 503 (the API is still starting); wait for ready or degraded`,
    );
  }
  if (!health.ok) {
    throw new Error(`/api/v1/health answers ${String(health.status)}`);
  }
  const body = await health.json();
  const page = await fetch(`${baseUrl}/`);
  if (!page.ok) {
    throw new Error(`${baseUrl}/ answers ${String(page.status)}`);
  }
  return body.status;
}

/** The child the cap or a signal must kill, while one runs. */
let activeChild = null;
/** The profile directories of the runs in flight (one at a time), for the signal handler. */
const activeProfiles = new Set();
/** The temporary cwd of the run in flight, removed by `finally` or by the signal handler. */
const activeCwds = new Set();

/** SIGKILL the child's process group (it is a group leader: `detached`), else the child alone. */
function killGroup(child) {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** The pids (not ours) whose command line names `profileDir`: Chrome and its helpers, on Linux. */
function pidsHolding(profileDir) {
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  const pids = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number(entry);
    if (pid === process.pid) {
      continue;
    }
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, 'latin1').includes(profileDir)) {
        pids.push(pid);
      }
    } catch {
      // The process ended between the listing and the read.
    }
  }
  return pids;
}

/** Kill every process holding the profile and wait until none is left (bounded); returns the count killed. */
async function reapProfile(profileDir) {
  const killed = new Set();
  const deadline = Date.now() + REAP_TIMEOUT_MS;
  for (;;) {
    const pids = pidsHolding(profileDir);
    if (pids.length === 0) {
      return killed.size;
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        killed.add(pid);
      } catch {
        // Gone already.
      }
    }
    if (Date.now() >= deadline) {
      console.error(
        `lighthouse: ${String(pids.length)} process(es) still hold ${profileDir} after ${String(REAP_TIMEOUT_MS / 1000)} s`,
      );
      return killed.size;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Spawn the pinned CLI on one URL; resolves with the exit code (`TIMEOUT_EXIT` when the cap killed it), rejects on a spawn error. */
function runCli(run, chrome, cwd, profileDir) {
  const chromeFlags = [...CHROME_FLAGS, ...extraChromeFlags, `--user-data-dir=${profileDir}`];
  const cliArgs = [
    '--prefix',
    frontend,
    'exec',
    '--yes',
    '--prefer-offline',
    `--package=lighthouse@${LIGHTHOUSE_VERSION}`,
    '--',
    'lighthouse',
    `${baseUrl}${run.path}`,
    '--only-categories=accessibility',
    '--output',
    'json',
    '--output',
    'html',
    '--output-path',
    path.join(outDir, run.name),
    '--quiet',
    '--max-wait-for-load',
    String(MAX_WAIT_FOR_LOAD_MS),
    '--enable-error-reporting=false',
    `--chrome-flags=${chromeFlags.join(' ')}`,
  ];
  if (run.preset !== null) {
    cliArgs.push(`--preset=${run.preset}`);
  }
  return new Promise((resolve, reject) => {
    // `detached`: the child leads its own process group, so a timeout can kill npm and the
    // Lighthouse process it spawned in one signal (the parent still waits: no `unref`).
    const child = spawn(npmCommand(), cliArgs, {
      cwd,
      env: { ...process.env, CHROME_PATH: chrome },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    });
    activeChild = child;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(
        `lighthouse ${run.name}: no result after ${String(RUN_TIMEOUT_MS / 1000)} s, killing the run`,
      );
      killGroup(child);
    }, RUN_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      activeChild = null;
      reject(error);
    });
    // Resolved from `exit` only, so the caller removes the directories after the group is dead.
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      activeChild = null;
      if (timedOut) {
        resolve(TIMEOUT_EXIT);
      } else {
        resolve(code ?? `signal ${String(signal)}`);
      }
    });
  });
}

/** Ctrl-C or a job cancellation: the detached group would outlive us otherwise. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (activeChild !== null) {
      killGroup(activeChild);
    }
    for (const dir of activeProfiles) {
      for (const pid of pidsHolding(dir)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Gone already.
        }
      }
    }
    // `process.exit` pre-empts the `finally` of `main`, so the directories go here (best effort:
    // the killed Chrome is not awaited, a last write may re-create a file).
    for (const dir of [...activeCwds, ...activeProfiles]) {
      rmSync(dir, { recursive: true, force: true });
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

/** The row of one run from its `<name>.report.json`. */
function summarize(run, exitCode) {
  const reportJson = path.join(outDir, `${run.name}.report.json`);
  const reportHtml = path.join(outDir, `${run.name}.report.html`);
  if (!existsSync(reportJson)) {
    return {
      name: run.name,
      url: `${baseUrl}${run.path}`,
      preset: run.preset ?? 'mobile',
      exitCode,
      score: null,
      failing: [],
      runWarnings: [`no report written (exit ${String(exitCode)})`],
      axeCore: null,
      reportJson: null,
      reportHtml: existsSync(reportHtml) ? reportHtml : null,
    };
  }
  const lhr = JSON.parse(readFileSync(reportJson, 'utf8'));
  const category = lhr.categories?.accessibility;
  const failing = (category?.auditRefs ?? [])
    .map((ref) => ({ id: ref.id, weight: ref.weight, audit: lhr.audits?.[ref.id] }))
    .filter(({ audit }) => audit !== undefined && audit.score !== null && audit.score < 1)
    .map(({ id, weight, audit }) => ({ id, weight, score: audit.score, title: audit.title }));
  return {
    name: run.name,
    url: `${baseUrl}${run.path}`,
    preset: run.preset ?? 'mobile',
    finalDisplayedUrl: lhr.finalDisplayedUrl ?? null,
    exitCode,
    score: category?.score ?? null,
    failing,
    runWarnings: lhr.runWarnings ?? [],
    axeCore: lhr.environment?.credits?.['axe-core'] ?? null,
    userAgent: lhr.environment?.hostUserAgent ?? null,
    lighthouseVersion: lhr.lighthouseVersion ?? null,
    reportJson,
    reportHtml: existsSync(reportHtml) ? reportHtml : null,
  };
}

function formatRow(row) {
  const score = row.score === null ? 'n/a' : row.score.toFixed(2);
  const failing =
    row.failing.length === 0
      ? 'none'
      : row.failing.map((audit) => `${audit.id} (weight ${String(audit.weight)})`).join(', ');
  const warnings = row.runWarnings.length === 0 ? '' : ` | warnings: ${row.runWarnings.join('; ')}`;
  return `${row.name.padEnd(17)} ${row.preset.padEnd(8)} score ${score}  failing: ${failing}  axe-core ${String(row.axeCore)}${warnings}`;
}

async function main() {
  const apiStatus = await preflight();
  const chrome = chromePath();
  if (!existsSync(chrome)) {
    throw new Error(
      `Chrome binary not found at ${chrome} (CHROME_PATH or the Playwright Chromium)`,
    );
  }
  mkdirSync(outDir, { recursive: true });
  console.log(
    `lighthouse ${LIGHTHOUSE_VERSION} (accessibility only) against ${baseUrl} (API ${String(apiStatus)}), chrome ${chrome}, min score ${String(minScore)}`,
  );
  const rows = [];
  for (const run of RUNS) {
    // A fresh cwd and profile per run: chrome-launcher's WSL branch creates a `C:\Users\...`
    // profile relative to the cwd; both directories are ours and removed whatever happens.
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'intersidera-lighthouse-'));
    const profileDir = mkdtempSync(path.join(os.tmpdir(), 'intersidera-lighthouse-profile-'));
    // Only this run may produce this run's report: a pair left by an earlier run never scores.
    for (const ext of ['report.json', 'report.html']) {
      rmSync(path.join(outDir, `${run.name}.${ext}`), { force: true });
    }
    activeProfiles.add(profileDir);
    activeCwds.add(cwd);
    let exitCode = null;
    try {
      exitCode = await runCli(run, chrome, cwd, profileDir);
    } finally {
      // Chrome is detached from the CLI's group (chrome-launcher): kill what still holds the
      // profile and wait for it, or Chrome would re-create the directory while exiting.
      const reaped = await reapProfile(profileDir);
      if (reaped > 0) {
        console.error(`lighthouse ${run.name}: killed ${String(reaped)} leftover process(es)`);
      }
      activeProfiles.delete(profileDir);
      activeCwds.delete(cwd);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(profileDir, { recursive: true, force: true });
    }
    const row = summarize(run, exitCode);
    rows.push(row);
    console.log(formatRow(row));
  }
  // The exit code is part of the verdict: a CLI that failed or was killed never passes on a score.
  const failures = rows.filter(
    (row) =>
      row.exitCode !== 0 ||
      row.score === null ||
      row.score < minScore ||
      row.runWarnings.length > 0,
  );
  const summary = {
    date: new Date().toISOString(),
    lighthouseVersion: LIGHTHOUSE_VERSION,
    axeCore: rows.find((row) => row.axeCore !== null)?.axeCore ?? null,
    chromePath: chrome,
    baseUrl,
    minScore,
    only: [...only].sort(),
    passed: failures.length === 0,
    runs: rows,
  };
  const summaryPath = path.join(outDir, only.size === 0 ? 'summary.json' : 'summary-only.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`summary: ${summaryPath}`);
  if (failures.length > 0) {
    for (const row of failures) {
      console.error(
        `lighthouse: ${row.name} failed (exit ${String(row.exitCode)}, score ${String(row.score)} < ${String(minScore)} or warnings ${JSON.stringify(row.runWarnings)})`,
      );
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`lighthouse: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
