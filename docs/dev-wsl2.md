# Development on WSL 2 (Debian)

Status: stub written at M0; Playwright libraries and the Windows-browser check added at M3; the fontconfig file for headless form controls, the all-layers host-GPU check and the geolocation contexts added at M4; the phone-testing procedure for augmented reality (three paths, the sensor permission flows, the Brave plumbing check and the basic-ssl caveat) written at M5, which completes it. Every step below is either fixed by the tooling or verified against the vendor documentation; the items no desktop can settle are marked as such.

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

## Reaching the app from a phone (M5, plan D135)

The camera, the orientation sensors and WebXR exist only in a secure context (brief l.548), so the phone must load the app over HTTPS or from `http://localhost`. Three verified paths, in the order to try them; `@vitejs/plugin-basic-ssl` is NOT one of them (the caveat at the end, backlog B-82). Every command runs from the repository root with the API on 8000 (`make dev-api`, or without a `.env`: `SKYAPI_DATA_DIR=../data SKYAPI_EPHEMERIS=de440s.bsp SKYAPI_AUTO_FETCH=false uv run --directory backend fastapi run --port 8000`); the phone reaches the API through the Vite proxy, so only the web port travels.

### Path A: Android Chrome through USB port forwarding (no certificate)

1. Build and serve the e2e bundle (plain HTTP on 4173, `/api` proxied, `window.__sky` available for `__sky.fps()`): `fnm exec --using=<repo>/.node-version npm --prefix frontend run build:e2e` then `fnm exec --using=<repo>/.node-version npm --prefix frontend run preview`. Windows reaches WSL 2 ports on `localhost` in the default NAT mode.
2. Enable USB debugging on the phone (Developer options), plug it in, open `chrome://inspect/#devices` in Chrome, Edge or Brave on Windows, tick "Discover USB devices", click "Port forwarding", add device port `4173` -> `localhost:4173`, tick "Enable port forwarding" and accept the debugging prompt on the phone.
3. On the phone open `http://localhost:4173/?body=earth&lat=<lat>&lon=<lon>&elev=0`: `http://localhost` is a secure context, so the camera, the sensors and WebXR work without any certificate, and the AR button appears (Earth, touch, camera device, `DeviceOrientationEvent`). With the Android platform tools installed, `adb reverse tcp:4173 tcp:4173` does the same forwarding without a browser.
4. For the dev server with HMR forward `5173` instead; the origin is then `https://localhost:5173` behind the basic-ssl leaf, which the phone can only pass through a certificate interstitial (again at each rotation, 30 days), and whether Chromium for Android then grants `getUserMedia` and the orientation events on that origin is NOT verified here. For AR checks use the plain-HTTP preview of step 3, which is.

### Path B: iOS Safari (and Android) over the LAN with a trusted mkcert certificate

1. On Windows install mkcert (`choco install mkcert` or `scoop install mkcert`, bucket `extras`), run `mkcert -install` (trusts the local CA in the Windows store, optional) and `mkcert <Windows LAN IP> localhost 127.0.0.1 ::1`, which writes `<ip>+3.pem` and `<ip>+3-key.pem` (RSA 2048, SHA-256, an IP SAN, EKU serverAuth, 825 days: what Apple requires). Copy both files into WSL, for example `~/.local/dev-tls/`.
2. Start Vite with them: `DEV_TLS_CERT=$HOME/.local/dev-tls/<ip>+3.pem DEV_TLS_KEY=$HOME/.local/dev-tls/<ip>+3-key.pem fnm exec --using=<repo>/.node-version npm --prefix frontend run preview -- --host` (or `run dev -- --host` for HMR on 5173). `vite.config.ts` reads the two Node-side variables (both required; never `VITE_*`, nothing reaches the client), sets `server.https` and `preview.https` from the files and skips the basic-ssl plugin. `--host` binds every interface; IP literals are always allowed by `server.allowedHosts`, so a LAN IP needs no configuration.
3. Make the WSL 2 port reachable from the LAN, either with mirrored networking (`%UserProfile%\.wslconfig`: `[wsl2]` `networkingMode=mirrored`, then `wsl --shutdown`; WSL ports then listen on the Windows LAN address, and the Hyper-V firewall must let them in: in an elevated PowerShell `Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow`, or the narrower `New-NetFirewallHyperVRule -Name InterSidera -DisplayName InterSidera -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 4173`), or in NAT mode with a port proxy plus a Defender rule (elevated PowerShell): `netsh interface portproxy add v4tov4 listenport=4173 listenaddress=0.0.0.0 connectport=4173 connectaddress=$(wsl hostname -I)` and `New-NetFirewallRule -DisplayName InterSidera -Direction Inbound -Protocol TCP -LocalPort 4173 -Action Allow`; remove them with `netsh interface portproxy delete v4tov4 listenport=4173 listenaddress=0.0.0.0` and `Remove-NetFirewallRule -DisplayName InterSidera`. The API needs no exposure.
4. Trust the CA on the phone: send `rootCA.pem` from `mkcert -CAROOT` to the iPhone (AirDrop, mail or a file served from the LAN), open it, Settings > Profile Downloaded > Install, then Settings > General > About > Certificate Trust Settings > enable full trust for the mkcert root. Android accepts the same file as a user CA (Settings > Security > More security settings > Install a certificate > CA certificate); Chrome trusts user CAs (and exempts them from certificate transparency), other apps may not.
5. Open `https://<Windows LAN IP>:4173/` (or `:5173/`) on the phone; the padlock is clean and the AR button appears.

### Path C: Android Chrome over plain HTTP with the insecure-origin exception

On the phone open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, enter `http://<Windows LAN IP>:4173`, set the flag to Enabled and relaunch Chrome; the port must be reachable as in path B step 3. Nothing equivalent exists on iOS. Whether the flags UI takes effect without root on every Android build is not verified here; path A is the safe default.

### Sensor permission flows

- iOS Safari 17+: the "Motion & Orientation" prompt appears when `DeviceOrientationEvent.requestPermission()` runs inside the tap (the AR button calls it synchronously, plan D126; there is no Settings toggle since iOS 13); a denial is remembered for the site until Safari's website settings are reset (not verifiable here). The camera prompt follows ("Allow" per session or "Allow for this website"). Safari reports the compass through `webkitCompassHeading`/`webkitCompassAccuracy`; its events carry no `absolute` field.
- Android Chrome 120+: `deviceorientationabsolute` fires without a prompt (from Chrome 152 `requestPermission()` exists and answers the sensors permission state, `granted` by default); the camera prompt is the only dialog; WebXR asks its own consent and may propose installing Google Play Services for AR.

### Plumbing check in Brave on the Windows host (no phone)

Launch Brave through interop with the fake camera (`cmd.exe /c start brave.exe --use-fake-device-for-media-stream --use-fake-ui-for-media-stream`; whether Brave honours the two Chromium switches is a host-run observation), open the preview URL, switch on the device toolbar (a touch emulation, so `maxTouchPoints > 0` and the AR button appears) and DevTools > More tools > Sensors > Orientation > Custom orientation, which drives the relative `deviceorientation` events only: the app shows "No compass" with the manual-north hint and the test pattern behind the stars. It checks the plumbing, the layout, the degraded alerts (the fake camera can be denied through the site settings) and the badge; it cannot check the heading accuracy, `webkitCompassHeading`, WebXR or the camera field of view: those are rows of the manual checklist in `docs/testing.md`.

### Why not `@vitejs/plugin-basic-ssl` on a phone (backlog B-82)

Brief l.548 names the plugin; its certificate (`frontend/node_modules/.vite/basic-ssl/_cert.pem`, `certificate.mjs` of the 2.3.0 release) is a self-signed non-CA leaf: `basicConstraints cA` is commented out, the SAN lists `localhost`, `127.0.0.1`, `[::1]`, `fe80::1` and the `domains` option as DNS names only (a LAN IP cannot be an IP SAN), it is valid 30 days and it is regenerated with `node_modules`. Android refuses to install it as a CA and iOS cannot grant it full trust, so the M4 draft's step "install `_cert.pem` on the phone" never worked; the plugin stays the desktop convenience (accept the warning once on `https://localhost:5173`).

## Playwright browsers and system libraries

`make setup` downloads the Playwright 1.63 browsers (`playwright install chromium webkit`: Chromium 153 as `chromium-1243`, its headless shell, WebKit `webkit-2359`; all have debian13-arm64 builds), but launching them needs shared libraries that a fresh WSL Debian lacks (libnss3, libgbm1, libasound2, libwoff2dec, ...). Two ways to get them:

1. With sudo, once:

   ```bash
   sudo env "PATH=$PATH" fnm exec --using="$PWD/.node-version" npm --prefix frontend exec -- playwright install-deps   # from the repository root
   ```

2. Without sudo, a user-space library directory (verified 2026-09-06 on this Debian 13 aarch64): resolve Playwright's Debian 13 Chromium package list (`playwright-core/lib/coreBundle.js`, the `debian13-*` entry) with `apt-get install --print-uris` (no root needed), download the `.deb` files, extract each with `dpkg-deb -x <file> ~/.local/pw-libs`, then export the two variables before any Playwright command:

   ```bash
   L="$HOME/.local/pw-libs/usr/lib/aarch64-linux-gnu"
   export LD_LIBRARY_PATH="$L:$L/pulseaudio" FONTCONFIG_PATH="$HOME/.local/pw-libs/etc/fonts"
   export FONTCONFIG_FILE="$HOME/.local/pw-libs/fonts.conf"
   make e2e
   ```

   `FONTCONFIG_FILE` is needed since M4 (found 2026-09-09): with only `FONTCONFIG_PATH` set, any page with a native `<select>` or `<input>` kills the headless shell with `FATAL SkFontMgr_FontConfigInterface.cpp Not implemented`, because the copied `etc/fonts/fonts.conf` lists `/usr/share/fonts` as its font directory and that directory does not exist on this WSL (the extracted fonts live under `~/.local/pw-libs/usr/share/fonts`), so the system-UI font of the form controls has no match; plain text pages never hit it, which is why the M3 runs passed. Write a private configuration whose `<dir>` is the extracted font directory, which includes the extracted `conf.d` with `ignore_missing` and names a writable cache directory (absolute paths, `<you>` being your user name; the file below is the one the M4 runs used), and point `FONTCONFIG_FILE` at it:

   ```xml
   <?xml version="1.0"?>
   <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
   <fontconfig>
     <dir>/home/<you>/.local/pw-libs/usr/share/fonts</dir>
     <include ignore_missing="yes">/home/<you>/.local/pw-libs/etc/fonts/conf.d</include>
     <cachedir>/home/<you>/.local/pw-libs/fc-cache</cachedir>
   </fontconfig>
   ```

   The headless shell and full Chromium (`channel: 'chromium'`) both launch; WebGL2 renders through SwiftShader; `TextRunHarfBuzz error` lines on stderr are font noise from the extracted fontconfig and can be ignored. WebKit does not launch this way: with the Chromium package list extracted it still reports 45 missing libraries (gstreamer 1.0, gtk-4, ICU 76, flite, libjxl, libsoup 3, ...), so the `webkit` project needs the sudo path.

CI needs neither: it runs `playwright install --with-deps chromium`. WebKit stays a manual, local run (`npm run e2e -- --project=webkit` from `frontend/`).

## Checking the sky from a Windows browser

Headless SwiftShader is slow and has no WebGPU worth measuring; a browser on the Windows host uses the real GPU. WSL 2 forwards `localhost` ports to Windows, so:

```bash
fnm exec --using="$PWD/.node-version" npm --prefix frontend run build:e2e   # the build with window.__sky (make build-e2e)
fnm exec --using="$PWD/.node-version" npm --prefix frontend run preview     # http://127.0.0.1:4173, proxies /api to 8000
```

with the API running on 8000 (`make dev-api`, or `SKYAPI_DATA_DIR=../data SKYAPI_EPHEMERIS=de440s.bsp SKYAPI_AUTO_FETCH=false uv run --directory backend fastapi run --port 8000` when no `.env` exists). Open `http://localhost:4173/?body=earth&lat=51.48&lon=0&elev=0&t=2460409.25&speed=0` in Chrome, Edge or Brave on Windows; `await window.__sky.ready` then `window.__sky.backend` (expect `webgpu` on a WebGPU-capable GPU, `webgl2` with `#engine=webgl2` appended), `window.__sky.fps()` after ten seconds and `window.__sky.state().parseMs` give the numbers `docs/testing.md` records. Plain HTTP on `localhost` is a secure context, so `navigator.gpu` is available; the dev server on 5173 (HTTPS, self-signed) works too after accepting the certificate.

To measure instead of look, add the self-test hash of the debug hook (dev and e2e builds only): `http://localhost:4173/?body=earth&lat=51.48&lon=0&elev=0&t=2460409.25&speed=0&az=0&alt=45&fov=60#engine=webgpu&selftest` renders for 10 s after the first frame and overlays a JSON report (`backend`, `adapterInfo`, `fps`, `frameMs`, `parseMs`, Polaris against the latitude, every body against `/sky/altaz`); `#engine=webgl2&selftest` does the same on WebGL2, and `&report=http://localhost:<port>/report` POSTs the report to a collector listening in WSL (Windows reaches WSL ports on `localhost` in the default NAT mode). The 2026-09-06 host-GPU numbers in `docs/testing.md` come from this recipe with Brave 152.

For the M4 measurement every layer is switched on through the URL (the full local data with the MPC tables must be served, so `minor` has something to draw): `http://localhost:4173/?body=earth&lat=51.48&lon=0&elev=0&t=2460409.25&speed=0&az=0&alt=45&fov=60&layers=stars,planets,dso,minor,clines,cnames,cbounds,azgrid,eqgrid,ecliptic,meridian,horizon&labels=3&atm=1&ground=dim#engine=webgpu&selftest&report=http://localhost:<port>/report`, then the same URL with `#engine=webgl2&selftest...`, then both again with `&night=0.6` appended to the query (red monochrome through the shaders and the tokens). `atm=1` at this instant paints a daylight sky (the Sun is up from Greenwich at TT 2460409.25), which is the heavier case for the background pass; the report's `fps`, `frameMs` and `parseMs` go to the M4 rows of `docs/testing.md`. Open the same URLs without `selftest` to look at the panels on the desktop, and use Brave's device emulation for the bottom sheet (a phone class measurement needs a real phone, M6).

## Geolocation and secure contexts

The observer panel asks the browser for the position on a first visit (OBS-1) and `navigator.geolocation` exists only in a secure context. Plain HTTP on `http://localhost` and `http://127.0.0.1` is a secure context, so the prompt appears on the dev server, on `vite preview` and under Playwright; plain HTTP over the LAN (`http://192.168.x.y:5173`) is not, and the panel then shows the `insecure` hint ("Geolocation needs a secure (https) connection") while the sky stays on Greenwich. A phone therefore needs a secure context, one of the three paths of "Reaching the app from a phone" above (plain-HTTP `localhost` through port forwarding, HTTPS with a mkcert certificate, or the insecure-origin exception), which is also what the clipboard (`navigator.clipboard`, the share link), the camera, the orientation permission and WebGPU require; the share button falls back to a selectable field when the clipboard is unavailable.

## Data directory

`SKYAPI_DATA_DIR` defaults to `../data` relative to `backend/` (the working directory of every backend command), that is the repository's gitignored `data/`. `sky-data fetch` (M1) fills it; never `cat` a file from it (use `head -c`, `wc -c` or a Python one-liner). From M7, docker compose bind-mounts `SKY_DATA_DIR` (default `./data`) on the same directory.
