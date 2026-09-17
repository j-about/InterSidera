import type { Mock } from 'vitest';

import {
  CAMERA_CONSTRAINTS,
  CameraVideoFailure,
  classifyMediaError,
  startCameraVideo,
} from './cameraVideo';
import type { CameraVideo, CameraVideoDeps } from './cameraVideo';

// The camera video of plan D121 under jsdom with a fake `getUserMedia`, a duck-typed stream and
// track, a fake document/window (jsdom's `visibilityState` is read-only and its `play()` returns
// undefined, so the element is injected): the constraints, the element's attributes, the rear
// check, every rejection name, the frame size after metadata and on resize, the three ways a
// session ends (hidden, pagehide, track ended), the replay of an end that preceded the handle
// (the page hidden during or before `play()`, a track lost during it), mute reports, the
// idempotent stop and the abort.

interface FakeTrack {
  track: MediaStreamTrack;
  stop: Mock<() => void>;
  target: EventTarget;
}

function fakeTrack(settings: MediaTrackSettings = { facingMode: 'environment' }): FakeTrack {
  const target = new EventTarget();
  const stop = vi.fn<() => void>();
  const track = {
    kind: 'video',
    readyState: 'live',
    getSettings: () => settings,
    stop,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as MediaStreamTrack;
  return { track, stop, target };
}

function fakeStream(tracks: readonly MediaStreamTrack[]): MediaStream {
  return {
    active: true,
    getTracks: () => [...tracks],
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
}

interface FakeVideo {
  video: HTMLVideoElement;
  play: Mock<() => Promise<void>>;
  setSize(width: number, height: number): void;
}

function fakeVideo(
  play: () => Promise<void> = () => Promise.resolve(),
  size: [number, number] = [1280, 720],
): FakeVideo {
  const video = document.createElement('video');
  const playMock = vi.fn(play);
  let [width, height] = size;
  Object.defineProperty(video, 'play', { value: playMock, configurable: true });
  Object.defineProperty(video, 'videoWidth', { get: () => width, configurable: true });
  Object.defineProperty(video, 'videoHeight', { get: () => height, configurable: true });
  return {
    video,
    play: playMock,
    setSize(w, h) {
      width = w;
      height = h;
    },
  };
}

interface FakePage {
  document: NonNullable<CameraVideoDeps['document']>;
  window: NonNullable<CameraVideoDeps['window']>;
  hide(): void;
  show(): void;
  pageHide(): void;
}

function fakePage(): FakePage {
  const doc = new EventTarget();
  const win = new EventTarget();
  let visibility: DocumentVisibilityState = 'visible';
  return {
    document: {
      get visibilityState() {
        return visibility;
      },
      addEventListener: doc.addEventListener.bind(doc),
      removeEventListener: doc.removeEventListener.bind(doc),
    },
    window: {
      addEventListener: win.addEventListener.bind(win),
      removeEventListener: win.removeEventListener.bind(win),
    },
    hide() {
      visibility = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    show() {
      visibility = 'visible';
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    pageHide() {
      win.dispatchEvent(new Event('pagehide'));
    },
  };
}

interface Rig {
  root: HTMLElement;
  deps: CameraVideoDeps;
  getUserMedia: Mock<MediaDevices['getUserMedia']>;
  track: FakeTrack;
  video: FakeVideo;
  page: FakePage;
  createVideo: Mock<() => HTMLVideoElement>;
}

function rig(
  options: { track?: FakeTrack; video?: FakeVideo; tracks?: MediaStreamTrack[] } = {},
): Rig {
  const track = options.track ?? fakeTrack();
  const video = options.video ?? fakeVideo();
  const page = fakePage();
  const stream = fakeStream(options.tracks ?? [track.track]);
  const getUserMedia = vi.fn<MediaDevices['getUserMedia']>(() => Promise.resolve(stream));
  const createVideo = vi.fn(() => video.video);
  const root = document.createElement('div');
  document.body.append(root);
  return {
    root,
    deps: {
      mediaDevices: { getUserMedia },
      createVideo,
      document: page.document,
      window: page.window,
    },
    getUserMedia,
    track,
    video,
    page,
    createVideo,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<CameraVideoFailure> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof CameraVideoFailure) {
      return error;
    }
    throw new Error(`not a CameraVideoFailure: ${String(error)}`, { cause: error });
  }
  throw new Error('resolved');
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('classifyMediaError', () => {
  it.each([
    ['NotAllowedError', 'cameraDenied'],
    ['SecurityError', 'cameraDenied'],
    ['NotFoundError', 'noCamera'],
    ['OverconstrainedError', 'noCamera'],
    ['NotReadableError', 'cameraUnavailable'],
    ['AbortError', 'cameraUnavailable'],
    ['NotSupportedError', 'cameraUnavailable'],
    ['SomethingElse', 'cameraUnavailable'],
  ] as const)('%s -> %s', (name, code) => {
    expect(classifyMediaError(new DOMException('x', name))).toBe(code);
  });

  it('reads unknown shapes as unavailable', () => {
    expect(classifyMediaError(new TypeError('bad constraints'))).toBe('cameraUnavailable');
    expect(classifyMediaError('NotAllowedError')).toBe('cameraUnavailable');
    expect(classifyMediaError(null)).toBe('cameraUnavailable');
    expect(classifyMediaError({ name: 42 })).toBe('cameraUnavailable');
    expect(classifyMediaError({ name: 'NotFoundError' })).toBe('noCamera');
  });
});

describe('startCameraVideo', () => {
  it('requests the rear camera, plays a muted inline video in the root and reports the frame size', async () => {
    const r = rig();
    const cam = await startCameraVideo(r.root, r.deps, new AbortController().signal);
    expect(r.getUserMedia).toHaveBeenCalledTimes(1);
    expect(r.getUserMedia).toHaveBeenCalledWith(CAMERA_CONSTRAINTS);
    expect(CAMERA_CONSTRAINTS).toEqual({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    const { video } = cam;
    expect(video).toBe(r.video.video);
    expect(r.root.firstElementChild).toBe(video);
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.autoplay).toBe(true);
    for (const attr of [
      'autoplay',
      'muted',
      'playsinline',
      'disablepictureinpicture',
      'disableremoteplayback',
    ]) {
      expect(video.hasAttribute(attr)).toBe(true);
    }
    expect(video.getAttribute('aria-hidden')).toBe('true');
    expect(video.className).toBe('h-full w-full object-cover');
    expect(video.srcObject).not.toBeNull();
    expect(r.video.play).toHaveBeenCalledTimes(1);
    expect(cam.facingMode).toBe('environment');
    // The size was known after play(): a late listener receives it at once.
    const sizes: [number, number][] = [];
    const off = cam.onFrameSize((w, h) => sizes.push([w, h]));
    expect(sizes).toEqual([[1280, 720]]);
    off();
    r.video.setSize(720, 1280);
    video.dispatchEvent(new Event('resize'));
    expect(sizes).toHaveLength(1);
    cam.stop();
  });

  it('accepts an unknown facing mode and refuses the front camera with the tracks stopped', async () => {
    const unknown = rig({ track: fakeTrack({}) });
    const cam = await startCameraVideo(unknown.root, unknown.deps, new AbortController().signal);
    expect(cam.facingMode).toBeNull();
    cam.stop();

    const front = rig({ track: fakeTrack({ facingMode: 'user' }) });
    const failure = await failureOf(
      startCameraVideo(front.root, front.deps, new AbortController().signal),
    );
    expect(failure.code).toBe('noRearCamera');
    expect(failure.name).toBe('CameraVideoFailure');
    expect(front.track.stop).toHaveBeenCalledTimes(1);
    expect(front.createVideo).not.toHaveBeenCalled();
    expect(front.root.childElementCount).toBe(0);
  });

  it('maps the getUserMedia rejections and a missing mediaDevices', async () => {
    const cases = [
      ['NotAllowedError', 'cameraDenied'],
      ['SecurityError', 'cameraDenied'],
      ['NotFoundError', 'noCamera'],
      ['OverconstrainedError', 'noCamera'],
      ['NotReadableError', 'cameraUnavailable'],
      ['AbortError', 'cameraUnavailable'],
      ['NotSupportedError', 'cameraUnavailable'],
    ] as const;
    for (const [name, code] of cases) {
      const r = rig();
      const cause = new DOMException(name, name);
      r.getUserMedia.mockImplementation(() => Promise.reject(cause));
      const failure = await failureOf(
        startCameraVideo(r.root, r.deps, new AbortController().signal),
      );
      expect(failure.code).toBe(code);
      expect(failure.cause).toBe(cause);
      expect(r.createVideo).not.toHaveBeenCalled();
    }
    const r = rig();
    r.getUserMedia.mockImplementation(() => Promise.reject(new TypeError('x')));
    expect(
      (await failureOf(startCameraVideo(r.root, r.deps, new AbortController().signal))).code,
    ).toBe('cameraUnavailable');
    const none = rig();
    const failure = await failureOf(
      startCameraVideo(
        none.root,
        { ...none.deps, mediaDevices: undefined },
        new AbortController().signal,
      ),
    );
    expect(failure.code).toBe('cameraUnavailable');
    expect(none.getUserMedia).not.toHaveBeenCalled();
  });

  it('reads a stream without a video track and a refused play() as unavailable, releasing everything', async () => {
    const empty = rig({ tracks: [] });
    const noTrack = await failureOf(
      startCameraVideo(empty.root, empty.deps, new AbortController().signal),
    );
    expect(noTrack.code).toBe('cameraUnavailable');
    expect(empty.createVideo).not.toHaveBeenCalled();

    const refusing = fakeVideo(() => Promise.reject(new DOMException('no', 'NotAllowedError')));
    const r = rig({ video: refusing });
    const failure = await failureOf(startCameraVideo(r.root, r.deps, new AbortController().signal));
    expect(failure.code).toBe('cameraUnavailable');
    expect(r.track.stop).toHaveBeenCalledTimes(1);
    expect(refusing.video.srcObject).toBeNull();
    expect(r.root.childElementCount).toBe(0);
  });

  it('waits for a non-zero size after loadedmetadata and follows resize', async () => {
    const lazy = fakeVideo(undefined, [0, 0]);
    const r = rig({ video: lazy });
    const cam = await startCameraVideo(r.root, r.deps, new AbortController().signal);
    const sizes: [number, number][] = [];
    cam.onFrameSize((w, h) => sizes.push([w, h]));
    expect(sizes).toEqual([]);
    lazy.video.dispatchEvent(new Event('loadedmetadata'));
    expect(sizes).toEqual([]);
    lazy.setSize(640, 480);
    lazy.video.dispatchEvent(new Event('loadedmetadata'));
    expect(sizes).toEqual([[640, 480]]);
    lazy.video.dispatchEvent(new Event('resize'));
    expect(sizes).toHaveLength(1);
    lazy.setSize(480, 640);
    lazy.video.dispatchEvent(new Event('resize'));
    expect(sizes).toEqual([
      [640, 480],
      [480, 640],
    ]);
    cam.stop();
  });

  it('stops and reports hidden when the page is hidden, then ignores everything', async () => {
    const r = rig();
    const cam = await startCameraVideo(r.root, r.deps, new AbortController().signal);
    const reasons: string[] = [];
    cam.onEnded((reason) => reasons.push(reason));
    r.page.show();
    expect(reasons).toEqual([]);
    r.page.hide();
    expect(reasons).toEqual(['hidden']);
    expect(r.track.stop).toHaveBeenCalledTimes(1);
    expect(cam.video.srcObject).toBeNull();
    expect(r.root.childElementCount).toBe(0);
    // Already stopped: no second report, no second stop.
    r.page.hide();
    r.track.target.dispatchEvent(new Event('ended'));
    cam.stop();
    expect(reasons).toEqual(['hidden']);
    expect(r.track.stop).toHaveBeenCalledTimes(1);
  });

  it('stops on pagehide and on a track that ended', async () => {
    const a = rig();
    const camA = await startCameraVideo(a.root, a.deps, new AbortController().signal);
    const reasonsA: string[] = [];
    camA.onEnded((reason) => reasonsA.push(reason));
    a.page.pageHide();
    expect(reasonsA).toEqual(['hidden']);
    expect(a.track.stop).toHaveBeenCalledTimes(1);

    const b = rig();
    const camB = await startCameraVideo(b.root, b.deps, new AbortController().signal);
    const reasonsB: string[] = [];
    const off = camB.onEnded((reason) => reasonsB.push(reason));
    const late: string[] = [];
    camB.onEnded((reason) => late.push(reason));
    off();
    b.track.target.dispatchEvent(new Event('ended'));
    expect(reasonsB).toEqual([]);
    expect(late).toEqual(['trackEnded']);
    expect(b.track.stop).toHaveBeenCalledTimes(1);
    expect(b.root.childElementCount).toBe(0);
  });

  it('replays an end that preceded the handle: the page hidden during play() or before it', async () => {
    // Hidden while `play()` was pending: the listener stopped the stream; the handle replays it.
    const during = rig();
    during.video.play.mockImplementation(() => {
      during.page.hide();
      return Promise.resolve();
    });
    const cam = await startCameraVideo(during.root, during.deps, new AbortController().signal);
    expect(during.video.play).toHaveBeenCalledTimes(1);
    expect(during.track.stop).toHaveBeenCalledTimes(1);
    expect(during.root.childElementCount).toBe(0);
    expect(cam.video.srcObject).toBeNull();
    const reasons: string[] = [];
    const off = cam.onEnded((reason) => reasons.push(reason));
    expect(reasons).toEqual(['hidden']);
    const again: string[] = [];
    cam.onEnded((reason) => again.push(reason));
    expect(again).toEqual(['hidden']);
    off();
    // Nothing was read after the end: a late frame-size listener stays silent.
    const sizes: number[] = [];
    cam.onFrameSize((w) => sizes.push(w));
    expect(sizes).toEqual([]);
    cam.stop();
    expect(during.track.stop).toHaveBeenCalledTimes(1);

    // `play()` refused because the stream was already gone: still the handle, not a failure.
    const refused = rig();
    refused.video.play.mockImplementation(() => {
      refused.page.hide();
      return Promise.reject(new DOMException('gone', 'AbortError'));
    });
    const camRefused = await startCameraVideo(
      refused.root,
      refused.deps,
      new AbortController().signal,
    );
    const late: string[] = [];
    camRefused.onEnded((reason) => late.push(reason));
    expect(late).toEqual(['hidden']);
    expect(refused.track.stop).toHaveBeenCalledTimes(1);
    expect(refused.root.childElementCount).toBe(0);

    // Already hidden when the stream resolved (backgrounded during the prompt): no `play()`.
    const before = rig();
    before.page.hide();
    const camBefore = await startCameraVideo(
      before.root,
      before.deps,
      new AbortController().signal,
    );
    expect(before.video.play).not.toHaveBeenCalled();
    expect(before.track.stop).toHaveBeenCalledTimes(1);
    expect(before.root.childElementCount).toBe(0);
    expect(camBefore.video.srcObject).toBeNull();
    const early: string[] = [];
    camBefore.onEnded((reason) => early.push(reason));
    expect(early).toEqual(['hidden']);
  });

  it('replays a track that ended while play() was pending', async () => {
    const r = rig();
    r.video.play.mockImplementation(() => {
      r.track.target.dispatchEvent(new Event('ended'));
      return Promise.resolve();
    });
    const cam = await startCameraVideo(r.root, r.deps, new AbortController().signal);
    expect(r.track.stop).toHaveBeenCalledTimes(1);
    const reasons: string[] = [];
    cam.onEnded((reason) => reasons.push(reason));
    expect(reasons).toEqual(['trackEnded']);
    // A stop by the owner after the end: idempotent, no second report.
    cam.stop();
    r.page.hide();
    expect(r.track.stop).toHaveBeenCalledTimes(1);
    expect(reasons).toEqual(['trackEnded']);
  });

  it('reports mute and unmute without ending the session', async () => {
    const r = rig();
    const cam = await startCameraVideo(r.root, r.deps, new AbortController().signal);
    const muted: boolean[] = [];
    const off = cam.onMuted((m) => muted.push(m));
    r.track.target.dispatchEvent(new Event('mute'));
    r.track.target.dispatchEvent(new Event('unmute'));
    expect(muted).toEqual([true, false]);
    expect(r.track.stop).not.toHaveBeenCalled();
    expect(r.root.firstElementChild).toBe(cam.video);
    off();
    r.track.target.dispatchEvent(new Event('mute'));
    expect(muted).toHaveLength(2);
    cam.stop();
  });

  it('stop() is idempotent, removes the listeners and never reports an end', async () => {
    const r = rig();
    const cam = await startCameraVideo(r.root, r.deps, new AbortController().signal);
    const reasons: string[] = [];
    cam.onEnded((reason) => reasons.push(reason));
    const sizes: number[] = [];
    cam.onFrameSize((w) => sizes.push(w));
    cam.stop();
    cam.stop();
    expect(r.track.stop).toHaveBeenCalledTimes(1);
    expect(cam.video.srcObject).toBeNull();
    expect(cam.video.isConnected).toBe(false);
    r.page.hide();
    r.page.pageHide();
    r.track.target.dispatchEvent(new Event('ended'));
    r.video.setSize(100, 100);
    cam.video.dispatchEvent(new Event('resize'));
    expect(reasons).toEqual([]);
    expect(sizes).toEqual([1280]);
  });

  it('aborts: before the request, after the stream resolved, and after play()', async () => {
    const before = rig();
    const ctlBefore = new AbortController();
    ctlBefore.abort();
    await expect(
      startCameraVideo(before.root, before.deps, ctlBefore.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(before.getUserMedia).not.toHaveBeenCalled();

    const pending = rig();
    const ctl = new AbortController();
    let resolveStream: (s: MediaStream) => void = () => undefined;
    pending.getUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
        }),
    );
    const promise = startCameraVideo(pending.root, pending.deps, ctl.signal);
    expect(pending.getUserMedia).toHaveBeenCalledTimes(1);
    ctl.abort();
    resolveStream(fakeStream([pending.track.track]));
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(pending.track.stop).toHaveBeenCalledTimes(1);
    expect(pending.createVideo).not.toHaveBeenCalled();

    const during = rig();
    const ctlPlay = new AbortController();
    during.video.play.mockImplementation(() => {
      ctlPlay.abort();
      return Promise.resolve();
    });
    await expect(startCameraVideo(during.root, during.deps, ctlPlay.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(during.track.stop).toHaveBeenCalledTimes(1);
    expect(during.root.childElementCount).toBe(0);
  });

  it('exposes the playing element through the CameraVideo handle', async () => {
    const r = rig();
    const cam: CameraVideo = await startCameraVideo(r.root, r.deps, new AbortController().signal);
    expect(cam.video.isConnected).toBe(true);
    cam.stop();
    expect(cam.video.isConnected).toBe(false);
  });
});
