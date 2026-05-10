import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'ui',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': resolve(__dirname, 'ui/src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: '../ui/dist',
    emptyOutDir: true,
  },
});
