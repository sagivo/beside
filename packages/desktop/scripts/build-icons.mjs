import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'assets', 'icon.png');
const buildDir = path.join(root, 'build');
const iconPng = path.join(buildDir, 'icon.png');
const iconset = path.join(buildDir, 'icon.iconset');
const sizes = [16, 32, 64, 128, 256, 512, 1024];
const trayTemplates = [
  { file: 'trayTemplate.png', canvas: 22, maxWidth: 21, maxHeight: 18 },
  { file: 'trayTemplate@2x.png', canvas: 44, maxWidth: 42, maxHeight: 36 },
];

async function findAlphaBounds(input, threshold = 1) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels + 3] <= threshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return { left: 0, top: 0, width: info.width, height: info.height };
  }

  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function buildTrayTemplate({ file, canvas, maxWidth, maxHeight }) {
  const bounds = await findAlphaBounds(src);
  const alpha = await sharp(src)
    .extract(bounds)
    .resize(maxWidth, maxHeight, { fit: 'inside', kernel: 'lanczos3' })
    .ensureAlpha()
    .extractChannel('alpha')
    .threshold(8)
    .blur(0.3)
    .png()
    .toBuffer();
  const meta = await sharp(alpha).metadata();
  const glyph = await sharp({
    create: {
      width: meta.width,
      height: meta.height,
      channels: 3,
      background: '#000000',
    },
  })
    .joinChannel(alpha)
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{
      input: glyph,
      left: Math.floor((canvas - meta.width) / 2),
      top: Math.floor((canvas - meta.height) / 2),
    }])
    .png()
    .toFile(path.join(root, 'assets', file));
}

await fs.mkdir(buildDir, { recursive: true });
await sharp(src).resize(1024, 1024).png().toFile(iconPng);
await Promise.all(trayTemplates.map(buildTrayTemplate));

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

console.log(`[desktop] built app icons in ${path.relative(root, buildDir)} and tray templates in assets`);
