# ADR-0021: Reaching the dev server from a phone: mkcert and `DEV_TLS_*`, not `@vitejs/plugin-basic-ssl`

- Status: Accepted (maintainer question 28 pending on a `make dev-phone` recipe)
- Date: 2026-09-24 (records D15, taken at M0 on 2026-09-02, and D135, taken at M5 on 2026-09-17; recording form)

## Context

The brief runs the Vite dev server over HTTPS "via `@vitejs/plugin-basic-ssl`" because geolocation, the camera, the sensors and WebXR need a secure context on a phone, and asks that "the phone must trust the certificate or use the browser's insecure-origin exception" with mirrored networking or a port proxy for WSL 2 (l.95, l.548); the plugin is on the dependency list (l.405). Verified in the installed `@vitejs/plugin-basic-ssl` 2.3.0 (`dist/chunks/certificate.mjs` l.19834-19880): `createCertificate(name, domains, ttlDays = 30)` builds a self-signed leaf whose `basicConstraints cA` extension is commented out (a non-CA leaf), whose `subjectAltName` lists DNS `localhost`, DNS `[::1]`, IP `127.0.0.1` and IP `fe80::1`, and whose `domains` option appends DNS names only (`type: 2`), valid 30 days and regenerated with `node_modules`. A LAN IP can therefore never be an IP SAN of that certificate, Android refuses to install a non-CA leaf as a CA and iOS cannot grant it full trust: the M4 draft step "install `_cert.pem` on the phone" never worked (backlog B-82). Playwright and CI must never deal with a self-signed certificate (plan D15).

## Options considered

1. The plugin's certificate on the phone, as l.548 reads. Rejected: not trustable for a LAN IP (above); at best a certificate interstitial on `https://localhost:5173` through USB forwarding, renewed every 30 days, with `getUserMedia` on that origin unverified.
2. A `domains` entry for the LAN IP. Rejected: it becomes a DNS SAN, which browsers do not match against an IP host.
3. Trusted development certificates from a mkcert CA, handed to Vite through two Node-side variables. Chosen for iOS and for Android over the LAN (D135).
4. Plain HTTP on `http://localhost` through Chrome's USB port forwarding (or `adb reverse`). Chosen as the Android default: `http://localhost` is a secure context, no certificate at all.
5. Chrome's `chrome://flags/#unsafely-treat-insecure-origin-as-secure`. Documented as the third path (Android only, unverified on every build).
6. `server.host: true` by default so every path is reachable on the LAN at once. Rejected (D15): LAN exposure is opt-in through `--host` and documented per path.

## Decision

Records plan rows D15 and D135 (with backlog B-82 and maintainer question 28).

- D15: `basicSsl()` is added only when `command === 'serve' && mode === 'development' && !isPreview` and no `DEV_TLS_*` pair is set (`frontend/vite.config.ts`); `vite preview` stays plain HTTP on 4173 for Playwright and CI; the `/api` proxy targets `http://127.0.0.1:8000` (never `localhost`, which Node may resolve to `::1`); no `server.host: true` by default. The plugin stays the desktop convenience: accept the warning once on `https://localhost:5173`.
- D135: `devTls()` in `vite.config.ts` reads `DEV_TLS_CERT` and `DEV_TLS_KEY` (Node-side variables of the config, never `VITE_*`: nothing reaches the client; both required, one without the other is a configuration error), PEM files such as mkcert's `<ip>+3.pem` / `<ip>+3-key.pem`; when set, `vite dev` and `vite preview` serve HTTPS with them and basic-ssl is skipped. `docs/dev-wsl2.md` documents three verified paths: A, Android Chrome through `chrome://inspect` port forwarding of the plain-HTTP e2e preview on 4173 (no certificate); B, iOS Safari (and Android) over the LAN with `mkcert <Windows LAN IP> localhost 127.0.0.1 ::1`, `--host`, mirrored networking (`networkingMode=mirrored` in `.wslconfig`) or `netsh portproxy`, and the `rootCA.pem` installed with full trust on the phone; C, Android's insecure-origin flag.
- M6 (ADR-0018): on the dev-server path the page is served under the CSP with a per-process nonce and `worker-src blob:`; on the preview path (4173, the phone default) under the production policy. The all-layers self-test on a phone reports through `report=/__selftest` (plan D168), a same-origin path the Vite proxy forwards to the collector on 9911.

## Consequences

- The maintainer installs mkcert on Windows (`choco` or `scoop`) and trusts the CA on the phone once; CI and Playwright are unaffected (plain HTTP on 4173).
- B-82 records the deviation from l.548 in words; the plugin is neither removed (l.405 lists it) nor used for phones.
- The device checklist of `docs/testing.md` "Manual checks" and the `#dpr=1.5` run of plan D142 use path A or B; the rows stay pending the maintainer (question 25).
- Playwright's `webServer` and `baseURL` stay on `http://127.0.0.1:4173` (`playwright.config.ts`; `127.0.0.1` everywhere, never `localhost`), so no e2e run ever meets a certificate.
- On a WebGPU phone the WebXR path is exercised through the `#engine=webgl2` hash of the dev and e2e builds on any of the three paths (ADR-0014, backlog B-79).
- A `make dev-phone` recipe (question 28) would only wrap path B's command line; nothing else is missing.

## Revisit trigger

- `@vitejs/plugin-basic-ssl` gains a CA mode or IP SAN options; Vite ships a trusted-certificate helper; the maintainer answers question 28; Android or iOS change their rules for user-installed CAs.

Pointers: `docs/dev-wsl2.md` (the three paths and "Why not `@vitejs/plugin-basic-ssl` on a phone"), `frontend/vite.config.ts` (`devTls`), `docs/plan.md` section 3 (D15, D135), section 11 (question 28), `docs/backlog.md` (B-82).
