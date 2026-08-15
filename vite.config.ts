import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The frontend lives in web/. Two aliases:
//   @        → web/src        (shadcn / prompt-kit convention)
//   @shared  → shared/        (the event types the server also uses)
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Local dev: the browser talks to vite (5173), so forward the backend's
    // socket + API endpoints to the harness server (8787). In production the
    // backend serves the built bundle itself, so no proxy is involved.
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': 'http://localhost:8787',
    },
    // allow importing files from outside web/ (i.e. shared/)
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
  },
});
