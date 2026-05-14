import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const outRoot = path.join(repoRoot, 'packages', 'desktop', 'build', 'resources', 'beside');
const pluginsSrc = path.join(repoRoot, 'plugins');
const pluginsDst = path.join(outRoot, 'plugins');
const nodeModulesDst = path.join(outRoot, 'node_modules');
const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'));

const PLUGIN_RUNTIME_PACKAGES = [
  '@beside/core',
  '@beside/interfaces',
  '@modelcontextprotocol/sdk',
  'active-win',
  'better-sqlite3',
  'ollama',
  'screenshot-desktop',
  'sharp',
  'zod',
];

const ARCH_ALIASES = new Map([
  ['aarch64', 'arm64'],
  ['amd64', 'x64'],
  ['x86_64', 'x64'],
]);

await fs.rm(outRoot, { recursive: true, force: true });
await fs.mkdir(pluginsDst, { recursive: true });

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dst, filter = () => true) {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (!filter(srcPath, entry)) continue;
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath, filter);
    } else if (entry.isSymbolicLink()) {
      await fs.copyFile(await fs.realpath(srcPath), dstPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, dstPath);
    }
  }
}

async function findPackageRoot(packageName, resolver = requireFromRoot) {
  let resolved;
  try {
    resolved = resolver.resolve(`${packageName}/package.json`);
  } catch {
    try {
      resolved = resolver.resolve(packageName);
    } catch {
      return await fs.realpath(path.join(repoRoot, 'node_modules', ...packageName.split('/')));
    }
  }

  // Walk up to the package.json whose `name` matches the requested package.
  // We must NOT stop at sub-package.json markers like `dist/cjs/package.json`
  // that only carry `{"type": "commonjs"}` -- those would make us copy only a
  // sub-tree and miss the package's real dependency list.
  let dir = path.dirname(resolved);
  while (dir !== path.dirname(dir)) {
    const pkgJson = path.join(dir, 'package.json');
    if (await pathExists(pkgJson)) {
      try {
        const pkg = JSON.parse(await fs.readFile(pkgJson, 'utf8'));
        if (pkg.name === packageName) return dir;
      } catch {
        // Continue walking up.
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not find package root for ${packageName}`);
}

function packageDestination(packageName) {
  const parts = packageName.split('/');
  return path.join(nodeModulesDst, ...parts);
}

async function stageRuntimePackage(packageName, seen = new Set(), resolver = requireFromRoot) {
  if (seen.has(packageName)) return;
  seen.add(packageName);

  const root = await findPackageRoot(packageName, resolver);
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  await copyDir(root, packageDestination(packageName), (src, entry) => {
    if (entry.name === 'node_modules') return false;
    if (entry.name === '.git') return false;
    if (src.includes(`${path.sep}test${path.sep}`) || src.includes(`${path.sep}tests${path.sep}`)) return false;
    return true;
  });

  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
  const childResolver = createRequire(path.join(root, 'package.json'));
  for (const dep of Object.keys(deps)) {
    try {
      await stageRuntimePackage(dep, seen, childResolver);
    } catch {
      // Optional packages are often platform-specific. Missing ones are fine
      // as long as the package for this build's platform is present.
    }
  }
}

async function stageSharpNativePackages() {
  const arch = ARCH_ALIASES.get(process.env.BESIDE_BUILD_ARCH) ?? process.env.BESIDE_BUILD_ARCH ?? process.arch;
  const platform = process.platform;
  const required = [`sharp-${platform}-${arch}`, `sharp-libvips-${platform}-${arch}`];
  const runtimeRequire = createRequire(path.join(repoRoot, 'packages', 'runtime', 'package.json'));
  const sharpPkgDir = path.dirname(runtimeRequire.resolve('sharp/package.json'));
  const imgRoot = path.join(path.dirname(sharpPkgDir), '@img');

  for (const name of required) {
    const src = path.join(imgRoot, name);
    if (!await pathExists(src)) {
      throw new Error(`[desktop] missing sharp native package @img/${name}`);
    }
    await copyDir(src, path.join(nodeModulesDst, '@img', name));
  }
  console.log(`[desktop] staged plugin sharp natives @img/{${required.join(', ')}}`);
}

for (const layer of await fs.readdir(pluginsSrc, { withFileTypes: true })) {
  if (!layer.isDirectory()) continue;
  const layerSrc = path.join(pluginsSrc, layer.name);
  const layerDst = path.join(pluginsDst, layer.name);
  for (const plugin of await fs.readdir(layerSrc, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const pluginSrc = path.join(layerSrc, plugin.name);
    const pluginDst = path.join(layerDst, plugin.name);
    const manifest = path.join(pluginSrc, 'plugin.json');
    const dist = path.join(pluginSrc, 'dist');
    if (!await pathExists(manifest) || !await pathExists(dist)) continue;
    await fs.mkdir(pluginDst, { recursive: true });
    await fs.copyFile(manifest, path.join(pluginDst, 'plugin.json'));
    await copyDir(dist, path.join(pluginDst, 'dist'));
  }
}

for (const packageName of PLUGIN_RUNTIME_PACKAGES) {
  await stageRuntimePackage(packageName);
}
await stageSharpNativePackages();

await fs.writeFile(
  path.join(outRoot, 'README.txt'),
  'Beside runtime resources. Generated by packages/desktop/scripts/prepare-package-resources.mjs.\n',
  'utf8',
);

console.log(`[desktop] prepared package resources at ${path.relative(repoRoot, outRoot)}`);

