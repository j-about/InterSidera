// The AR camera video (AR-1, AR-2; brief l.238, l.547; plan D121). Part of the lazy AR chunk:
// Babylon-free, reached only through `sky/ar/arController.ts`. One `getUserMedia` stream per AR
// session (a second iOS request mutes the first for good) is shown by a DOM `<video autoplay
// muted playsinline>` appended into the engine's `underlayRoot`, the `aria-hidden` sibling
// rendered before the transparent canvas, so the stars are composited over the camera picture by
// the browser (no `VideoTexture`, no per-frame upload, no fourth shader pair). The rear camera is
// requested with `facingMode: { ideal: 'environment' }` and verified from the track settings after
// the fact (`'user'` is refused, `undefined` accepted: the fake device and some Android phones).
// The intrinsic frame size (`videoWidth` x `videoHeight`) feeds the field-of-view model
// (`sky/math/cameraFov.ts`) after `loadedmetadata` (a non-zero size, defensively) and on every
// `resize` (iOS swaps the dimensions on rotation). Every track is stopped and `srcObject` cleared
// on `stop()`, when the page is hidden or unloading and when the track ends; `mute`/`unmute` are
// reported and never end the session. An end that precedes the handle (the page hidden during the
// camera prompt or while `play()` was pending, a track lost meanwhile) is replayed to the first
// `onEnded` listener the way the frame size is, so the controller leaves AR before it starts the
// sensors; a page already hidden when the stream arrives never starts playing.

/** The AR-5 failure codes this module produces (a subset of `ArError`). */
export type CameraVideoError = 'noCamera' | 'noRearCamera' | 'cameraDenied' | 'cameraUnavailable';

export interface CameraVideoDeps {
  /** `navigator.mediaDevices` (absent in an insecure context; the AR-1 gate already refuses those). */
  mediaDevices: Pick<MediaDevices, 'getUserMedia'> | undefined;
  /** Default `document.createElement('video')`; tests inject an element whose `play()` is a promise. */
  createVideo?: () => HTMLVideoElement;
  /** Default `document` (the `visibilitychange` source). */
  document?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  /** Default `window` (the `pagehide` source). */
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface CameraVideo {
  /** The playing element, appended to the root until `stop()`. */
  readonly video: HTMLVideoElement;
  /** `track.getSettings().facingMode`, `null` when the platform reports none. */
  readonly facingMode: string | null;
  /**
   * The intrinsic frame size after `loadedmetadata` and on every `resize`; a listener registered
   * after the size is known receives it at once. Returns the unsubscribe.
   */
  onFrameSize(listener: (width: number, height: number) => void): () => void;
  /**
   * Fires once when the stream ends outside `stop()`: the track ended, or the page was hidden. A
   * listener registered after that end receives the reason at once (the end preceded the handle).
   */
  onEnded(listener: (reason: 'trackEnded' | 'hidden') => void): () => void;
  /** The track's `mute` / `unmute` (a paused camera, not an exit). */
  onMuted(listener: (muted: boolean) => void): () => void;
  /** Stop every track, clear `srcObject`, detach the element and the listeners; idempotent. */
  stop(): void;
}

/** The rejection of `startCameraVideo` for a camera failure (`code` is the AR-5 key). */
export class CameraVideoFailure extends Error {
  readonly code: CameraVideoError;

  constructor(code: CameraVideoError, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'CameraVideoFailure';
    this.code = code;
  }
}

/** The `getUserMedia` request of plan D121 (l.547): the rear camera, 720p preferred, no audio. */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  audio: false,
};

function errorName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return null;
  }
  const { name } = error;
  return typeof name === 'string' ? name : null;
}

/**
 * `getUserMedia` rejection -> AR-5 code (plan D121): a refused permission or a policy block reads
 * denied, a missing or unsatisfiable camera reads absent, everything else (`NotReadableError`,
 * `AbortError`, `NotSupportedError`, a `TypeError`, an unknown object) reads unavailable.
 */
export function classifyMediaError(error: unknown): CameraVideoError {
  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'cameraDenied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'noCamera';
    default:
      return 'cameraUnavailable';
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/** The rejection when `signal` aborted while the request was pending (the caller is gone). */
function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

/**
 * Request the rear camera, attach it to a `<video>` inside `root` and start playing. Rejects with
 * a `CameraVideoFailure` (its `code` is the AR-5 key) on every camera failure and with an
 * `AbortError` `DOMException` when `signal` aborted meanwhile (the stream is stopped first).
 */
export async function startCameraVideo(
  root: HTMLElement,
  deps: CameraVideoDeps,
  signal: AbortSignal,
): Promise<CameraVideo> {
  const aborted = (): boolean => signal.aborted;
  if (deps.mediaDevices === undefined) {
    throw new CameraVideoFailure('cameraUnavailable');
  }
  if (aborted()) {
    throw abortError();
  }
  let stream: MediaStream;
  try {
    stream = await deps.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
  } catch (error: unknown) {
    throw new CameraVideoFailure(classifyMediaError(error), error);
  }
  if (aborted()) {
    stopTracks(stream);
    throw abortError();
  }
  const track = stream.getVideoTracks()[0];
  if (track === undefined) {
    stopTracks(stream);
    throw new CameraVideoFailure('cameraUnavailable');
  }
  const facingMode = track.getSettings().facingMode ?? null;
  if (facingMode === 'user') {
    stopTracks(stream);
    throw new CameraVideoFailure('noRearCamera');
  }

  const doc = deps.document ?? document;
  const win = deps.window ?? window;
  const video =
    deps.createVideo === undefined ? document.createElement('video') : deps.createVideo();
  // Properties for the running element, attributes for the markup iOS and the e2e spec inspect.
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('autoplay', '');
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('disablepictureinpicture', '');
  video.setAttribute('disableremoteplayback', '');
  video.setAttribute('aria-hidden', 'true');
  video.className = 'h-full w-full object-cover';

  const frameListeners = new Set<(width: number, height: number) => void>();
  const endedListeners = new Set<(reason: 'trackEnded' | 'hidden') => void>();
  const mutedListeners = new Set<(muted: boolean) => void>();
  let width = 0;
  let height = 0;
  let stopped = false;
  /** Set by `end()`; replayed to a listener registered afterwards. Read through `ended()` below. */
  let endedReason: 'trackEnded' | 'hidden' | null = null;
  const ended = (): 'trackEnded' | 'hidden' | null => endedReason;

  const readSize = (): void => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w > 0 && h > 0 && (w !== width || h !== height)) {
      width = w;
      height = h;
      for (const listener of frameListeners) {
        listener(w, h);
      }
    }
  };
  const onMute = (): void => {
    for (const listener of mutedListeners) {
      listener(true);
    }
  };
  const onUnmute = (): void => {
    for (const listener of mutedListeners) {
      listener(false);
    }
  };
  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    video.removeEventListener('loadedmetadata', readSize);
    video.removeEventListener('resize', readSize);
    track.removeEventListener('ended', onTrackEnded);
    track.removeEventListener('mute', onMute);
    track.removeEventListener('unmute', onUnmute);
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', onPageHide);
    stopTracks(stream);
    video.srcObject = null;
    video.remove();
  };
  /** An end outside `stop()`: stop first (so the listeners see a clean state), then report once. */
  const end = (reason: 'trackEnded' | 'hidden'): void => {
    if (stopped) {
      return;
    }
    stop();
    endedReason = reason;
    for (const listener of endedListeners) {
      listener(reason);
    }
  };
  const onTrackEnded = (): void => {
    end('trackEnded');
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') {
      end('hidden');
    }
  };
  // `visibilitychange: hidden` precedes `pagehide`, so this is the fallback for a browser that
  // unloads or freezes the page without it (the session ends either way, silently).
  const onPageHide = (): void => {
    end('hidden');
  };

  video.addEventListener('loadedmetadata', readSize);
  video.addEventListener('resize', readSize);
  track.addEventListener('ended', onTrackEnded);
  track.addEventListener('mute', onMute);
  track.addEventListener('unmute', onUnmute);
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onPageHide);
  video.srcObject = stream;
  root.append(video);
  if (doc.visibilityState === 'hidden') {
    // The page went to the background during the camera prompt: the listener above never saw
    // that change, and a hidden page never starts a session (a camera running behind nothing).
    end('hidden');
  } else {
    try {
      await video.play();
    } catch (error: unknown) {
      if (ended() === null) {
        stop();
        throw new CameraVideoFailure('cameraUnavailable', error);
      }
      // The session ended while `play()` was pending (the page hidden or unloading, the track
      // gone) and the listener stopped everything: the handle below replays the reason.
    }
  }
  if (aborted()) {
    stop();
    throw abortError();
  }
  if (ended() === null) {
    // The metadata may already be there (a fake device, a fast phone): read once after `play()`.
    readSize();
  }

  return {
    video,
    facingMode,
    onFrameSize(listener) {
      frameListeners.add(listener);
      if (width > 0 && height > 0) {
        listener(width, height);
      }
      return () => {
        frameListeners.delete(listener);
      };
    },
    onEnded(listener) {
      if (endedReason !== null) {
        // The end preceded the registration: report it at once; nothing further will fire.
        listener(endedReason);
        return () => undefined;
      }
      endedListeners.add(listener);
      return () => {
        endedListeners.delete(listener);
      };
    },
    onMuted(listener) {
      mutedListeners.add(listener);
      return () => {
        mutedListeners.delete(listener);
      };
    },
    stop,
  };
}
