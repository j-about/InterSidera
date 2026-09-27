import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations } from './axe.ts';
import {
  TT_FIXED,
  appUrl,
  blurActiveElement,
  canvasBox,
  centrePatch,
  collectAssetRequests,
  collectErrors,
  collectForeignRequests,
  debugState,
  waitReady,
} from './support.ts';

// Augmented reality (AR-1..AR-5, brief l.237-241; plan D134) on the Pixel 7 emulation only: the
// AR button exists on touch devices alone, so the desktop project asserts its absence in
// a11y.spec.ts. The worker gets its own browser: Chromium's fake camera renders a rolling test
// pattern, and on Playwright's headless shell the fake device alone answers `getUserMedia` with
// `NotSupportedError`, so `--use-fake-ui-for-media-stream` accompanies it (the prompt is
// auto-accepted; the denied path stubs `getUserMedia` through an init script). A `permissions`
// list denies whatever it omits, and Chromium >= 152 answers `DeviceOrientationEvent.
// requestPermission()` from the sensors permission, so the three sensor permissions are granted
// beside the camera. Orientation samples are synthetic `deviceorientationabsolute` events
// dispatched by an init-script ticker every 100 ms from `window.__fakeOrientation` (CDP's
// `setDeviceOrientationOverride` drives the relative sensor only). One boot per scenario,
// `test.step` inside (plan D113). axe-core scans the overlay in three states (plan D156: the
// sensor mode with a good compass, the manual-north hint, the `requesting` banner) and the two 1°
// nudge buttons are the non-drag twin of the calibration drag (WCAG 2.5.7, plan D157 C5).
// Expected console output during these runs: none at the `error`
// level; the WebXR scenario yields `console.warn` lines only, which `collectErrors` ignores by
// design: Babylon's "We recommend using 'unbounded' reference space type..." (once per entry,
// the `local` space of plan D128), "dom-overlay is an experimental and unstable feature." (once
// per entry) and its `makeXRCompatible` warning on the existing WebGL2 context.

test.skip(({ isMobile }) => !isMobile, 'the AR button exists on touch devices only (AR-1)');

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['camera', 'accelerometer', 'gyroscope', 'magnetometer'],
});

test.describe.configure({ timeout: 180_000 });

/** The lazy chunks of plan D131 (`webxr-*` is shared by the controller and the bridge): none may be requested before AR entry. */
const LAZY_CHUNKS = /\/(arController|ArOverlay|XrBridge|webxr|webgpu|babylon-webgpu)-[^/]+\.js$/;
const DEG = Math.PI / 180;

interface FakeOrientation {
  alpha: number;
  beta: number;
  gamma: number;
  /** `false` for a relative-only stream (`deviceorientation` with `absolute: false`). */
  absolute?: boolean;
}

declare global {
  interface Window {
    __fakeOrientation?: FakeOrientation | null;
  }
}

/** The ticker: dispatches the current fake sample every 100 ms until it is set to `null`. */
async function installFakeSensors(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__fakeOrientation = null;
    window.setInterval(() => {
      const sample = window.__fakeOrientation;
      if (sample === null || sample === undefined) {
        return;
      }
      const absolute = sample.absolute !== false;
      window.dispatchEvent(
        new DeviceOrientationEvent(absolute ? 'deviceorientationabsolute' : 'deviceorientation', {
          alpha: sample.alpha,
          beta: sample.beta,
          gamma: sample.gamma,
          absolute,
        }),
      );
    }, 100);
  });
}

async function setOrientation(page: Page, sample: FakeOrientation | null): Promise<void> {
  await page.evaluate((next) => {
    window.__fakeOrientation = next;
  }, sample);
}

async function arMode(page: Page): Promise<string> {
  return (await debugState(page)).ar.mode;
}

/**
 * The vertical field the sky camera renders for a `w x h` frame shown `object-fit: cover` in a
 * `W x H` box at the diagonal `diagonalDeg` (plan D123; the one-line formula of
 * `sky/math/cameraFov.ts::visibleVerticalFovDeg`, restated here because the specs import
 * nothing from `src/` but the hook's type).
 */
function expectedVerticalFovDeg(
  diagonalDeg: number,
  w: number,
  h: number,
  W: number,
  H: number,
): number {
  const rows = Math.min(h, (w * H) / W);
  return (2 * Math.atan((Math.tan((diagonalDeg / 2) * DEG) * rows) / Math.hypot(w, h))) / DEG;
}

function param(page: Page, key: string): string | null {
  return new URL(page.url()).searchParams.get(key);
}

/** The camera video of the underlay: the one `<video>` under the sky stage. */
function video(page: Page) {
  return page.locator('#sky-stage video');
}

test('sensor mode: lazy chunks, camera, pose, calibration, field, badge, degradation, exit', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  const lazy = collectAssetRequests(page, LAZY_CHUNKS);
  await installFakeSensors(page);
  await page.goto(appUrl('webgl2', false));
  await waitReady(page);

  await test.step('before the tap no AR, XR or WebGPU chunk was requested and the gate holds', async () => {
    expect(lazy).toEqual([]);
    const state = await debugState(page);
    expect(state.ar.mode).toBe('off');
    expect(state.ar.transparent).toBe(false);
    // The probe's `enumerateDevices()` resolves after ready: poll the two gate bits.
    await expect
      .poll(async () => (await debugState(page)).ar.capabilities?.touch ?? null)
      .toBe(true);
    await expect
      .poll(async () => (await debugState(page)).ar.capabilities?.videoInput ?? null)
      .toBe(true);
  });

  const arButton = page.getByRole('button', { name: 'Augmented reality' });
  const exitButton = page.getByRole('button', { name: 'Exit augmented reality' });

  await test.step('the tap loads the controller and the overlay, then enters the sensor mode', async () => {
    await expect(arButton).toBeVisible();
    await arButton.tap();
    // The pose the fixture pins: upright, screen top toward the zenith, looking east.
    await setOrientation(page, { alpha: 270, beta: 90, gamma: 0 });
    await expect.poll(() => arMode(page), { timeout: 30_000 }).toBe('sensor');
    expect(lazy.some((url) => url.includes('/arController-'))).toBe(true);
    expect(lazy.some((url) => url.includes('/ArOverlay-'))).toBe(true);
    await expect(exitButton).toBeFocused();
    await expect(
      page.getByRole('banner').getByRole('button', { name: 'Exit augmented reality' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'About InterSidera' })).toHaveCount(0);
    await expect(page.getByRole('status', { name: 'Augmented reality status' })).toHaveText(
      /Augmented reality on/,
    );
  });

  await test.step('the camera video plays in the underlay before the canvas, muted and inline', async () => {
    await expect(video(page)).toBeVisible();
    await expect
      .poll(() => video(page).evaluate((el: HTMLVideoElement) => el.readyState), {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(2);
    const facts = await video(page).evaluate((el: HTMLVideoElement) => {
      const stream = el.srcObject instanceof MediaStream ? el.srcObject : null;
      const track = stream?.getVideoTracks()[0];
      const canvas = document.querySelector('canvas');
      return {
        videoWidth: el.videoWidth,
        videoHeight: el.videoHeight,
        muted: el.muted,
        playsInline: el.playsInline,
        paused: el.paused,
        streamActive: stream?.active ?? null,
        trackState: track?.readyState ?? null,
        precedesCanvas:
          canvas !== null &&
          (el.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      };
    });
    // Never hardcode the fake size: 1280x720 on the headless shell, 640x480 on full Chromium (R92).
    expect(facts.videoWidth).toBeGreaterThan(0);
    expect(facts.videoHeight).toBeGreaterThan(0);
    expect(facts.muted).toBe(true);
    expect(facts.playsInline).toBe(true);
    expect(facts.paused).toBe(false);
    expect(facts.streamActive).toBe(true);
    expect(facts.trackState).toBe('live');
    expect(facts.precedesCanvas).toBe(true);
    const hookVideo = await page.evaluate(() => window.__sky?.arVideo() ?? null);
    expect(hookVideo?.width).toBe(facts.videoWidth);
    expect(hookVideo?.height).toBe(facts.videoHeight);
    const state = await debugState(page);
    expect(state.ar.frame).toEqual({ width: facts.videoWidth, height: facts.videoHeight });
  });

  await test.step('the scene clears transparent: the test pattern shows through the canvas', async () => {
    expect((await debugState(page)).ar.transparent).toBe(true);
    // `skyBrightness() === 0` is vacuous under appUrl's `atm=0`; the pixel probe is the proof.
    await expect
      .poll(async () => (await centrePatch(page)).max, { timeout: 10_000 })
      .toBeGreaterThan(40);
  });

  await test.step('the synthetic pose drives the view: alpha 270, beta 90 looks east at the horizon', async () => {
    await expect
      .poll(async () => Math.abs((await debugState(page)).view.az - 90), { timeout: 10_000 })
      .toBeLessThan(1);
    expect(Math.abs((await debugState(page)).view.alt)).toBeLessThan(1);
    const heading = (await debugState(page)).ar.heading;
    expect(heading.source).toBe('absolute');
    expect(heading.level).toBe('good');
    await expect(page.getByRole('status', { name: 'Compass' })).toHaveText(/Compass heading/);
    // A second triple moves the mirror: upright looking south.
    await setOrientation(page, { alpha: 180, beta: 90, gamma: 0 });
    await expect
      .poll(async () => Math.abs((await debugState(page)).view.az - 180), { timeout: 10_000 })
      .toBeLessThan(1);
  });

  await test.step('axe: the AR overlay in the sensor mode', async () => {
    await expectNoAxeViolations(page, 'AR overlay, sensor mode');
  });

  await test.step('a horizontal drag calibrates the azimuth offset (AR-3) and the reset clears it', async () => {
    const box = await canvasBox(page);
    const before = await debugState(page);
    expect(before.ar.azOffsetDeg).toBe(0);
    const dx = 100;
    const x0 = box.width / 2 - dx / 2;
    const y0 = box.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + dx, y0, { steps: 10 });
    await page.mouse.up();
    // frames.ts::dragDeltaDeg(dx, fov, height) = -dx * fov / height.
    const expected = (-dx * before.view.fov) / box.height;
    await expect
      .poll(async () => (await debugState(page)).ar.azOffsetDeg, { timeout: 5000 })
      .toBeCloseTo(expected, 0);
    const after = await debugState(page);
    expect(Math.abs(after.ar.azOffsetDeg - expected)).toBeLessThan(1);
    expect(Math.abs(after.view.alt)).toBeLessThan(1);
    await expect(page.getByText(/^Azimuth offset/)).toBeVisible();
    // The pose follows: sensor azimuth plus the offset.
    await expect
      .poll(async () => Math.abs((await debugState(page)).view.az - (180 + expected)), {
        timeout: 5000,
      })
      .toBeLessThan(1);
    await page.getByRole('button', { name: 'Reset the alignment' }).tap();
    await expect
      .poll(async () => (await debugState(page)).ar.azOffsetDeg, { timeout: 5000 })
      .toBe(0);
  });

  await test.step('the 1° nudges turn the sky like the drag does, without dragging (SC 2.5.7)', async () => {
    // "Turn the sky right" moves the drawn sky right on screen, as a rightward drag does: the
    // view turns left, so the offset decreases by one degree (`dragDeltaDeg`); "left" adds one.
    const offset = async (): Promise<number> => (await debugState(page)).ar.azOffsetDeg;
    await page.getByRole('button', { name: 'Turn the sky 1° right' }).tap();
    await expect.poll(offset, { timeout: 5000 }).toBeCloseTo(-1, 6);
    await expect(page.getByText('Azimuth offset -1°')).toBeVisible();
    // The pose follows: the sensor looks south (180) and the view reads 179.
    await expect
      .poll(async () => Math.abs((await debugState(page)).view.az - 179), { timeout: 5000 })
      .toBeLessThan(0.5);
    const left = page.getByRole('button', { name: 'Turn the sky 1° left' });
    await left.tap();
    await left.tap();
    await expect.poll(offset, { timeout: 5000 }).toBeCloseTo(1, 6);
    await expect(page.getByText('Azimuth offset 1°')).toBeVisible();
    await expect
      .poll(async () => Math.abs((await debugState(page)).view.az - 181), { timeout: 5000 })
      .toBeLessThan(0.5);
    await page.getByRole('button', { name: 'Reset the alignment' }).tap();
    await expect.poll(offset, { timeout: 5000 }).toBe(0);
  });

  await test.step('the camera-field slider drives view.fov through the cover model and reaches the URL', async () => {
    const slider = page.getByRole('slider', { name: 'Camera field of view' });
    await expect(slider).toHaveValue('73');
    // The keyboard, not `fill()`: Playwright assigns `input.value` (through React's value-tracker
    // setter) before dispatching `input`, so React's `onChange` would see no change. Home jumps
    // the native range to its minimum, 50 degrees, and the browser fires the events itself.
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(slider).toHaveValue('50');
    await expect.poll(async () => (await debugState(page)).ar.cameraFovDeg).toBe(50);
    const frame = await page.evaluate(() => window.__sky?.arVideo() ?? null);
    if (frame === null) {
      throw new Error('arVideo(): the hook answered null');
    }
    const box = await canvasBox(page);
    const expected = expectedVerticalFovDeg(50, frame.width, frame.height, box.width, box.height);
    await expect
      .poll(async () => Math.abs((await debugState(page)).view.fov - expected), { timeout: 5000 })
      .toBeLessThan(0.1);
    // Numerically, never as a string: `url.ts` rounds `fov` to 0.1 degree, this spec's
    // `boundingBox()` may be fractional where the engine reads integer `clientWidth`/`clientHeight`,
    // and the poll above allows 0.1 degree between the two, so the bound is 0.05 + 0.1.
    await expect
      .poll(
        () => {
          const raw = param(page, 'fov');
          return raw === null ? null : Math.abs(Number(raw) - expected);
        },
        { timeout: 3000 },
      )
      .toBeLessThanOrEqual(0.15);
  });

  await test.step('the time-offset badge names a paused sky and disappears in live mode', async () => {
    await page.evaluate((tt) => {
      window.__sky?.setTime(tt);
    }, TT_FIXED);
    const badge = page.getByRole('status', { name: 'Time offset from now' });
    await expect(badge).toBeVisible();
    // TT_FIXED is April 2024: years lead, behind now.
    await expect(badge).toHaveText(/^[+−]\d+ yr/);
    await page.evaluate(() => {
      window.__sky?.live();
    });
    await expect(badge).toHaveCount(0);
  });

  await test.step('a relative-only stream downgrades to a manual north with the hint', async () => {
    await setOrientation(page, { alpha: 270, beta: 90, gamma: 0, absolute: false });
    await expect
      .poll(async () => (await debugState(page)).ar.heading.level, { timeout: 10_000 })
      .toBe('manual');
    expect((await debugState(page)).ar.heading.source).toBe('relative');
    await expect(page.getByRole('status', { name: 'Compass' })).toHaveText(/No compass/);
    await expect(page.getByRole('status', { name: 'Align the sky' })).toHaveText(
      /point the phone north/,
    );
    await expectNoAxeViolations(page, 'AR overlay, manual-north hint');
  });

  await test.step('three seconds without a sample end the session with a message (AR-5)', async () => {
    await setOrientation(page, null);
    await expect
      .poll(async () => (await debugState(page)).ar.error, { timeout: 15_000 })
      .toBe('orientationUnavailable');
    expect(await arMode(page)).toBe('off');
    const alert = page.getByRole('alert', { name: 'Augmented reality unavailable' });
    await expect(alert).toHaveText(/No orientation sensor answered/);
    await expect(video(page)).toHaveCount(0);
    await expect(arButton).toBeFocused();
    await alert.getByRole('button', { name: 'Dismiss' }).tap();
    await expect(alert).toHaveCount(0);
    expect((await debugState(page)).ar.error).toBeNull();
  });

  await test.step('re-entry, then Escape leaves AR: tracks stopped, view restored, focus returned', async () => {
    await arButton.tap();
    await setOrientation(page, { alpha: 270, beta: 90, gamma: 0 });
    await expect.poll(() => arMode(page), { timeout: 30_000 }).toBe('sensor');
    await expect(exitButton).toBeFocused();
    await expect(video(page)).toBeVisible();
    const track = await video(page).evaluateHandle((el: HTMLVideoElement) => {
      const stream = el.srcObject instanceof MediaStream ? el.srcObject : null;
      const first = stream?.getVideoTracks()[0];
      if (first === undefined) {
        throw new Error('no video track');
      }
      return first;
    });
    // The shortcuts bail on a focused control: move the focus off the exit button first.
    await blurActiveElement(page);
    await page.keyboard.press('Escape');
    await expect.poll(() => arMode(page), { timeout: 10_000 }).toBe('off');
    await expect(video(page)).toHaveCount(0);
    await expect.poll(() => track.evaluate((t) => t.readyState)).toBe('ended');
    const state = await debugState(page);
    expect(state.ar.transparent).toBe(false);
    expect(state.ar.roll).toBe(0);
    expect(state.ar.frame).toBeNull();
    // The field the URL carried before entry (appUrl's fov=60) is back; the direction is kept.
    expect(Math.abs(state.view.fov - 60)).toBeLessThan(1e-6);
    await expect(page.getByRole('button', { name: 'About InterSidera' })).toBeVisible();
    await expect(arButton).toBeFocused();
    // The camera controller is back in the view mode: a drag moves the azimuth.
    const box = await canvasBox(page);
    const azBefore = state.view.az;
    await page.mouse.move(box.width / 2, box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.width / 2 + 80, box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => Math.abs((await debugState(page)).view.az - azBefore), { timeout: 5000 })
      .toBeGreaterThan(1);
  });

  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test('a refused or missing camera returns to the normal view with one message (AR-5)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  await installFakeSensors(page);
  await page.addInitScript(() => {
    // The fake-UI flag auto-accepts prompts, so a denial cannot come from `permissions`; the
    // stubs replace `getUserMedia`. The first one never settles, so the transient `requesting`
    // state of plan D134 (tap -> `requesting` -> `sensor`) stays observable until Cancel.
    navigator.mediaDevices.getUserMedia = () => new Promise<MediaStream>(() => undefined);
  });
  await page.goto(appUrl('webgl2', false));
  await waitReady(page);
  const arButton = page.getByRole('button', { name: 'Augmented reality' });
  const alert = page.getByRole('alert', { name: 'Augmented reality unavailable' });

  await test.step('while the camera prompt is pending, the requesting banner explains and Cancel leaves', async () => {
    await arButton.tap();
    const requesting = page.getByRole('status', { name: 'Starting augmented reality' });
    await expect(requesting).toBeVisible({ timeout: 30_000 });
    await expect(requesting).toHaveText(/Allow the camera and the motion sensors/);
    expect(await arMode(page)).toBe('requesting');
    await expect(page.getByRole('button', { name: 'Exit augmented reality' })).toBeFocused();
    await expect(video(page)).toHaveCount(0);
    await expectNoAxeViolations(page, 'AR overlay, requesting');
    await requesting.getByRole('button', { name: 'Cancel' }).tap();
    await expect.poll(() => arMode(page), { timeout: 10_000 }).toBe('off');
    await expect(requesting).toHaveCount(0);
    await expect(video(page)).toHaveCount(0);
    expect((await debugState(page)).ar.error).toBeNull();
    await expect(page.getByRole('button', { name: 'About InterSidera' })).toBeVisible();
    await expect(arButton).toBeFocused();
  });

  await test.step('a denied camera', async () => {
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await arButton.tap();
    await setOrientation(page, { alpha: 270, beta: 90, gamma: 0 });
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toHaveText(/Camera access was denied/);
    expect(await arMode(page)).toBe('off');
    expect((await debugState(page)).ar.error).toBe('cameraDenied');
    await expect(video(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'About InterSidera' })).toBeVisible();
    await alert.getByRole('button', { name: 'Dismiss' }).tap();
    await expect(alert).toHaveCount(0);
    expect((await debugState(page)).ar.error).toBeNull();
  });

  await test.step('no camera at all', async () => {
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('none', 'NotFoundError'));
    });
    await arButton.tap();
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toHaveText(/No camera was found/);
    expect((await debugState(page)).ar.error).toBe('noCamera');
    expect(await arMode(page)).toBe('off');
  });

  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test('WebXR: a supported probe offers the switch, a refused session falls back to the sensor mode', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  const lazy = collectAssetRequests(page, LAZY_CHUNKS);
  await installFakeSensors(page);
  await page.addInitScript(() => {
    // `navigator.xr` must stay present (Babylon's CreateAsync logs console.error without it);
    // the session request fails the way a phone without Google Play Services for AR does.
    Object.defineProperty(navigator, 'xr', {
      configurable: true,
      value: {
        isSessionSupported: () => Promise.resolve(true),
        requestSession: () => Promise.reject(new DOMException('no ARCore', 'NotSupportedError')),
      },
    });
  });
  await page.goto(appUrl('webgl2', false));
  await waitReady(page);

  const xrButton = page.getByRole('button', { name: 'Immersive mode (WebXR)' });
  await test.step('the switch appears in the sensor mode; no XR chunk was requested before entry', async () => {
    expect(lazy.filter((url) => url.includes('/XrBridge-'))).toEqual([]);
    await page.getByRole('button', { name: 'Augmented reality' }).tap();
    await setOrientation(page, { alpha: 270, beta: 90, gamma: 0 });
    await expect.poll(() => arMode(page), { timeout: 30_000 }).toBe('sensor');
    await expect
      .poll(async () => (await debugState(page)).ar.xr.support, { timeout: 10_000 })
      .toBe('supported');
    await expect(xrButton).toBeVisible();
  });

  await test.step('a refused session reports xrUnsupported and keeps the sensor mode', async () => {
    await xrButton.tap();
    await expect
      .poll(async () => (await debugState(page)).ar.error, { timeout: 30_000 })
      .toBe('xrUnsupported');
    expect(await arMode(page)).toBe('sensor');
    expect((await debugState(page)).ar.xr.phase).toBe('idle');
    const alert = page.getByRole('alert', { name: 'Augmented reality unavailable' });
    await expect(alert).toHaveText(/Google Play Services for AR/);
    // The engine still resolves directions: Polaris stands at the latitude from Greenwich.
    const polaris = await page.evaluate(() => window.__sky?.altAzOf('hip:11767') ?? null);
    if (polaris === null) {
      throw new Error('altAzOf(hip:11767): the hook answered null');
    }
    expect(Math.abs(polaris.alt - 51.48)).toBeLessThan(1);
    await expect(video(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exit augmented reality' })).toBeVisible();
  });

  expect(foreign).toEqual([]);
  // Babylon's WebXR entry may `console.warn` (makeXRCompatible, the dom-overlay note); an
  // `error` line would fail here.
  expect(errors).toEqual([]);
});

test('WebXR: an unsupported probe offers no switch', async ({ page }) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  await installFakeSensors(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'xr', {
      configurable: true,
      value: {
        isSessionSupported: () => Promise.resolve(false),
        requestSession: () => Promise.reject(new DOMException('never', 'NotSupportedError')),
      },
    });
  });
  await page.goto(appUrl('webgl2', false));
  await waitReady(page);
  await page.getByRole('button', { name: 'Augmented reality' }).tap();
  await setOrientation(page, { alpha: 270, beta: 90, gamma: 0 });
  await expect.poll(() => arMode(page), { timeout: 30_000 }).toBe('sensor');
  await expect
    .poll(async () => (await debugState(page)).ar.xr.support, { timeout: 10_000 })
    .toBe('unsupported');
  await expect(page.getByRole('button', { name: 'Immersive mode (WebXR)' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Exit augmented reality' })).toBeVisible();
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});
