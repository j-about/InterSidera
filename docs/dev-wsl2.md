# Development on WSL 2 (Debian)

Status: stub written at M0; completed at M5 (phone-testing procedure for augmented reality). Covers the facts already fixed by the M0 tooling; everything about reaching the dev server from a phone is verified and finalised at M5.

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

## Playwright system libraries

Browsers download with `make setup` (`playwright install chromium webkit`), but launching them needs shared libraries that are absent on a fresh WSL Debian (libnss3, libgbm1, libasound2, libwoff2dec, ...). Install them once with sudo:

```bash
sudo env "PATH=$PATH" fnm exec --using=24 npm --prefix frontend exec -- playwright install-deps
```

Until this manual step is done, `make e2e` cannot run locally; CI installs them with `playwright install --with-deps chromium`.

## Data directory

`SKYAPI_DATA_DIR` defaults to `../data` relative to `backend/` (the working directory of every backend command), that is the repository's gitignored `data/`. `sky-data fetch` (M1) fills it; never `cat` a file from it (use `head -c`, `wc -c` or a Python one-liner). From M7, docker compose bind-mounts `SKY_DATA_DIR` (default `./data`) on the same directory.
