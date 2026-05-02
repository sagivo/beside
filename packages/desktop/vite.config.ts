import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(here, 'src', 'renderer'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.join(here, 'src', 'renderer', 'src'),
    },
  },
  base: './',
  build: {
    outDir: path.join(here, 'dist', 'renderer'),
    emptyOutDir: true,
  },
});
