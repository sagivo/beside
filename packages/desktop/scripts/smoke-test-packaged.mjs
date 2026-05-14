// Verify a packaged Beside.app can load every plugin entrypoint from inside
// Electron's Node runtime. This catches missing runtime dependencies (e.g.
// peer/transitive packages that didn't make it into the staged node_modules)
// BEFORE we sign/notarize/upload a release.
//
// Usage: node smoke-test-packaged.mjs <path-to-Beside.app>
//
// Exits non-zero if any plugin fails to load.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const appPath = process.argv[2];
if (!appPath) {
  console.error('usage: smoke-test-packaged.mjs <path-to-Beside.app>');
  process.exit(2);
}

const resourceRoot = path.join(appPath, 'Contents', 'Resources', 'beside');
const electronExe = path.join(appPath, 'Contents', 'MacOS', 'Beside');

// Walk plugins/<layer>/<plugin>/plugin.json to discover entrypoints.
const pluginsDir = path.join(resourceRoot, 'plugins');
const plugins = [];
for (const layer of await fs.readdir(pluginsDir, { withFileTypes: true })) {
  if (!layer.isDirectory()) continue;
  const layerDir = path.join(pluginsDir, layer.name);
  for (const plugin of await fs.readdir(layerDir, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const manifestPath = path.join(layerDir, plugin.name, 'plugin.json');
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      const entry = path.join(layerDir, plugin.name, manifest.entrypoint);
      plugins.push({ name: `${layer.name}/${plugin.name}`, entry });
    } catch {
      // not a plugin folder
    }
  }
}

console.log(`[smoke] discovered ${plugins.length} plugin entrypoints in ${path.relative(process.cwd(), pluginsDir)}`);

// Run a sub-program inside the packaged Electron-as-Node that imports each
// entrypoint. We pass the plugin list via env to keep argv simple.
const probe = `
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const entries = JSON.parse(process.env.BESIDE_SMOKE_ENTRIES);
let failed = 0;
(async () => {
  for (const { name, entry } of entries) {
    try {
      await import(pathToFileURL(entry).href);
      console.log('[ok ]', name);
    } catch (err) {
      failed += 1;
      console.error('[err]', name, '-', err && err.message ? err.message : String(err));
    }
  }
  process.exit(failed === 0 ? 0 : 1);
})();
`;

const child = spawn(electronExe, ['-e', probe], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    BESIDE_SMOKE_ENTRIES: JSON.stringify(plugins),
  },
  stdio: 'inherit',
});

child.on('exit', (code) => {
  if (code === 0) {
    console.log('[smoke] all plugin entrypoints loaded successfully');
    process.exit(0);
  }
  console.error(`[smoke] FAILED: ${code} plugin(s) could not load`);
  process.exit(1);
});
