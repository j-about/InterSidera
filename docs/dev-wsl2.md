# Development on WSL 2 (Debian)

Status: stub written at M0; Playwright libraries and the Windows-browser check added at M3; completed at M5 (phone-testing procedure for augmented reality). Covers the facts already fixed by the tooling; everything about reaching the dev server from a phone is verified and finalised at M5.

## Toolchain

- `make setup` installs CPython 3.14 through uv and Node 24 through fnm, then `uv sync`, `npm ci`, the Playwright browsers, and copies `.env.example` to `.env`.
- Every make recipe runs Node through `fnm exec --using=<repo>/.node-version`, so the Makefile works whatever the fnm default is. For interactive shells in subdirectories add to `~/.bashrc`:

  ```bash
  eval "$(fnm env --use-on-cd --version-file-strategy=recursive)"
  export FNM_VERSION_FILE_STRATEGY=recursive
  ```

  Without the recursive strategy, `fnm exec` (and `fnm use`) inside `frontend/` fails with "Can't find version in dotfiles" because `.node-version` lives at the repository root.

- Backend commands run from the root as `uv run --directory backend ...`; uv reads `backend/.python-version` (`3.14`) and `backend/pyproject.toml`.

## Dev servers

- `make dev` starts both: the API with `fastapi dev` on <http://127.0.0.1:8000> (loads `.env` through `uv run --env-file`) and Vite on <https://localhost:5173>. The Vite dev server proxies `/api` to `http://127.0.0.1:8000`, so the browser talks to one origin.
- Dev HTTPS comes from `@vitejs/plugin-basic-ssl`, enabled only for `vite dev` in development mode (not for `vite preview`, not in tests). It creates and caches a self-signed certificate at `frontend/node_modules/.vite/basic-ssl/_cert.pem`. Accept the browser warning once on the desktop.
- `vite preview` serves the production build over plain HTTP on <http://127.0.0.1:4173>; Playwright uses it. Use `127.0.0.1` rather than `localhost` in scripts: Node may resolve `localhost` to `::1` while uvicorn listens on IPv4.
- `/api/v1/docs` shows the Swagger UI; `/api/v1/health` is the readiness probe.

## Reaching the dev server from a phone on the LAN (finalised at M5)

Geolocation, camera, device orientation and WebXR need a secure context, so the phone must load <https://host:5173>.

1. Expose Vite on all interfaces for the session (the config deliberately has no `server.host: true`): `fnm exec --using=24 npm --prefix frontend run dev -- --host`, or `npm run dev -- --host` from `frontend/` in an fnm-activated shell. Access by IP works out of the box; access by hostname needs the name in `server.allowedHosts` (Vite allows `localhost`, `*.localhost` and IP literals by default).
2. Make the WSL 2 port reachable from the LAN, either:
   - mirrored networking: `%UserProfile%\.wslconfig` with `[wsl2]` `networkingMode=mirrored`, then `wsl --shutdown` and restart; the WSL ports then appear on the Windows host's LAN address; or
   - a port proxy on Windows (elevated PowerShell): `netsh interface portproxy add v4tov4 listenport=5173 listenaddress=0.0.0.0 connectport=5173 connectaddress=<WSL IP from hostname -I>`, plus a Windows Defender Firewall inbound rule for TCP 5173. Remove with `netsh interface portproxy delete v4tov4 listenport=5173 listenaddress=0.0.0.0`.
   - The API does not need exposing: the phone reaches it through the Vite proxy.
3. Trust the certificate on the phone: copy `frontend/node_modules/.vite/basic-ssl/_cert.pem` to the phone and install it as a trusted certificate (Android: Settings > Security > Install a certificate > CA certificate; iOS: install the profile, then enable full trust under Settings > General > About > Certificate Trust Settings), or use the browser's insecure-origin exception (Chrome: `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with the `https://<host>:5173` origin). Regenerate and re-trust when the certificate expires or `node_modules` is reinstalled.
4. Open `https://<Windows LAN IP>:5173/` on the phone; the AR button appears only in a secure context on a device with a rear camera and orientation sensors (AR-1).

Exact steps, screenshots of the trust dialogs and the sensor permission flow are added at M5.

## Playwright browsers and system libraries

`make setup` downloads the Playwright 1.63 browsers (`playwright install chromium webkit`: Chromium 153 as `chromium-1243`, its headless shell, WebKit `webkit-2359`; all have debian13-arm64 builds), but launching them needs shared libraries that a fresh WSL Debian lacks (libnss3, libgbm1, libasound2, libwoff2dec, ...). Two ways to get them:

1. With sudo, once:

   ```bash
   sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps
   ```

2. Without sudo, a user-space library directory (verified 2026-09-06 on this Debian 13 aarch64): resolve Playwright's Debian 13 Chromium package list (`playwright-core/lib/coreBundle.js`, the `debian13-*` entry) with `apt-get install --print-uris` (no root needed), download the `.deb` files, extract each with `dpkg-deb -x <file> ~/.local/pw-libs`, then export the two variables before any Playwright command:

   ```bash
   L="$HOME/.local/pw-libs/usr/lib/aarch64-linux-gnu"
   export LD_LIBRARY_PATH="$L:$L/pulseaudio" FONTCONFIG_PATH="$HOME/.local/pw-libs/etc/fonts"
   make e2e
   ```

   The headless shell and full Chromium (`channel: 'chromium'`) both launch; WebGL2 renders through SwiftShader; `TextRunHarfBuzz error` lines on stderr are font noise from the extracted fontconfig and can be ignored. WebKit does not launch this way: with the Chromium package list extracted it still reports 45 missing libraries (gstreamer 1.0, gtk-4, ICU 76, flite, libjxl, libsoup 3, ...), so the `webkit` project needs the sudo path.

CI needs neither: it runs `playwright install --with-deps chromium`. WebKit stays a manual, local run (`npm run e2e -- --project=webkit` from `frontend/`).

## Checking the sky from a Windows browser

Headless SwiftShader is slow and has no WebGPU worth measuring; a browser on the Windows host uses the real GPU. WSL 2 forwards `localhost` ports to Windows, so:

```bash
fnm exec --using=24 npm --prefix frontend run build:e2e   # the build with window.__sky (make build-e2e)
fnm exec --using=24 npm --prefix frontend run preview     # http://127.0.0.1:4173, proxies /api to 8000
```

with the API running on 8000 (`make dev-api`, or `SKYAPI_DATA_DIR=../data SKYAPI_EPHEMERIS=de440s.bsp SKYAPI_AUTO_FETCH=false uv run --directory backend fastapi run --port 8000` when no `.env` exists). Open `http://localhost:4173/?body=earth&lat=51.48&lon=0&elev=0&t=2460409.25&speed=0` in Chrome, Edge or Brave on Windows; `await window.__sky.ready` then `window.__sky.backend` (expect `webgpu` on a WebGPU-capable GPU, `webgl2` with `#engine=webgl2` appended), `window.__sky.fps()` after ten seconds and `window.__sky.state().parseMs` give the numbers `docs/testing.md` records. Plain HTTP on `localhost` is a secure context, so `navigator.gpu` is available; the dev server on 5173 (HTTPS, self-signed) works too after accepting the certificate.

To measure instead of look, add the self-test hash of the debug hook (dev and e2e builds only): `http://localhost:4173/?body=earth&lat=51.48&lon=0&elev=0&t=2460409.25&speed=0&az=0&alt=45&fov=60#engine=webgpu&selftest` renders for 10 s after the first frame and overlays a JSON report (`backend`, `adapterInfo`, `fps`, `frameMs`, `parseMs`, Polaris against the latitude, every body against `/sky/altaz`); `#engine=webgl2&selftest` does the same on WebGL2, and `&report=http://localhost:<port>/report` POSTs the report to a collector listening in WSL (Windows reaches WSL ports on `localhost` in the default NAT mode). The 2026-09-06 host-GPU numbers in `docs/testing.md` come from this recipe with Brave 152.

## Data directory

`SKYAPI_DATA_DIR` defaults to `../data` relative to `backend/` (the working directory of every backend command), that is the repository's gitignored `data/`. `sky-data fetch` (M1) fills it; never `cat` a file from it (use `head -c`, `wc -c` or a Python one-liner). From M7, docker compose bind-mounts `SKY_DATA_DIR` (default `./data`) on the same directory.
