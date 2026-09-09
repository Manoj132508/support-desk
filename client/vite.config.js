import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Port 5179 is deliberate: Project 1 uses 5177 and Project 2 uses 5178, so all
 * three can run side by side in an interview without a port collision.
 *
 * The /api proxy means the client always calls a same-origin path. That is not
 * cosmetic -- the session cookie is httpOnly + SameSite, and a cross-origin
 * call in development would either be blocked or need CORS credentials
 * configured differently from production. Proxying keeps development and
 * production on the same code path.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5179,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4400',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
    css: false,
  },
});
