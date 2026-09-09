// The shared 429 gate (plan D106, Q44): `/sky/altaz` (details controller) and
// `/minor-bodies/search` (search box) draw from the same per-IP token bucket as `/sky/frame`
// (docs/api.md "Rate limiting"), so one `Retry-After` must hold both callers back at once
// instead of each discovering the refusal on its own. Pure bookkeeping: the callers pass the
// wall clock in and read the answer; nothing here sleeps or fetches.

export interface RateGate {
  /** `true` when a rate-limited request may be issued at wall time `nowMs`. */
  allowed(nowMs: number): boolean;
  /** A 429 arrived: hold every caller back for `retryAfterS` seconds (1 s when unknown). */
  block(retryAfterS: number | undefined, nowMs: number): void;
  /** The wall time the gate opens again, `-Infinity` while nothing blocks it. */
  blockedUntilMs(): number;
}

/** `Retry-After` is at least 1 s on a 429 (docs/api.md); a missing header counts as that. */
export const DEFAULT_RETRY_AFTER_S = 1;
/** A longer `Retry-After` is capped here, like the client's retry policy. */
export const MAX_RETRY_AFTER_S = 60;

export function createRateGate(): RateGate {
  let until = -Infinity;
  return {
    allowed: (nowMs) => nowMs >= until,
    block(retryAfterS, nowMs) {
      const seconds =
        retryAfterS === undefined || !Number.isFinite(retryAfterS)
          ? DEFAULT_RETRY_AFTER_S
          : Math.min(MAX_RETRY_AFTER_S, Math.max(0, retryAfterS));
      until = Math.max(until, nowMs + seconds * 1000);
    },
    blockedUntilMs: () => until,
  };
}

/**
 * The one gate the application shares between the details controller and the minor-body search
 * (both default to it; tests create their own with `createRateGate`). It holds a single wall
 * time and nothing else, so sharing it across the page is the point rather than a hazard.
 */
export const sharedRateGate: RateGate = createRateGate();
