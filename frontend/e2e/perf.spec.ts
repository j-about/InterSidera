import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';
import { SourceMap } from 'node:module';

import type { SkyDebugResource, SkyDebugTiming } from '../src/debug/skyDebugApi.ts';
import { LAT, TT_FIXED, waitReady } from './support.ts';

// Performance records of the manual `perf` Playwright project (plan D146; brief l.257, l.484):
// never in `make e2e` or CI (`npm run e2e -- --project=perf` after `make build-e2e`, against the
// usual stack on 8000/4173). Two families of tests:
//   1. the boot under four network profiles (none, and three 4G readings emulated through CDP
//      `Network.emulateNetworkConditions` on a fresh context each: cold, then `page.reload()`
//      warm), recording the `sky:*` marks of `state/boot.ts` and the engine (plan D141), the
//      bytes on the wire and the catalog fetch/parse split into a `perf-boot.json` attachment;
//      asserted: the structure and the 6 MB download budget (brief l.258) alone. The cold 4G
//      figures are records (plan D138, backlog B-84), not gates;
//   2. a sampling heap profile (CDP `HeapProfiler.startSampling` with the objects collected by
//      the minor and the major GC included) over six seconds of the paused default sky, mapped to
//      `src/` through the e2e build's source maps (`build.sourcemap` under `--mode e2e`) into a
//      `perf-heap.json` attachment with bytes per rendered frame per site (plan D144, B-91).
// The SwiftShader figures of this project are the CI-side record; the host-GPU and phone rows of
// docs/testing.md come from `#selftest` (docs/dev-wsl2.md).

/** Bytes per second and milliseconds, from the vendors' own constants. */
interface NetworkProfile {
  /** DevTools `NetworkManager.ts` (Fast 4G / Slow 4G) or WebPageTest `connectivity.ini.sample`. */
  source: string;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
}

/**
 * The profiles of plan D138. DevTools applies a 0.9 factor to the nominal bit rates and scales
 * the latencies (`60 * 2.75`, `150 * 3.75`); WebPageTest's "4G" is 9 Mbps both ways at 170 ms.
 * "Slow 4G" is Lighthouse's default ("bottom 25 % of 4G").
 */
const PROFILES: Record<string, NetworkProfile | null> = {
  none: null,
  'fast-4g': {
    source: 'DevTools Fast 4G: 9e6/8*0.9 down, 1.5e6/8*0.9 up, 60*2.75 ms',
    latency: 60 * 2.75,
    downloadThroughput: (9e6 / 8) * 0.9,
    uploadThroughput: (1.5e6 / 8) * 0.9,
  },
  'slow-4g': {
    source: 'DevTools Slow 4G (Lighthouse default): 1.6e6/8*0.9 down, 750e3/8*0.9 up, 150*3.75 ms',
    latency: 150 * 3.75,
    downloadThroughput: (1.6e6 / 8) * 0.9,
    uploadThroughput: (750e3 / 8) * 0.9,
  },
  'wpt-4g': {
    source: 'WebPageTest 4G: 9 Mbps down and up, 170 ms',
    latency: 170,
    downloadThroughput: 9e6 / 8,
    uploadThroughput: 9e6 / 8,
  },
};

/** Session download budget of brief l.258, bytes on the wire. */
const DOWNLOAD_BUDGET_BYTES = 6_000_000;
/** The boot marks in the order the sequence sets them (`state/boot.ts`, then `SkyEngine.armReady`). */
const BOOT_MARKS = ['sky:health', 'sky:meta', 'sky:catalogs', 'sky:frame', 'sky:ready'] as const;
const ENGINE_MARK = 'sky:engine-ready';
/** Heap sampling: V8's default interval halved, six seconds after two seconds of settling. */
const HEAP_SAMPLING_INTERVAL_BYTES = 2048;
const HEAP_SETTLE_MS = 2000;
const HEAP_WINDOW_MS = 6000;
const HEAP_TOP_SITES = 40;

/** Greenwich, paused at the fixture instant, the default layers, WebGL2 (the research URL). */
const BOOT_URL = `/?body=earth&lat=${String(LAT)}&lon=0&elev=0&t=${String(TT_FIXED)}&speed=0&az=0&alt=45&fov=60&atm=0#engine=webgl2`;

interface BootTiming {
  timing: SkyDebugTiming;
  resources: SkyDebugResource[];
  fetchMs: number | null;
  parseMs: number | null;
}

interface BootRecord {
  /** Navigation start to `sky:ready` (the boot's first covering frame window), ms. */
  readyMs: number;
  /** Navigation start to `sky:engine-ready` (the first rendered frame with the catalog), ms. */
  engineReadyMs: number;
  marks: Record<string, number>;
  navigation: SkyDebugTiming['navigation'];
  /** `transferSize` sums: the whole document, the API, the catalogs, the assets. */
  bytes: { total: number; api: number; catalogs: number; assets: number };
  fetchMs: number | null;
  parseMs: number | null;
  /** Every Resource Timing row, for the waterfall of docs/testing.md. */
  resources: SkyDebugResource[];
}

// Slow 4G needs about 30 s cold on SwiftShader; four profiles x (cold + warm) stay well inside.
// `mode: 'default'` opts this file out of the config's `fullyParallel`: the five measurements run
// in order in one worker (five workers halve the SwiftShader frame rate of the heap window and
// add 10-40 % to every boot figure), each retried on its own; `serial` would skip the rest after
// one failure. So `npm run e2e -- --project=perf` is the record without `--workers=1`.
test.describe.configure({ mode: 'default', timeout: 300_000 });

/** Wait for the engine and for both ready marks (the boot's and the engine's). */
async function waitBooted(page: Page): Promise<void> {
  await waitReady(page, 240_000);
  await page.waitForFunction(
    (names) => {
      const marks = window.__sky?.timing().marks ?? {};
      return names.every((name) => name in marks);
    },
    [...BOOT_MARKS, ENGINE_MARK],
    { timeout: 30_000, polling: 100 },
  );
}

async function readBoot(page: Page): Promise<BootRecord> {
  const raw = await page.evaluate((): BootTiming | null => {
    const sky = window.__sky;
    if (sky === undefined) {
      return null;
    }
    const state = sky.state();
    return {
      timing: sky.timing(),
      resources: sky.resources(),
      fetchMs: state.fetchMs,
      parseMs: state.parseMs,
    };
  });
  if (raw === null) {
    throw new Error('window.__sky is missing: not an e2e build');
  }
  let api = 0;
  let catalogs = 0;
  let assets = 0;
  for (const row of raw.resources) {
    if (row.name.startsWith('/api/')) {
      api += row.transferSize;
      if (row.name.startsWith('/api/v1/catalogs/')) {
        catalogs += row.transferSize;
      }
    } else {
      assets += row.transferSize;
    }
  }
  const document = raw.timing.navigation?.transferSize ?? 0;
  return {
    readyMs: raw.timing.marks['sky:ready'] ?? NaN,
    engineReadyMs: raw.timing.marks[ENGINE_MARK] ?? NaN,
    marks: raw.timing.marks,
    navigation: raw.timing.navigation,
    bytes: { total: document + api + assets, api, catalogs, assets },
    fetchMs: raw.fetchMs,
    parseMs: raw.parseMs,
    resources: raw.resources,
  };
}

function expectBootStructure(record: BootRecord): void {
  for (const name of [...BOOT_MARKS, ENGINE_MARK]) {
    expect(record.marks[name], name).toBeGreaterThan(0);
  }
  // The phases follow one another; the engine's ready lands with the boot's (either order).
  for (let k = 1; k < BOOT_MARKS.length; k += 1) {
    const before = record.marks[BOOT_MARKS[k - 1] ?? ''] ?? NaN;
    const after = record.marks[BOOT_MARKS[k] ?? ''] ?? NaN;
    expect(after, `${BOOT_MARKS[k] ?? ''} after ${BOOT_MARKS[k - 1] ?? ''}`).toBeGreaterThanOrEqual(
      before,
    );
  }
  expect(record.readyMs).toBeGreaterThan(0);
  expect(record.engineReadyMs).toBeGreaterThan(0);
  expect(record.navigation).not.toBeNull();
  expect(record.resources.length).toBeGreaterThan(0);
  expect(record.fetchMs).not.toBeNull();
  expect(record.parseMs).not.toBeNull();
}

for (const [name, profile] of Object.entries(PROFILES)) {
  test(`boot under the "${name}" network profile, cold then warm`, async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    if (profile !== null) {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: profile.latency,
        downloadThroughput: profile.downloadThroughput,
        uploadThroughput: profile.uploadThroughput,
      });
    }
    await page.goto(BOOT_URL);
    await waitBooted(page);
    const cold = await readBoot(page);

    // Warm: the same context keeps the browser cache; `cache: 'no-cache'` revalidates every
    // catalog (304, headers alone) and the chunks (acceptance l.573).
    await page.reload();
    await waitBooted(page);
    const warm = await readBoot(page);
    await cdp.detach();

    expectBootStructure(cold);
    expectBootStructure(warm);
    // Brief l.258: the catalogs of a session stay under 6 MB on the wire (about 3.96 MB, the
    // SKYS uncompressed, backlog B-46); a warm boot moves a few kilobytes of headers.
    expect(cold.bytes.catalogs).toBeGreaterThan(0);
    expect(cold.bytes.catalogs).toBeLessThanOrEqual(DOWNLOAD_BUDGET_BYTES);
    expect(warm.bytes.catalogs).toBeLessThan(cold.bytes.catalogs);

    const record = {
      profile: name,
      conditions: profile,
      viewport: page.viewportSize(),
      userAgent: await page.evaluate(() => navigator.userAgent),
      cold,
      warm,
    };
    await test.info().attach('perf-boot.json', {
      body: JSON.stringify(record, null, 2),
      contentType: 'application/json',
    });
    test.info().annotations.push({
      type: 'boot',
      description:
        `${name}: cold ready ${String(Math.round(cold.readyMs))} ms ` +
        `(engine ${String(Math.round(cold.engineReadyMs))} ms, ${String(cold.bytes.total)} B), ` +
        `warm ready ${String(Math.round(warm.readyMs))} ms ` +
        `(engine ${String(Math.round(warm.engineReadyMs))} ms, ${String(warm.bytes.total)} B)`,
    });
  });
}

/** A node of the CDP sampling heap profile (the fields this spec reads). */
interface HeapNode {
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  selfSize: number;
  children: HeapNode[];
}

/** A `SourceMap` payload as Node's `module.SourceMap` consumes it (the fields it needs). */
interface SourceMapPayload {
  file: string;
  version: number;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
  sourceRoot: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** The parsed `.map` of a chunk, or `null` when it is missing or not a source map. */
function parseSourceMap(text: string): SourceMapPayload | null {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const map = parsed as Record<string, unknown>;
  if (
    typeof map.version !== 'number' ||
    typeof map.mappings !== 'string' ||
    !isStringArray(map.sources) ||
    !isStringArray(map.names)
  ) {
    return null;
  }
  return {
    file: typeof map.file === 'string' ? map.file : '',
    version: map.version,
    sources: map.sources,
    sourcesContent: isStringArray(map.sourcesContent) ? map.sourcesContent : [],
    names: map.names,
    mappings: map.mappings,
    sourceRoot: typeof map.sourceRoot === 'string' ? map.sourceRoot : '',
  };
}

/** `src/...` for application sources, `node_modules/<package>/...` for dependencies. */
function shortSource(source: string): string {
  const src = /(?:^|\/)(src\/.*)$/.exec(source)?.[1];
  if (src !== undefined) {
    return src;
  }
  const dep = /(?:^|\/)(node_modules\/.*)$/.exec(source)?.[1];
  return dep ?? source;
}

test('heap sampling over six seconds of the paused default sky, per source site', async ({
  page,
  context,
}) => {
  await page.goto(BOOT_URL);
  await waitReady(page, 240_000);
  await page.waitForTimeout(HEAP_SETTLE_MS);

  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const framesBefore = await page.evaluate(() => window.__sky?.stats().frames ?? 0);
  await cdp.send('HeapProfiler.startSampling', {
    samplingInterval: HEAP_SAMPLING_INTERVAL_BYTES,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const started = Date.now();
  await page.waitForTimeout(HEAP_WINDOW_MS);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  const seconds = (Date.now() - started) / 1000;
  const framesAfter = await page.evaluate(() => window.__sky?.stats().frames ?? 0);
  const fps = await page.evaluate(() => window.__sky?.fps() ?? 0);
  await cdp.send('HeapProfiler.disable');
  await cdp.detach();
  const frames = framesAfter - framesBefore;
  expect(frames).toBeGreaterThan(0);
  expect(profile.samples.length).toBeGreaterThan(0);

  // Source maps of the e2e build, fetched next to the chunks (`vite preview` serves them).
  const maps = new Map<string, SourceMap | null>();
  const mapFor = async (url: string): Promise<SourceMap | null> => {
    const known = maps.get(url);
    if (known !== undefined) {
      return known;
    }
    let map: SourceMap | null = null;
    if (url.startsWith('http')) {
      const response = await page.request.get(`${url}.map`, { failOnStatusCode: false });
      if (response.ok()) {
        const payload = parseSourceMap(await response.text());
        map = payload === null ? null : new SourceMap(payload);
      }
    }
    maps.set(url, map);
    return map;
  };

  const bySite = new Map<string, number>();
  let total = 0;
  const nodes: HeapNode[] = [profile.head];
  for (let node = nodes.pop(); node !== undefined; node = nodes.pop()) {
    nodes.push(...node.children);
    if (node.selfSize <= 0) {
      continue;
    }
    total += node.selfSize;
    const frame = node.callFrame;
    let site = `${frame.functionName || '(anonymous)'} @ ${frame.url}:${String(frame.lineNumber)}:${String(frame.columnNumber)}`;
    const map = await mapFor(frame.url);
    if (map !== null) {
      const entry = map.findEntry(frame.lineNumber, frame.columnNumber);
      if ('originalSource' in entry) {
        const fn = frame.functionName || '(anonymous)';
        site = `${fn} @ ${shortSource(entry.originalSource)}:${String(entry.originalLine + 1)}`;
      }
    }
    bySite.set(site, (bySite.get(site) ?? 0) + node.selfSize);
  }

  const sorted = [...bySite.entries()].sort((a, b) => b[1] - a[1]);
  const table = (
    rows: [string, number][],
  ): { site: string; bytes: number; bytesPerFrame: number }[] =>
    rows.map(([site, bytes]) => ({ site, bytes, bytesPerFrame: Math.round(bytes / frames) }));
  const ours = sorted.filter(([site]) => site.includes('@ src/'));
  const oursBytes = ours.reduce((sum, [, bytes]) => sum + bytes, 0);
  const record = {
    seconds,
    frames,
    fps,
    samples: profile.samples.length,
    totalBytes: total,
    bytesPerSecond: Math.round(total / seconds),
    bytesPerFrame: Math.round(total / frames),
    srcBytes: oursBytes,
    srcBytesPerFrame: Math.round(oursBytes / frames),
    top: table(sorted.slice(0, HEAP_TOP_SITES)),
    src: table(ours.slice(0, HEAP_TOP_SITES)),
  };
  await test.info().attach('perf-heap.json', {
    body: JSON.stringify(record, null, 2),
    contentType: 'application/json',
  });
  test.info().annotations.push({
    type: 'heap',
    description:
      `${String(total)} B over ${seconds.toFixed(1)} s and ${String(frames)} frames ` +
      `(${String(record.bytesPerFrame)} B/frame, src ${String(record.srcBytesPerFrame)} B/frame), ` +
      `top: ${record.src[0]?.site ?? '-'}`,
  });
  // The profile has sites and the per-frame figure is a number: an empty `top` would mean the
  // sampler saw nothing; `src` may legitimately shrink to nothing (brief l.257 asks for zero).
  expect(record.top.length).toBeGreaterThan(0);
  expect(record.srcBytesPerFrame).toBeGreaterThanOrEqual(0);
});
