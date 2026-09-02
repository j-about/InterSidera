import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

// https://vite.dev/config/ — Vitest reads its `test` block from this same file (plan D14), so
// `defineConfig` comes from 'vitest/config' to type both halves.
export default defineConfig(({ command, mode, isPreview }) => {
  // HTTPS only for the interactive dev server: geolocation, camera, device orientation and WebXR
  // need a secure context on a phone (brief l.95, l.548). `vite preview` stays plain HTTP on 4173
  // so the Playwright web server and CI never deal with a self-signed certificate (plan D15).
  const interactiveDev = command === 'serve' && mode === 'development' && !isPreview;

  return {
    plugins: [react(), tailwindcss(), ...(interactiveDev ? [basicSsl()] : [])],
    server: {
      port: 5173,
      strictPort: true,
      // Same-origin `/api` in development; the API listens on 8000 (brief l.20, l.95). The target
      // is 127.0.0.1, not `localhost`, which Node may resolve to ::1 while uvicorn binds IPv4 only.
      proxy: { '/api': { target: 'http://127.0.0.1:8000' } },
    },
    // `preview.proxy` inherits `server.proxy`, so the e2e smoke test reaches the API through 4173.
    preview: { port: 4173, strictPort: true },
    // build.rolldownOptions.output.codeSplitting is reserved for M3 (lazy engine and AR chunks).
    // Vite 8 is Rolldown-based: never `rollupOptions` / `manualChunks` (brief l.549).
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      // Vitest 4 excludes only node_modules and .git by default; keep the Playwright specs and the
      // build output out of the unit-test run.
      exclude: [...configDefaults.exclude, 'e2e/**', 'dist/**'],
    },
  };
});
