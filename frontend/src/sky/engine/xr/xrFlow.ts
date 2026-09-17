// The WebXR session flow (AR-4, AR-5; brief l.240-241; plan D128): the store side of an
// `immersive-ar` session, Babylon-free so the transitions run under jsdom with a fake bridge.
// Part of the lazy `XrBridge` chunk (`XrBridge.ts` re-exports it; `SkyEngine` reaches both
// through one `await import('./xr/XrBridge')`). The engine's `enterXr` marks `xr.phase`
// `entering`, loads the chunk and hands the overlay root here; this class creates the Babylon
// bridge once, enters the session, writes the outcome (`setArMode('xr')` + `phase: 'active'`, or
// `failAr(classifyXrFailure(error))` with `AbortError` kept silent), ends the session when the
// user or the store asks and returns to the sensor mode when the session ends for any reason
// (our exit control, the Android back gesture, a runtime failure), then lets the engine restore
// its camera and canvas. Every store write of the session lives here or in the bridge's tick.

import type { SkyStore } from '../../../state/storeTypes';
import { classifyXrFailure } from '../../ar/webxr';

/** What the Babylon bridge reports back to the flow. */
export interface XrBridgeHooks {
  /** The session ended (any cause), after Babylon restored the scene; fired once per session. */
  onSessionEnded(): void;
}

/** The Babylon side of a session (`XrBridge.ts`), as the flow drives it. */
export interface XrBridgeLike {
  /** Start an `immersive-ar` session on `overlay`; resolves once frames flow, rejects otherwise. */
  enter(overlay: HTMLElement): Promise<void>;
  /** End the session; a pending entry is awaited first. Never rejects for a session that is gone. */
  exit(): Promise<void>;
  /** Once per rendered frame while a session runs: the rig correction and the pose publication. */
  tick(): void;
  /** Idempotent: observers removed, the experience disposed (an open session ends). */
  dispose(): void;
}

export interface XrFlowDeps {
  store: SkyStore;
  /** Create the Babylon bridge (`XrBridge.create`); called once, the bridge outlives the sessions. */
  createBridge(hooks: XrBridgeHooks): Promise<XrBridgeLike>;
  /**
   * Engine-side restoration after a session ended and the store returned to the sensor mode
   * (the sky camera re-applied, `resize()` once: Babylon restores the canvas at DPR 1).
   */
  onSessionEnded(): void;
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError');
}

export class XrFlow {
  private readonly deps: XrFlowDeps;
  private bridge: XrBridgeLike | null = null;
  private creating: Promise<XrBridgeLike> | null = null;
  /** The whole entry in flight (`createBridge` + `bridge.enter`), awaited by `exit()`. */
  private entry: Promise<void> | null = null;
  /** `exit()` (or the store leaving AR) came while the entry was in flight. */
  private exitRequested = false;
  private active = false;
  private disposed = false;

  constructor(deps: XrFlowDeps) {
    this.deps = deps;
  }

  /** A session is running (between the first XR frame and the session end). */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * Enter a session on `overlay` (an event-time call, plan D93). Requires the sensor mode with
   * `xr.support === 'supported'` and no entry in flight; rejects otherwise without a banner.
   * Resolves once the session renders; rejects with the raw failure after the store was written.
   */
  enter(overlay: HTMLElement): Promise<void> {
    if (this.disposed) {
      return Promise.reject(abortError('the WebXR flow is disposed'));
    }
    if (this.entry !== null || this.active) {
      return Promise.reject(
        new DOMException('a WebXR session is already open', 'InvalidStateError'),
      );
    }
    const { ar, actions } = this.deps.store.getState();
    if (ar.mode !== 'sensor' || ar.xr.support !== 'supported') {
      // The state moved on while the chunk loaded (the user left AR): no session, no message.
      if (ar.xr.phase === 'entering') {
        actions.setArXr({ phase: 'idle', aligned: null });
      }
      return Promise.reject(abortError('WebXR cannot start in this state'));
    }
    this.exitRequested = false;
    actions.setArXr({ phase: 'entering' });
    const entry = this.runEntry(overlay).finally(() => {
      this.entry = null;
    });
    this.entry = entry;
    return entry;
  }

  private async runEntry(overlay: HTMLElement): Promise<void> {
    // Read through a function: TypeScript keeps the narrowing of `this.x` across an `await`.
    const cancelled = (): boolean => this.disposed || this.exitRequested;
    let bridge: XrBridgeLike;
    try {
      bridge = await this.bridgeReady();
      if (cancelled() || !this.stillEntering()) {
        throw abortError('the WebXR entry was cancelled');
      }
      await bridge.enter(overlay);
    } catch (error: unknown) {
      this.fail(error);
      throw error;
    }
    const { ar, actions } = this.deps.store.getState();
    if (cancelled() || ar.mode !== 'sensor') {
      // The user left AR while the browser was starting the session: end it at once.
      this.active = true;
      void this.endQuietly(bridge);
      throw abortError('the WebXR entry was abandoned');
    }
    this.active = true;
    actions.setArMode('xr');
    actions.setArXr({ phase: 'active' });
  }

  /** The store still wants the session (`sensor` mode, `entering` phase). */
  private stillEntering(): boolean {
    const { ar } = this.deps.store.getState();
    return ar.mode === 'sensor' && ar.xr.phase === 'entering';
  }

  private bridgeReady(): Promise<XrBridgeLike> {
    if (this.bridge !== null) {
      return Promise.resolve(this.bridge);
    }
    if (this.creating === null) {
      const creating = this.deps.createBridge({
        onSessionEnded: () => {
          this.onBridgeSessionEnded();
        },
      });
      this.creating = creating;
      void creating.then(
        (bridge) => {
          if (this.disposed) {
            bridge.dispose();
          } else {
            this.bridge = bridge;
          }
        },
        () => {
          // A failed creation may be retried by the next tap.
          this.creating = null;
        },
      );
    }
    return this.creating;
  }

  /** The entry failed: one AR-5 code through `failAr` (the sensor mode is kept), or silence. */
  private fail(error: unknown): void {
    if (this.disposed) {
      return;
    }
    const { ar, actions } = this.deps.store.getState();
    const code = classifyXrFailure(error);
    if (code !== null && (ar.mode === 'sensor' || ar.mode === 'xr')) {
      actions.failAr(code);
    } else if (ar.xr.phase !== 'idle' || ar.xr.aligned !== null) {
      actions.setArXr({ phase: 'idle', aligned: null });
    }
  }

  /**
   * The session ended (the bridge's `onXRSessionEnded`, any cause): back to the sensor mode
   * (a no-op when the store already left AR), the XR phase idle, then the engine restores itself.
   */
  private onBridgeSessionEnded(): void {
    this.active = false;
    if (this.disposed) {
      return;
    }
    const { actions } = this.deps.store.getState();
    actions.setArMode('sensor');
    actions.setArXr({ phase: 'idle', aligned: null });
    this.deps.onSessionEnded();
  }

  /**
   * End the session (the exit control, or the store leaving AR). An entry in flight is awaited
   * first (a cancelled entry never opens a session; an entered one is ended). Never rejects.
   */
  async exit(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.exitRequested = true;
    const entry = this.entry;
    if (entry !== null) {
      await entry.catch(() => undefined);
    }
    if (this.active && this.bridge !== null) {
      await this.endQuietly(this.bridge);
    }
  }

  private async endQuietly(bridge: XrBridgeLike): Promise<void> {
    try {
      await bridge.exit();
    } catch (error: unknown) {
      console.warn('the WebXR session could not be ended', error);
    }
  }

  /** Once per engine frame, before the layers read the pose; the bridge guards its own state. */
  tick(): void {
    this.bridge?.tick();
  }

  /** Idempotent: the bridge (and an open session) go away; the store is left to the engine. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.active = false;
    this.bridge?.dispose();
    this.bridge = null;
  }
}
