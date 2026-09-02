---
paths:
  - "frontend/src/**"
---

# Frontend rules (React 19, TypeScript 6, Vite 8, Tailwind 4)

- TypeScript strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `erasableSyntaxOnly`: use `import type`, no enums, no namespaces, no parameter properties. ESM only.
- ESLint runs `strictTypeChecked` + `stylisticTypeChecked`: `!` non-null assertions and floating promises are errors. Guard instead (`if (!el) throw ...`), and `void` or `await` every promise (`void i18next.init(...)`).
- React 19: function components and hooks only; `ref` as a prop (no `forwardRef`); no `useEffect` for derived state; the React Compiler stays off. UI components (`ui/`) contain no astronomy math.
- Every user-visible string goes through `t()` with a key in both `i18n/en.json` and `i18n/fr.json` (UX-1). `scripts/check_i18n.mjs` fails on missing or unused keys; template keys use a literal prefix (`t(\`constellations.${abbr}\`)`).
- Tailwind CSS-first: configuration lives in `styles/app.css` (`@import "tailwindcss"`, `@theme`, `@custom-variant night`). No `tailwind.config.js`; class names are complete literal strings, never concatenated; class order is enforced by prettier-plugin-tailwindcss.
- No storage APIs: no cookies, `localStorage`, `sessionStorage` or IndexedDB (OBS-8). The URL query string is the only persisted state (`state/url.ts`), updated with `history.replaceState` at <= 2 Hz with rounded floats.
- Privacy rounding: latitude and longitude to 0.01 degrees before any API call (OBS-7); the exact position leaves the browser only toward the geocoder the user explicitly queried.
- Only `import.meta.env.VITE_*` reaches the client; never mirror a `SKYAPI_*` value into a `VITE_*` variable.
- API types come from the generated `api/schema.d.ts` (never hand-edited); `api/client.ts` is the single fetch layer (M3).
- Babylon.js: import from `@babylonjs/core/<module>` subpaths only; never the package root, `Legacy/legacy` or the UMD `babylonjs`. Side-effect imports live in one documented file under `sky/engine/`. Shaders are separate `.glsl`/`.wgsl` files imported with `?raw`.
- The render loop belongs to `SkyEngine`: no allocation per frame, typed arrays and preallocated buffers, React re-renders never drive the canvas; the store notifies the engine through subscriptions.
- Dates: never parse negative years with `Date`; use `Date.UTC` + `setUTCFullYear`, keep TT Julian Date canonical, format years with an explicit sign and a custom formatter.
- Nominatim (M4): submit-only, at most one request in flight and >= 1 s apart, `<meta name="referrer" content="strict-origin-when-cross-origin">`, attribution displayed, handle 403/429 with a message.
- Accessibility (UX-4): keyboard-operable controls with visible focus, ARIA names, no state conveyed by colour alone, `prefers-reduced-motion` respected; jsx-a11y must stay clean.
