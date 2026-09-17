// `window.__sky`, the debug hook of dev and e2e builds (brief l.410, plan D86). Installed only
// through a dynamic `import()` guarded by `import.meta.env.DEV || import.meta.env.MODE === 'e2e'`
// in the React shell, so production bundles carry neither this module nor the `__sky` string
// (`make build` greps for it). `altAzOf` and `screenOf` read what the engine renders through
// `SkyEngineApi.readoutOf` / `directionOf` (the CPU twin of the shaders: bodies from the
// interpolated direction the engine uploaded, stars through proper motion, aberration, the
// horizon rotation and the D73 refraction), so the hook and the picture cannot disagree.

import { observerQuery } from '../api/client';
import type { SkyDebugDeps } from '../sky/engine/types';
import { altAzToEnu, directionToScreen, enuToAltAz } from '../sky/math/frames';
import type { AltAz, ScreenPoint } from '../sky/math/frames';
import { vec3 } from '../sky/math/typed';
import { arcsecBetween3 } from '../sky/math/vec3';
import { createSelectionReadout } from '../state/types';
import type { ViewState } from '../state/types';
import type {
  SkyDebugAltAz,
  SkyDebugApi,
  SkyDebugLabel,
  SkyDebugReport,
  SkyDebugState,
} from './skyDebugApi';

const POLARIS = 'hip:11767';
const SELF_TEST_SECONDS = 10;

interface AltAzRow {
  id: string;
  alt_deg: number;
  az_deg: number;
}

function isAltAzRow(value: unknown): value is AltAzRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' && typeof row.alt_deg === 'number' && typeof row.az_deg === 'number'
  );
}

/** Show a report (or an error) in a fixed overlay so a human run needs no DevTools. */
function showOverlay(text: string): void {
  const pre = document.createElement('pre');
  pre.id = 'sky-selftest';
  pre.textContent = text;
  pre.style.cssText =
    'position:fixed;top:0;left:0;max-height:100vh;overflow:auto;margin:0;padding:8px;z-index:10;' +
    'font:12px/1.3 monospace;color:#e6e9f2;background:rgba(5,7,15,0.85);white-space:pre-wrap';
  document.body.append(pre);
}

export function installSkyDebug(deps: SkyDebugDeps): SkyDebugApi {
  const { store, engine, frames, catalog, canvas } = deps;
  let isReady = false;
  const ready = engine.whenReady().then(() => {
    isReady = true;
  });
  const enu = vec3();
  const altAz: AltAz = { alt: 0, az: 0 };
  const screen: ScreenPoint = { x: 0, y: 0 };
  const readout = createSelectionReadout();

  /** The rendered altitudes and azimuth of `id`, through the engine's own readout. */
  function altAzOf(id: string): SkyDebugAltAz | null {
    if (!engine.readoutOf(id, readout)) {
      return null;
    }
    return { alt: readout.alt, altTrue: readout.altTrue, az: readout.az };
  }

  /** The rendered (refracted) direction of `id` projected with the pure twin of the camera. */
  function screenOf(id: string): { x: number; y: number } | null {
    if (!engine.directionOf(id, enu)) {
      return null;
    }
    const { view, ar } = store.getState();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) {
      return null;
    }
    enuToAltAz(altAz, enu[0], enu[1], enu[2]);
    const inFront = directionToScreen(
      screen,
      altAz.alt,
      altAz.az,
      width,
      height,
      view.fov,
      view.az,
      view.alt,
      ar.roll,
    );
    return inFront ? { x: screen.x, y: screen.y } : null;
  }

  /** Minor bodies of the last evaluation that carry samples (`minorDrawn[m] === 1`). */
  function minorDrawnCount(): number {
    const current = engine.current;
    let drawn = 0;
    for (let m = 0; m < current.minorCount; m += 1) {
      if (current.minorDrawn[m] === 1) {
        drawn += 1;
      }
    }
    return drawn;
  }

  function state(): SkyDebugState {
    const s = store.getState();
    const cat = catalog();
    return {
      tt: engine.currentTt(),
      mode: s.clock.mode,
      speed: s.clock.speed,
      lstHours: engine.current.valid ? engine.current.lstHours : NaN,
      observer: s.observer,
      view: s.view,
      frame: s.frames.window,
      coverageStop: s.frames.coverageStop?.rangeTt ?? null,
      refr: s.options.refr,
      catalogs: {
        stars: cat?.columns.count ?? 0,
        index: cat?.hipIndex.size ?? 0,
        dso: s.catalogs.dso === 'ready' ? (s.meta?.catalogs.dso?.count ?? 0) : 0,
        constellations:
          s.catalogs.constellations === 'ready' ? (s.meta?.catalogs.constellations?.count ?? 0) : 0,
      },
      parseMs: cat?.parseMs ?? null,
      geo: s.geo.status,
      sel: s.selection,
      night: s.options.night,
      nightLevel: s.options.nightLevel,
      layers: s.layers,
      reducedMotion: engine.reducedMotion(),
      ui: { panel: s.ui.panel, sheet: s.ui.sheet, dialog: s.ui.dialog },
      ar: {
        mode: s.ar.mode,
        permission: s.ar.permission,
        capabilities: s.ar.capabilities,
        error: s.ar.error,
        heading: s.ar.heading,
        azOffsetDeg: s.ar.azOffsetDeg,
        cameraFovDeg: s.ar.cameraFovDeg,
        frame: s.ar.frame,
        roll: s.ar.roll,
        viewBeforeFov: s.ar.viewBefore?.fov ?? null,
        transparent: engine.arTransparent(),
        xr: s.ar.xr,
      },
    };
  }

  /** The camera video the AR controller attached to the engine's underlay, if any. */
  function arVideo(): { playing: boolean; width: number; height: number } | null {
    const video = engine.underlayRoot.querySelector('video');
    if (video === null) {
      return null;
    }
    return {
      playing: !video.paused && video.readyState >= 2,
      width: video.videoWidth,
      height: video.videoHeight,
    };
  }

  /** The labels the engine draws, with the boxes of its own layout (plan D105). */
  function labels(): SkyDebugLabel[] {
    return engine.labelBoxes();
  }

  /** The constellation is known for the selection alone, from the `/sky/altaz` details row. */
  function constellationOf(id: string): string | null {
    const s = store.getState();
    return id === s.selection ? s.details.con : null;
  }

  /** Rendered direction of `id` (as `altAzOf`) against an authoritative row, arcminutes. */
  const rowA = vec3();
  const rowB = vec3();
  function separationArcmin(rendered: SkyDebugAltAz, row: AltAzRow): number {
    altAzToEnu(rowA, rendered.alt, rendered.az);
    altAzToEnu(rowB, row.alt_deg, row.az_deg);
    return arcsecBetween3(rowA, rowB) / 60;
  }

  async function selfTest(seconds = SELF_TEST_SECONDS): Promise<SkyDebugReport> {
    await ready;
    const started = performance.now();
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, seconds * 1000);
    });
    const elapsed = (performance.now() - started) / 1000;
    const s = store.getState();
    const refraction = s.options.refr && s.observer.body === 'earth';
    const polarisRow = altAzOf(POLARIS);
    const polaris =
      polarisRow === null
        ? null
        : {
            alt: polarisRow.alt,
            lat: s.observer.lat,
            ok: Math.abs(polarisRow.alt - s.observer.lat) < 1,
          };
    // The instant of the last render tick, so the comparison targets what was drawn (OBS-7
    // rounding through observerQuery, the same query the frames carry).
    const tt = engine.currentTt();
    const ids = engine.current.bodyIds.slice(0, engine.current.bodyCount);
    const query = new URLSearchParams({
      ...Object.fromEntries(
        Object.entries(observerQuery(s.observer)).map(([k, v]) => [k, String(v)]),
      ),
      tt: String(tt),
      targets: ids.join(','),
      refraction: refraction ? '1' : '0',
    });
    const bodies: { id: string; sepArcmin: number }[] = [];
    if (ids.length > 0) {
      const res = await fetch(`/api/v1/sky/altaz?${query.toString()}`);
      const body: unknown = await res.json();
      if (!res.ok || !Array.isArray(body) || !body.every(isAltAzRow)) {
        throw new Error(`/sky/altaz answered ${String(res.status)}`);
      }
      for (const row of body) {
        const rendered = altAzOf(row.id);
        if (rendered !== null) {
          bodies.push({ id: row.id, sepArcmin: separationArcmin(rendered, row) });
        }
      }
    }
    const cat = catalog();
    return {
      backend: engine.backend,
      adapterInfo: engine.adapterInfo,
      userAgent: navigator.userAgent,
      viewport: {
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      tt,
      // The report can leave the browser (`#report=<url>`): it carries the rounded observer the
      // requests carry, never the exact position (OBS-7).
      observer: observerQuery(s.observer),
      refr: refraction,
      stars: engine.starCount(),
      parseMs: cat?.parseMs ?? null,
      seconds: elapsed,
      fps: engine.fps(),
      frameMs: engine.frameMs(),
      polaris,
      bodies,
      maxSepArcmin: bodies.length === 0 ? null : Math.max(...bodies.map((b) => b.sepArcmin)),
    };
  }

  const api: SkyDebugApi = {
    backend: engine.backend,
    get isReady() {
      return isReady;
    },
    ready,
    adapterInfo: engine.adapterInfo,
    fps: () => engine.fps(),
    state,
    altAzOf,
    screenOf,
    setTime: (tt) => {
      store.getState().actions.setTime(tt);
    },
    pause: () => {
      store.getState().actions.pause();
    },
    play: (speed) => {
      store.getState().actions.play(speed);
    },
    live: () => {
      store.getState().actions.live();
    },
    setView: (az, alt, fov) => {
      const patch: Partial<ViewState> = { az, alt };
      if (fov !== undefined) {
        patch.fov = fov;
      }
      store.getState().actions.setView(patch);
    },
    setRefraction: (on) => {
      store.getState().actions.setOptions({ refr: on });
    },
    waitForFrame: () => frames.whenCovering(),
    stats: () => ({
      stars: engine.starCount(),
      frameMs: engine.frameMs(),
      dso: engine.layerStats().dso,
      clinesSegments: engine.layerStats().clinesSegments,
      minorDrawn: minorDrawnCount(),
    }),
    pick: (x, y) => engine.pick(x, y),
    labels,
    constellationOf,
    skyBrightness: () => engine.skyBrightness(),
    setFollow: (on) => {
      store.getState().actions.setFollow(on);
    },
    arVideo,
    selfTest,
  };
  window.__sky = api;

  // `#selftest[&report=<url>]`: the self-test runs by itself and shows (and optionally posts) the
  // report, so a real-browser measurement needs only the URL (docs/testing.md; dev/e2e builds).
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  if (hashParams.has('selftest')) {
    const reportUrl = hashParams.get('report');
    void selfTest()
      .then(async (report) => {
        const json = JSON.stringify(report, null, 2);
        showOverlay(json);
        if (reportUrl !== null && reportUrl !== '') {
          await fetch(reportUrl, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'content-type': 'text/plain' },
            body: json,
          });
        }
      })
      .catch((error: unknown) => {
        showOverlay(`self-test failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
  return api;
}
