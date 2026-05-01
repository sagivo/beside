import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
await fs.copyFile(
  path.join(root, 'src', 'preload.cjs'),
  path.join(root, 'dist', 'preload.cjs'),
);
