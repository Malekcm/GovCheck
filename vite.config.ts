import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false } },
  },
});
