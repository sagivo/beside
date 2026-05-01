import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'assets', 'icon.svg');
const buildDir = path.join(root, 'build');
const iconPng = path.join(buildDir, 'icon.png');
const iconset = path.join(buildDir, 'icon.iconset');
const sizes = [16, 32, 64, 128, 256, 512, 1024];

await fs.mkdir(buildDir, { recursive: true });
await sharp(src).resize(1024, 1024).png().toFile(iconPng);

if (process.platform === 'darwin') {
  await fs.rm(iconset, { recursive: true, force: true });
  await fs.mkdir(iconset, { recursive: true });
  for (const size of sizes) {
    await sharp(src).resize(size, size).png().toFile(path.join(iconset, `icon_${size}x${size}.png`));
    if (size <= 512) {
      await sharp(src).resize(size * 2, size * 2).png().toFile(path.join(iconset, `icon_${size}x${size}@2x.png`));
    }
  }
  await new Promise((resolve, reject) => {
    const child = spawn('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`iconutil exited ${code}`)));
    child.on('error', reject);
  });
}

console.log(`[desktop] built app icons in ${path.relative(root, buildDir)}`);
