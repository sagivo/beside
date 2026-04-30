#!/usr/bin/env node
/**
 * Compile every drop-in plugin folder under `plugins/<layer>/<plugin>/`.
 * A plugin folder needs only:
 *
 *   plugin.json           manifest (layer, interface, entrypoint, ...)
 *   src/<entry>.ts        source files
 *
 * No package.json, no tsconfig.json, no pnpm-workspace entry. We invoke
 * `tsc` once with a synthesised config that points at the plugin's src
 * dir and emits to its dist dir. Type-checks only against the workspace
 * @cofounderos/{interfaces,core} packages.
 */
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const LAYERS = ['capture', 'storage', 'model', 'index', 'export'];
const ROOTS = ['plugins'];

// On Windows, executables installed by package managers are usually
// `.cmd` shims (e.g. `pnpm.cmd`). Node's `spawn` without `shell: true`
// won't resolve those, so we have to invoke them through the OS shell.
const NEEDS_SHELL = process.platform === 'win32';

async function findPlugins() {
  const out = [];
  for (const r of ROOTS) {
    for (const layer of LAYERS) {
      const dir = path.join(root, r, layer);
      if (!existsSync(dir)) continue;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const pluginDir = path.join(dir, e.name);
        if (existsSync(path.join(pluginDir, 'plugin.json'))) {
          out.push(pluginDir);
        }
      }
    }
  }
  return out;
}

async function compilePlugin(pluginDir) {
  const manifest = JSON.parse(await readFile(path.join(pluginDir, 'plugin.json'), 'utf8'));
  const srcDir = path.join(pluginDir, 'src');
  if (!existsSync(srcDir)) {
    console.log(`[plugins] skip ${path.relative(root, pluginDir)} — no src/`);
    return;
  }
  const distDir = path.join(pluginDir, 'dist');
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const tmpConfig = path.join(pluginDir, '.tsconfig.build.json');
  // We override `module` to `ESNext` so tsc emits `import`/`export`
  // syntax even though there's no `package.json` next to the source
  // declaring `"type": "module"`. The dist/package.json marker (written
  // after compilation) tells Node to treat the emitted .js as ESM.
  const config = {
    extends: path.relative(pluginDir, path.join(root, 'tsconfig.base.json')),
    compilerOptions: {
      outDir: 'dist',
      rootDir: 'src',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      composite: false,
      declaration: true,
    },
    include: ['src/**/*'],
  };
  await writeFile(tmpConfig, JSON.stringify(config, null, 2));

  await new Promise((resolve, reject) => {
    const tsc = spawn('pnpm', ['exec', 'tsc', '-p', tmpConfig], {
      cwd: root,
      stdio: 'inherit',
      shell: NEEDS_SHELL,
    });
    tsc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tsc failed for ${pluginDir} (exit ${code})`));
    });
  });
  await rm(tmpConfig, { force: true });

  // Mark dist/ as ESM so Node treats `.js` files as ES modules. The
  // plugin folder itself stays clean (no top-level package.json) — this
  // marker is generated alongside the build output.
  await writeFile(
    path.join(distDir, 'package.json'),
    JSON.stringify({ type: 'module' }, null, 2) + '\n',
  );

  // Run the plugin's optional native-helper build script. This is the
  // hook we use for things like `capture/node`'s Swift AX-text helper
  // — code that can't (or shouldn't) be compiled by tsc. The script is
  // expected to be best-effort: it must exit 0 if its toolchain is
  // missing on the host, so cross-platform installs aren't blocked.
  //
  // We only invoke it on POSIX hosts (`bash` is not on PATH in vanilla
  // Windows shells). All current native helpers are macOS-only and the
  // script body itself short-circuits on non-Darwin, so skipping the
  // spawn entirely on Windows costs us nothing.
  const nativeScript = path.join(pluginDir, 'scripts/build-native.sh');
  if (existsSync(nativeScript) && process.platform !== 'win32') {
    await new Promise((resolve, reject) => {
      const sh = spawn('bash', [nativeScript], {
        cwd: pluginDir,
        stdio: 'inherit',
      });
      sh.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`native build script failed for ${pluginDir} (exit ${code})`));
      });
      sh.on('error', (err) => {
        // `bash` may be missing on minimal Linux environments too.
        // Treat that as "no native helper to build" rather than fatal.
        if (err && err.code === 'ENOENT') resolve();
        else reject(err);
      });
    });
  }

  console.log(`[plugins] built ${manifest.name} (${manifest.layer})`);
}

const plugins = await findPlugins();
if (plugins.length === 0) {
  console.log('[plugins] no plugins found');
  process.exit(0);
}
for (const p of plugins) {
  await compilePlugin(p);
}
