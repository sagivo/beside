import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  ICapture,
  IStorage,
  IModelAdapter,
  IIndexStrategy,
  IExport,
  PluginManifest,
  PluginLayer,
  PluginInterfaceName,
  PluginHostContext,
  PluginFactory,
  Logger,
} from '@beside/interfaces';

export interface PluginRegistryEntry {
  packageName: string;        // npm package name, e.g. @beside/storage-local
  manifest: PluginManifest;
  /** Absolute path to the package directory. */
  rootDir: string;
  /** Absolute path to the entrypoint .js file (resolved from manifest). */
  entrypointPath: string;
}

const INTERFACE_BY_LAYER: Record<PluginLayer, PluginInterfaceName> = {
  capture: 'ICapture',
  storage: 'IStorage',
  model: 'IModelAdapter',
  index: 'IIndexStrategy',
  export: 'IExport',
};

/**
 * Discovers plugin packages installed in node_modules. Each plugin must
 * ship a `plugin.json` next to its `package.json`. We scan @beside/*
 * and any package whose `package.json` has `beside: { plugin: true }`.
 */
export async function discoverPlugins(workspaceRoot: string, logger: Logger): Promise<PluginRegistryEntry[]> {
  const log = logger.child('plugin-loader');
  const seen = new Map<string, PluginRegistryEntry>();

  const candidates = await collectCandidatePackageDirs(workspaceRoot);
  for (const pkgDir of candidates) {
    try {
      const entry = await loadEntry(pkgDir);
      if (!entry) continue;
      if (seen.has(entry.packageName)) continue;
      seen.set(entry.packageName, entry);
      log.debug(`discovered plugin ${entry.packageName} (${entry.manifest.layer})`);
    } catch (err) {
      log.warn(`skipping ${pkgDir}: ${(err as Error).message}`);
    }
  }

  return [...seen.values()];
}

/**
 * Walk the `plugins/` tree (built-in + third-party plugins live here):
 *   plugins/<layer>/<plugin>/                — drop-in plugin folder
 *   plugins/<plugin>/                        — flat layout still supported
 *
 * Workspace packages under `packages/` (interfaces, core, app) are NOT
 * plugins and are intentionally excluded — they're the host. We also
 * still scan `node_modules/@beside/*` so npm-installed plugins
 * shipped as packages keep working.
 *
 * A directory is treated as a candidate if it contains either a
 * `plugin.json` (real plugin) OR a `package.json` (might be a layer
 * container — we descend one more level in that case).
 */
async function collectCandidatePackageDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];
  const visited = new Set<string>();

  const consider = async (full: string): Promise<void> => {
    if (visited.has(full)) return;
    visited.add(full);
    dirs.push(full);
  };

  for (const sub of ['plugins']) {
    const d = path.join(root, sub);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const layerOrFlat = path.join(d, e.name);

      // If this folder is itself a plugin (has plugin.json) we consider it
      // directly. We also still consider anything with package.json so the
      // existing flat layout (e.g. packages/interfaces/) keeps working.
      const hasManifest = await pathExists(path.join(layerOrFlat, 'plugin.json'));
      const hasPackage = await pathExists(path.join(layerOrFlat, 'package.json'));
      if (hasManifest || hasPackage) {
        await consider(layerOrFlat);
      }

      // If the folder is a layer container (no own plugin.json/package.json,
      // OR is a layer container that holds plugins), descend one more level.
      let nested: import('node:fs').Dirent[];
      try {
        nested = await fs.readdir(layerOrFlat, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const n of nested) {
        if (!n.isDirectory()) continue;
        const child = path.join(layerOrFlat, n.name);
        const childHasManifest = await pathExists(path.join(child, 'plugin.json'));
        const childHasPackage = await pathExists(path.join(child, 'package.json'));
        if (childHasManifest || childHasPackage) {
          await consider(child);
        }
      }
    }
  }

  // node_modules — installed plugins shipped under @beside/*.
  try {
    const ns = path.join(root, 'node_modules', '@beside');
    const entries = await fs.readdir(ns, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      await consider(path.join(ns, e.name));
    }
  } catch {
    // ignore
  }

  return dirs;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadEntry(rootDir: string): Promise<PluginRegistryEntry | null> {
  const manifestPath = path.join(rootDir, 'plugin.json');
  const pkgPath = path.join(rootDir, 'package.json');

  let manifestText: string;
  try {
    manifestText = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return null; // not a plugin
  }

  const manifest = JSON.parse(manifestText) as PluginManifest;
  validateManifest(manifest);

  // package.json is optional — drop-in plugins (folder + plugin.json + an
  // entrypoint) don't need pnpm metadata. If present we surface the npm
  // name for diagnostics; otherwise we synthesise one from the layer +
  // manifest name so logs and `plugin list` still read sensibly.
  let packageName = `${manifest.layer}/${manifest.name}`;
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as { name?: string };
    if (pkg.name) packageName = pkg.name;
  } catch {
    // no package.json — fine
  }

  const entrypointPath = path.resolve(rootDir, manifest.entrypoint);
  return {
    packageName,
    manifest,
    rootDir,
    entrypointPath,
  };
}

function validateManifest(m: PluginManifest): void {
  if (!m.name) throw new Error('plugin.json: name required');
  if (!m.version) throw new Error('plugin.json: version required');
  if (!m.layer) throw new Error('plugin.json: layer required');
  if (!m.entrypoint) throw new Error('plugin.json: entrypoint required');
  const expected = INTERFACE_BY_LAYER[m.layer];
  if (!expected) {
    throw new Error(`plugin.json: unknown layer "${m.layer}"`);
  }
  if (m.interface && m.interface !== expected) {
    throw new Error(
      `plugin.json: layer "${m.layer}" requires interface "${expected}", got "${m.interface}"`,
    );
  }
}

export class PluginRegistry {
  constructor(
    private readonly entries: PluginRegistryEntry[],
    private readonly logger: Logger,
  ) {}

  list(): PluginRegistryEntry[] {
    return [...this.entries];
  }

  byLayer(layer: PluginLayer): PluginRegistryEntry[] {
    return this.entries.filter((e) => e.manifest.layer === layer);
  }

  /**
   * Resolve a plugin by short name or full package name. The short name
   * is the suffix after the layer prefix in built-in packages
   * (e.g. "local" matches "@beside/storage-local").
   */
  resolve(layer: PluginLayer, name: string): PluginRegistryEntry {
    const candidates = this.byLayer(layer);
    const match = candidates.find(
      (e) =>
        e.manifest.name === name ||
        e.packageName === name ||
        e.packageName.endsWith(`/${layer}-${name}`) ||
        e.packageName.endsWith(`/${name}`),
    );
    if (!match) {
      const names = candidates.map((c) => c.manifest.name).join(', ') || '(none)';
      throw new Error(
        `No plugin for layer "${layer}" matched name "${name}". Available: ${names}.`,
      );
    }
    return match;
  }

  async instantiate<T>(
    entry: PluginRegistryEntry,
    context: PluginHostContext,
  ): Promise<T> {
    const url = pathToFileURL(entry.entrypointPath).href;
    const mod = (await import(url)) as { default?: PluginFactory<T> };
    const factory = mod.default;
    if (typeof factory !== 'function') {
      throw new Error(
        `Plugin ${entry.packageName} entrypoint must export default factory function`,
      );
    }
    return await factory(context);
  }

  // Convenience typed instantiators.

  async loadCapture(name: string, ctx: PluginHostContext): Promise<ICapture> {
    return this.instantiate<ICapture>(this.resolve('capture', name), ctx);
  }

  async loadStorage(name: string, ctx: PluginHostContext): Promise<IStorage> {
    return this.instantiate<IStorage>(this.resolve('storage', name), ctx);
  }

  async loadModel(name: string, ctx: PluginHostContext): Promise<IModelAdapter> {
    return this.instantiate<IModelAdapter>(this.resolve('model', name), ctx);
  }

  async loadIndexStrategy(name: string, ctx: PluginHostContext): Promise<IIndexStrategy> {
    return this.instantiate<IIndexStrategy>(this.resolve('index', name), ctx);
  }

  async loadExport(name: string, ctx: PluginHostContext): Promise<IExport> {
    return this.instantiate<IExport>(this.resolve('export', name), ctx);
  }
}

/**
 * Convenience: walk up from `start` looking for a directory containing
 * pnpm-workspace.yaml. Used by the CLI to find the workspace root regardless
 * of where it was invoked from.
 */
export function findWorkspaceRoot(start: string): string {
  let cur = path.resolve(start);
  while (true) {
    if (fsSync.existsSync(path.join(cur, 'pnpm-workspace.yaml'))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      return path.resolve(start);
    }
    cur = parent;
  }
}
