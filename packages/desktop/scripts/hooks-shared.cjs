/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const desktopNodeModules = path.join(desktopRoot, 'node_modules');
const stagedSharp = path.join(desktopNodeModules, 'sharp');
const stagedImg = path.join(desktopNodeModules, '@img');

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else if (entry.isSymbolicLink()) await fsp.copyFile(await fsp.realpath(s), d);
    else if (entry.isFile()) await fsp.copyFile(s, d);
  }
}

async function clean() {
  await fsp.rm(stagedSharp, { recursive: true, force: true });
  await fsp.rm(stagedImg, { recursive: true, force: true });
}

const archNames = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

async function stageSharpForArch(electronPlatformName, archIndex) {
  const archName = archNames[archIndex] ?? String(archIndex);
  const platform = electronPlatformName === 'mas' ? 'darwin' : electronPlatformName;
  await clean();

  const runtimeRequire = createRequire(path.join(repoRoot, 'packages', 'runtime', 'package.json'));
  const sharpPkgJson = runtimeRequire.resolve('sharp/package.json');
  const sharpPkgDir = path.dirname(sharpPkgJson);
  const imgRoot = path.join(path.dirname(sharpPkgDir), '@img');

  const required = [`sharp-${platform}-${archName}`, `sharp-libvips-${platform}-${archName}`];
  const have = fs.existsSync(imgRoot) ? await fsp.readdir(imgRoot) : [];
  const missing = required.filter((n) => !have.includes(n));
  if (missing.length) {
    throw new Error(
      `[desktop] missing sharp native packages for ${platform}-${archName}: ${missing.join(', ')}.\n` +
        `Install them before packaging, e.g.:\n` +
        `  npm_config_arch=${archName} npm_config_platform=${platform} pnpm install`,
    );
  }

  await copyDir(sharpPkgDir, stagedSharp);
  for (const name of required) {
    const real = await fsp.realpath(path.join(imgRoot, name));
    await copyDir(real, path.join(stagedImg, name));
  }
  console.log(`[desktop] staged sharp + @img/{${required.join(', ')}} for ${platform}-${archName}`);
}

module.exports = { stageSharpForArch, clean };
