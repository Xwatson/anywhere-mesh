import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const backend = `http://127.0.0.1:${process.env.PORT || 3210}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': backend,
      '/ws': { target: backend, ws: true },
    },
  },
});
