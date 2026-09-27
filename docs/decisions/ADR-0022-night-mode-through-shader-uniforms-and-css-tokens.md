# ADR-0022: Night mode through shader uniforms and CSS tokens, not a post-process

- Status: Accepted
- Date: 2026-09-24 (records D108, taken at M4 on 2026-09-09, and the M6 accessibility record; recording form)

## Context

Night-vision mode is a "red monochrome palette over the sky and the whole UI plus a brightness slider, toggled from the UI and the URL" (UX-3, l.247); the rendering-layer list names it as a post-process over the whole UI (l.88, item 6). A Babylon post-process cannot tint the HTML chrome, and a CSS `filter` over the page is neither monochrome nor free (a compositor pass on every frame, and it would tint the camera video in AR). Tailwind CSS 4 is CSS-first with the `night` custom variant on `[data-mode=night]` (l.408). WCAG 2.2 AA applies to the chrome (l.290), and the brightness floor must keep the UI readable.

## Options considered

1. A Babylon post-process on the canvas plus a CSS `filter` on the chrome. Rejected: two mechanisms, the filter is not monochrome, a compositor pass per frame, the video tinted.
2. A second palette generated at build time. Rejected: the brightness slider needs a runtime value.
3. `uNight` in every shader pair and CSS tokens redefined with `color-mix` on a runtime variable. Chosen (D108).
4. `night=0|1` alone with an ephemeral brightness. Rejected (Q38, backlog B-59): a shared link must reproduce the view, so the level travels as `night=0.xx`.

## Decision

Records plan row D108 (with backlog B-59, B-78, B-90, Q38 and maintainer question 22).

- Every shader pair (stars, bodies, DSO, background; GLSL and WGSL twins) takes `uNight = (on, level)` and maps luma to red (`G = B = 0`); the line layers rewrite their `ColorKind` palette.
- `state/domSync.ts` writes `data-mode="night"` and `--night-brightness` on `<html>` (the only writer of `<html>` attributes, ADR-0010); `src/styles/app.css` redefines the tokens under `[data-mode=night]` through `color-mix(... calc(var(--night-brightness) * 100%), black)`; no CSS `filter`, no post-process.
- The URL carries `night=0|1|0.xx` with a floor of 0.3 (Q38; the level is not written while night is off), so a shared link reproduces the mode (ADR-0012).
- `ui/shell/NightControls.tsx` formats the brightness through `i18n/format.ts::formatPercent` (plan D159, M6) instead of its own `Intl.NumberFormat`.
- The night pairs at level 1 (area C final report, section 3.3): panel text 5.74:1, muted 5.41:1, warn 8.90:1, danger 5.35:1, accent 7.28:1, field border 3.74:1 with `border-muted/80`.
- The camera video in AR stays untinted and the PNG export is not offered in AR (B-78).

## Consequences

- WCAG AA is asserted at level 1: `styles/tokens.test.ts` composites the night tokens at brightness 1 over the panel and field surfaces and asserts the pairs of `docs/testing.md` (text >= 4.5:1, large text and non-text >= 3:1); below level 1 the contrast falls by user choice, recorded as the exception B-90 (axe at the 0.3 floor: 0 violation nodes, 47 incomplete nodes, area C final report).
- Every new shader pair must implement `uNight`, and every new token must have a night twin; `npm run lint` and the token test catch the CSS side, the two-backend Playwright run the shader side (`e2e/night.spec.ts`: Sirius red, green and blue below 16, after two rendered frames).
- Night tokens win under `[data-mode=night]` whatever `prefers-color-scheme` says: the two night Lighthouse URLs override the scheme through `data-mode`, the four others score the light scheme headless Chrome renders by default.
- Backlog B-59 records the deviation from the brief's "post-process over the whole UI" wording (l.88) and the decimal `night` value beyond UX-2's `night`; B-78 the untinted video.
- Lighthouse scores the night URLs at 1.00 (ADR-0020), and the light scheme has its own `color-warn` (`#885900`, 4.58:1) since M6.

## Revisit trigger

- A fifth shader pair or a new line `ColorKind` without a night branch (the two-backend pixel probe is the guard); maintainer question 22 (keep the brightness in the URL?) answered the other way; a Tailwind or browser change to `color-mix` support in the browser matrix (l.268); a night-mode requirement for the camera video.

Pointers: `docs/architecture.md` ("Rendering layers"), `.claude/rules/frontend.md`, `.claude/rules/sky-math.md`, `docs/testing.md` ("Contrast of the design tokens"), `docs/plan.md` section 3 (D108), section 11 (question 22), `docs/backlog.md` (B-59, B-78, B-90).
