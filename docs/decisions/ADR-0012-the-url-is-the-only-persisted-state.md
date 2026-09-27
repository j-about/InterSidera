# ADR-0012: The URL is the only persisted state

- Status: Accepted
- Date: 2026-09-24 (records decisions taken at M3 on 2026-09-06, M4 on 2026-09-09 and M5 on 2026-09-17; recording form)

## Context

The brief forbids every browser store: "no cookies, localStorage, sessionStorage or IndexedDB; the URL is the only persisted state and a reload restores the view from the URL alone" (OBS-8, l.197; acceptance l.581 "verified by an e2e assertion"), and closes the parameter list of the shareable URL (UX-2, l.246: `body, lat, lon, elev, t, speed, az, alt, fov, layers, ground, atm, refr, maglim, dso, minor, labels, lang, night, sel`). The URL must be written with `history.replaceState` at <= 2 Hz with rounded floats and parsed defensively (l.552). Privacy outranks functional requirements (l.11), so nothing that identifies a session may outlive the page. Several later features asked for persistence anyway: the night brightness (M4), follow mode (M4), the geocoder toggle, the minor-body defaults and the whole augmented-reality state (M5).

## Options considered

1. `localStorage` for preferences (language, night level, dismissed hints). Rejected: OBS-8 and l.581.
2. Server-side sessions. Rejected: no accounts, no server-side storage of requests (l.275).
3. Extend the URL list. Rejected for state that must not self-restore (a link must never open a camera prompt: the AR permission calls are gesture-gated, l.546) and for the debug overrides.
4. The URL as the single codec, everything else session-only by rule. Chosen.

## Decision

Records plan rows D79, D108, D110 and D115 (with backlog B-58, B-60, B-73 and open questions Q32, Q38).

- D79 (codec): `state/url.ts` is pure and at 100 % coverage; it implements the UX-2 list with bounds, wraps and rounding (coordinates and alt/az 0.01 degree, fov 0.1, `tt` 1e-6 day); `t` absent or `live` is live, a numeric `t` with `speed` absent or 0 is paused, otherwise playing; out-of-range numbers are dropped, not clamped; default-valued keys are omitted except `body, lat, lon, elev, t, az, alt, fov` (Q32), so a copied link is self-describing. `state/urlSync.ts` writes `history.replaceState` at most every 500 ms with a trailing write, preserves the hash and re-applies `popstate` without echo.
- Hash overrides never serialised: `#engine=webgl2|webgpu` (D79, dev and e2e builds only) and, since M6, `#dpr=<0.5..4>` (plan D142); `shareUrl` is built from the serialised store, never from `location.href`, so neither leaks into a shared link (D110).
- D108 (night mode): the brightness travels as `night=0.xx` (floor 0.3, not written while night is off, Q38); `state/domSync.ts` mirrors it into `<html>` (`data-mode`, `--night-brightness`, `lang`), the only writer of `<html>` attributes (ADR-0022).
- D110 (share and About): the share button copies the serialised store to the clipboard with an input fallback; About reads `__APP_VERSION__`, `/health.version`, `/meta.api_version` and the generated `credits.json`; nothing is remembered.
- D115 (AR): the `ar` slice (mode, capabilities, permission, error, heading, offset, camera field, roll, hint) lives in `state/types.ts` and never reaches the URL (B-73); `view.az/alt/fov` keep flowing at <= 2 Hz so a link taken during AR still reproduces the direction; leaving Earth exits AR inside `setObserver`/`applyUrl`.
- Session-only by rule, each with its backlog row: follow mode (B-60), the minor-body defaults and "show more" (B-58: `minor` carries user pins only), the geocoder toggle (initialised from `/meta.geocoder.enabled`), `frames.coverageStop`, the `ui` slice (panel, sheet, dialog, toast, shortcuts).

## Consequences

- Every feature that wants persistence adds a URL parameter under UX-2 or stays ephemeral; the store never canonicalises `sel` and the codec is neutral about default layers (Q30).
- The M6 e2e fixtures assert OBS-8 after every test: the `noStorage` auto fixture of `e2e/fixtures.ts` checks that no cookie, Web Storage entry or IndexedDB database exists at teardown, on every spec of both CI projects (plan D153), which is the l.581 assertion.
- A dev-server restart never loses state: the HMR client reconnects and Vite reloads the tab with the new CSP nonce (ADR-0018), and the URL carries the view.
- `e2e/url-state.spec.ts` proves the acceptance round trip (l.574): every M3 parameter round-trips through the store, the URL and a reload, and the reload is served from the browser-cached catalogs (a 304 each, l.573).
- Accessibility follows: a reload never loses the user's place, and `lang` in the URL applies before the first render (D87).

## Revisit trigger

- A maintainer answer to plan questions 22 (night brightness in the URL) or 24 (presets) changing the parameter list; a new UX-2 parameter; a platform rule making `replaceState` rate-limited below 2 Hz (WebKit's 100 calls per 10 s is the known bound, `urlSync.ts` header).

Pointers: `docs/architecture.md` ("Store", "About, credits and share link"), `.claude/rules/sky-math.md` (the codec is a gated pure module), `docs/plan.md` section 3 (the rows above), `docs/backlog.md` (B-58, B-60, B-73).
