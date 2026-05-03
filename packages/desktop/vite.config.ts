import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

// Read version straight from package.json so the About screen always
// matches the bundle that's actually shipping. Doing this at config-load
// time means it's a static replacement in the bundle (no runtime fs).
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')) as {
  version: string;
};

export default defineConfig({
  root: path.join(here, 'src', 'renderer'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.join(here, 'src', 'renderer', 'src'),
    },
  },
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: path.join(here, 'dist', 'renderer'),
    emptyOutDir: true,
  },
});
