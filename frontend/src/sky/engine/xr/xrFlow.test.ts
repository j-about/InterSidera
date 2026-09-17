// The WebXR session flow of plan D128 against the real store under jsdom with a fake bridge:
// the entry from the sensor mode (phase entering -> active, mode xr), every failure shape mapped
// through `classifyXrFailure` (the sensor mode kept, one banner, `AbortError` silent), the state
// guards, an exit pressed during the entry, the user leaving AR while the browser starts the
// session, the session ending on its own (back gesture), the tick delegation and the disposal.

import type { Mock } from 'vitest';

import { createSkyStore } from '../../../state/store';
import type { SkyStore } from '../../../state/storeTypes';
import { XrUnavailableError } from '../../ar/webxr';
import { XrFlow } from './xrFlow';
import type { XrBridgeHooks, XrBridgeLike } from './xrFlow';

interface FakeBridge extends XrBridgeLike {
  enterMock: Mock<(overlay: HTMLElement) => Promise<void>>;
  exitMock: Mock<() => Promise<void>>;
  tickMock: Mock<() => void>;
  disposeMock: Mock<() => void>;
  /** Resolve or reject the pending `enter()`. */
  resolveEntry(): void;
  rejectEntry(error: unknown): void;
  /** Babylon's `onXRSessionEnded`. */
  endSession(): void;
}

function fakeBridge(hooksRef: { hooks: XrBridgeHooks | null }): FakeBridge {
  let pending: { resolve(): void; reject(error: unknown): void } | null = null;
  const enterMock = vi.fn<(overlay: HTMLElement) => Promise<void>>(
    () =>
      new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
      }),
  );
  const exitMock = vi.fn<() => Promise<void>>(() => {
    hooksRef.hooks?.onSessionEnded();
    return Promise.resolve();
  });
  const tickMock = vi.fn<() => void>();
  const disposeMock = vi.fn<() => void>();
  return {
    enter: enterMock,
    exit: exitMock,
    tick: tickMock,
    dispose: disposeMock,
    enterMock,
    exitMock,
    tickMock,
    disposeMock,
    resolveEntry() {
      if (pending === null) {
        throw new Error('no entry pending');
      }
      pending.resolve();
      pending = null;
    },
    rejectEntry(error) {
      if (pending === null) {
        throw new Error('no entry pending');
      }
      pending.reject(error);
      pending = null;
    },
    endSession() {
      hooksRef.hooks?.onSessionEnded();
    },
  };
}

interface Rig {
  store: SkyStore;
  flow: XrFlow;
  bridge: FakeBridge;
  createBridge: Mock<(hooks: XrBridgeHooks) => Promise<XrBridgeLike>>;
  onSessionEnded: Mock<() => void>;
  overlay: HTMLElement;
}

/** A store in the sensor mode with XR supported (the state the "Immersive mode" button needs). */
function sensorStore(): SkyStore {
  const store = createSkyStore({ az: 120, alt: 20, fov: 60 }, 1_757_000_000_000);
  const { actions } = store.getState();
  actions.requestAr();
  actions.setArMode('sensor');
  actions.setArXr({ support: 'supported' });
  return store;
}

function rig(options: { createFailure?: Error; store?: SkyStore } = {}): Rig {
  const store = options.store ?? sensorStore();
  const hooksRef: { hooks: XrBridgeHooks | null } = { hooks: null };
  const bridge = fakeBridge(hooksRef);
  const createBridge = vi.fn<(hooks: XrBridgeHooks) => Promise<XrBridgeLike>>((hooks) => {
    hooksRef.hooks = hooks;
    return options.createFailure === undefined
      ? Promise.resolve(bridge)
      : Promise.reject(options.createFailure);
  });
  const onSessionEnded = vi.fn<() => void>();
  const flow = new XrFlow({ store, createBridge, onSessionEnded });
  return {
    store,
    flow,
    bridge,
    createBridge,
    onSessionEnded,
    overlay: document.createElement('div'),
  };
}

function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('XrFlow entry (plan D128)', () => {
  it('enters from the sensor mode: entering while the bridge starts, then xr and active', async () => {
    const r = rig();
    const entry = r.flow.enter(r.overlay);
    expect(r.store.getState().ar.xr.phase).toBe('entering');
    await settle();
    expect(r.createBridge).toHaveBeenCalledTimes(1);
    expect(r.bridge.enterMock).toHaveBeenCalledWith(r.overlay);
    expect(r.store.getState().ar.mode).toBe('sensor');
    r.bridge.resolveEntry();
    await entry;
    const { ar } = r.store.getState();
    expect(ar.mode).toBe('xr');
    expect(ar.xr.phase).toBe('active');
    expect(ar.error).toBeNull();
    expect(r.flow.isActive).toBe(true);
  });

  it('creates the bridge once across sessions and delegates the tick to it', async () => {
    const r = rig();
    const first = r.flow.enter(r.overlay);
    await settle();
    r.bridge.resolveEntry();
    await first;
    r.flow.tick();
    expect(r.bridge.tickMock).toHaveBeenCalledTimes(1);
    r.bridge.endSession();
    expect(r.store.getState().ar.mode).toBe('sensor');
    const second = r.flow.enter(r.overlay);
    await settle();
    r.bridge.resolveEntry();
    await second;
    expect(r.createBridge).toHaveBeenCalledTimes(1);
    expect(r.bridge.enterMock).toHaveBeenCalledTimes(2);
    expect(r.store.getState().ar.mode).toBe('xr');
  });

  it('ticks nothing before the bridge exists', () => {
    const r = rig();
    r.flow.tick();
    expect(r.bridge.tickMock).not.toHaveBeenCalled();
  });

  it.each([
    [new DOMException('no ARCore', 'NotSupportedError'), 'xrUnsupported'],
    [new DOMException('consent', 'NotAllowedError'), 'xrDenied'],
    [new DOMException('pending', 'InvalidStateError'), 'xrBusy'],
    ['WebXR not supported in this browser or environment', 'xrUnsupported'],
    [new Error('boom'), 'xrFailed'],
  ] as const)(
    'a rejected entry (%s) keeps the sensor mode with the banner %s',
    async (error, code) => {
      const r = rig();
      const entry = r.flow.enter(r.overlay);
      await settle();
      r.bridge.rejectEntry(error);
      await expect(entry).rejects.toBe(error);
      const { ar } = r.store.getState();
      expect(ar.mode).toBe('sensor');
      expect(ar.xr.phase).toBe('idle');
      expect(ar.xr.aligned).toBeNull();
      expect(ar.error).toBe(code);
      expect(r.flow.isActive).toBe(false);
    },
  );

  it('keeps an AbortError silent: no banner, the phase back to idle', async () => {
    const r = rig();
    const entry = r.flow.enter(r.overlay);
    await settle();
    r.bridge.rejectEntry(new DOMException('gone', 'AbortError'));
    await expect(entry).rejects.toBeInstanceOf(DOMException);
    const { ar } = r.store.getState();
    expect(ar.mode).toBe('sensor');
    expect(ar.xr.phase).toBe('idle');
    expect(ar.error).toBeNull();
  });

  it('maps a bridge that cannot be created to xrUnsupported and retries the creation later', async () => {
    const r = rig({ createFailure: new XrUnavailableError() });
    await expect(r.flow.enter(r.overlay)).rejects.toBeInstanceOf(XrUnavailableError);
    const { ar } = r.store.getState();
    expect(ar.mode).toBe('sensor');
    expect(ar.xr.phase).toBe('idle');
    expect(ar.error).toBe('xrUnsupported');
    r.store.getState().actions.clearArError();
    await expect(r.flow.enter(r.overlay)).rejects.toBeInstanceOf(XrUnavailableError);
    expect(r.createBridge).toHaveBeenCalledTimes(2);
  });

  it('refuses to start outside the sensor mode or without support, without a banner', async () => {
    const off = createSkyStore({}, 1_757_000_000_000);
    const rOff = rig({ store: off });
    await expect(rOff.flow.enter(rOff.overlay)).rejects.toBeInstanceOf(DOMException);
    expect(rOff.createBridge).not.toHaveBeenCalled();
    expect(off.getState().ar.xr.phase).toBe('idle');
    expect(off.getState().ar.error).toBeNull();

    const unsupported = sensorStore();
    unsupported.getState().actions.setArXr({ support: 'unsupported', phase: 'entering' });
    const rUn = rig({ store: unsupported });
    await expect(rUn.flow.enter(rUn.overlay)).rejects.toBeInstanceOf(DOMException);
    // The engine had marked the phase before the chunk loaded: the flow resets it.
    expect(unsupported.getState().ar.xr.phase).toBe('idle');
    expect(unsupported.getState().ar.error).toBeNull();
  });

  it('refuses a second entry while one is in flight or active', async () => {
    const r = rig();
    const entry = r.flow.enter(r.overlay);
    await expect(r.flow.enter(r.overlay)).rejects.toMatchObject({ name: 'InvalidStateError' });
    await settle();
    r.bridge.resolveEntry();
    await entry;
    await expect(r.flow.enter(r.overlay)).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(r.bridge.enterMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the entry when the store left AR before the bridge was ready', async () => {
    const r = rig();
    const entry = r.flow.enter(r.overlay);
    r.store.getState().actions.exitAr();
    await expect(entry).rejects.toMatchObject({ name: 'AbortError' });
    expect(r.bridge.enterMock).not.toHaveBeenCalled();
    const { ar } = r.store.getState();
    expect(ar.mode).toBe('off');
    expect(ar.xr.phase).toBe('idle');
    expect(ar.error).toBeNull();
  });

  it('ends a session the browser opened after the user had already left AR', async () => {
    const r = rig();
    const entry = r.flow.enter(r.overlay);
    await settle();
    expect(r.bridge.enterMock).toHaveBeenCalledTimes(1);
    r.store.getState().actions.exitAr();
    r.bridge.resolveEntry();
    await expect(entry).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
    expect(r.bridge.exitMock).toHaveBeenCalledTimes(1);
    const { ar } = r.store.getState();
    expect(ar.mode).toBe('off');
    expect(ar.xr.phase).toBe('idle');
    expect(r.flow.isActive).toBe(false);
    expect(r.onSessionEnded).toHaveBeenCalledTimes(1);
  });
});

describe('XrFlow exit and session end', () => {
  it('exit() ends an active session: sensor mode, phase idle, the engine restored once', async () => {
    const r = rig();
    const entry = r.flow.enter(r.overlay);
    await settle();
    r.bridge.resolveEntry();
    await entry;
    await r.flow.exit();
    expect(r.bridge.exitMock).toHaveBeenCalledTimes(1);
    const { ar } = r.store.getState();
    expect(ar.mode).toBe('sensor');
    expect(ar.xr.phase).toBe('idle');
    expect(ar.xr.aligned).toBeNull();
    expect(r.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(r.flow.isActive).toBe(false);
  });

  it('exit() during the entry waits for it, then ends the session', async () => {
    const r = rig();
    const entry = r.flow.enter(r.overlay);
    await settle();
    const exit = r.flow.exit();
    await settle();
    expect(r.bridge.exitMock).not.toHaveBeenCalled();
    r.bridge.resolveEntry();
    await expect(entry).rejects.toMatchObject({ name: 'AbortError' });
    await exit;
    expect(r.bridge.exitMock).toHaveBeenCalled();
    expect(r.store.getState().ar.mode).toBe('sensor');
    expect(r.store.getState().ar.xr.phase).toBe('idle');
    expect(r.flow.isActive).toBe(false);
  });

  it('exit() during an entry that fails ends nothing', async () => {
    const r = rig();
    const entry = r.flow.enter(r.overlay);
    await settle();
    const exit = r.flow.exit();
    r.bridge.rejectEntry(new DOMException('no ARCore', 'NotSupportedError'));
    await expect(entry).rejects.toBeInstanceOf(DOMException);
    await exit;
    expect(r.bridge.exitMock).not.toHaveBeenCalled();
    expect(r.store.getState().ar.error).toBe('xrUnsupported');
  });

  it('exit() without a session is a no-op and never rejects', async () => {
    const r = rig();
    await expect(r.flow.exit()).resolves.toBeUndefined();
    expect(r.bridge.exitMock).not.toHaveBeenCalled();
  });

  it('a session ending on its own (back gesture) returns to the sensor mode', async () => {
    const r = rig();
    const entry = r.flow.enter(r.overlay);
    await settle();
    r.bridge.resolveEntry();
    await entry;
    r.store.getState().actions.setArXr({ aligned: true });
    r.bridge.endSession();
    const { ar } = r.store.getState();
    expect(ar.mode).toBe('sensor');
    expect(ar.xr.phase).toBe('idle');
    expect(ar.xr.aligned).toBeNull();
    expect(ar.error).toBeNull();
    expect(r.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(r.flow.isActive).toBe(false);
  });

  it('swallows a failing bridge exit with a warning', async () => {
    const r = rig();
    const entry = r.flow.enter(r.overlay);
    await settle();
    r.bridge.resolveEntry();
    await entry;
    r.bridge.exitMock.mockImplementationOnce(() => Promise.reject(new Error('cannot end')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(r.flow.exit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('XrFlow dispose', () => {
  it('disposes the bridge once and refuses later entries and exits', async () => {
    const r = rig();
    const entry = r.flow.enter(r.overlay);
    await settle();
    r.bridge.resolveEntry();
    await entry;
    r.flow.dispose();
    r.flow.dispose();
    expect(r.bridge.disposeMock).toHaveBeenCalledTimes(1);
    expect(r.flow.isActive).toBe(false);
    await expect(r.flow.enter(r.overlay)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(r.flow.exit()).resolves.toBeUndefined();
    // A late session end after the disposal writes nothing to the store.
    const before = r.store.getState().ar;
    r.bridge.endSession();
    expect(r.store.getState().ar).toBe(before);
    expect(r.onSessionEnded).not.toHaveBeenCalled();
  });

  it('disposes a bridge that finishes creating after the disposal', async () => {
    const r = rig();
    const entry = r.flow.enter(r.overlay);
    r.flow.dispose();
    await expect(entry).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
    expect(r.bridge.disposeMock).toHaveBeenCalledTimes(1);
    expect(r.bridge.enterMock).not.toHaveBeenCalled();
    // The store is left to the engine: no write after the disposal.
    expect(r.store.getState().ar.xr.phase).toBe('entering');
  });
});
