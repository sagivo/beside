#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const desktopDir = path.join(root, 'packages', 'desktop');
const releaseDir = path.join(desktopDir, 'release');
const websiteAppPath = path.join(root, 'website', 'src', 'App.tsx');

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  printHelp();
  process.exit(0);
}

if (process.platform !== 'darwin') {
  fail('Desktop macOS releases must be built on macOS.');
}

const rootPkg = await readJson(path.join(root, 'package.json'));
const desktopPkg = await readJson(path.join(desktopDir, 'package.json'));
const version = opts.version ?? desktopPkg.version;
const tag = opts.tag ?? `v${version}`;
const arch = opts.arch;
const productName = desktopPkg.build?.productName ?? 'Beside';
const repo = opts.repo ?? parseGitHubRepo(rootPkg.repository?.url);
const appOutDirName = arch === 'x64' ? 'mac' : `mac-${arch}`;
const artifactBase = `${productName}-${version}-mac-${arch}`;
const appPath = path.join(releaseDir, appOutDirName, `${productName}.app`);
const dmgPath = path.join(releaseDir, `${artifactBase}.dmg`);
const zipPath = path.join(releaseDir, `${artifactBase}.zip`);
const dmgBlockmapPath = `${dmgPath}.blockmap`;
const zipBlockmapPath = `${zipPath}.blockmap`;
const latestMacPath = path.join(releaseDir, 'latest-mac.yml');
const uploadFiles = [dmgPath, dmgBlockmapPath, zipPath, zipBlockmapPath, latestMacPath];

if (!repo) {
  fail('Could not infer GitHub repo from package.json. Pass --repo owner/name.');
}
assertReleaseVersionInputs({ rootPkg, desktopPkg, version, tag, explicitVersion: opts.version });

await assertToolchain();
if (!opts.skipGitCheck) {
  await assertGitReady(opts.allowNonMain);
}

const releaseEnv = makeReleaseEnv(opts);
const notaryArgs = makeNotaryArgs(releaseEnv, opts.notaryProfile);
const signingIdentity = await resolveDeveloperIdIdentity();

step(`Building ${productName} ${version} (${arch})`);
await rm(releaseDir, { recursive: true, force: true });
await run('pnpm', [
  '--filter',
  '@beside/desktop',
  'run',
  'dist',
  '--',
  '--mac',
  `--${arch}`,
  '--publish',
  'never',
], { cwd: root, env: releaseEnv });

await assertArtifactsExist([appPath, dmgPath, zipPath, zipBlockmapPath, latestMacPath]);

step('Checking generated DMG contents');
const initialDmgOk = await verifyDmgContents(dmgPath, productName, { fatal: false });
if (!initialDmgOk) {
  console.warn('[release] electron-builder produced a DMG without the app payload; rebuilding DMG manually.');
  await rebuildDmgFromApp({
    appPath,
    dmgPath,
    dmgBlockmapPath,
    productName,
    version,
    arch,
    signingIdentity,
    notaryArgs,
  });
}

await ensureDmgNotarizedAndStapled({ dmgPath, notaryArgs });

await regenerateDmgBlockmap(dmgPath, dmgBlockmapPath);
await writeLatestMacYml({ version, zipPath, dmgPath, latestMacPath });
await assertArtifactsExist(uploadFiles);

step('Verifying signed and notarized artifacts');
await verifyReleaseArtifacts({ appPath, dmgPath, latestMacPath, productName, version });

if (opts.noUpload) {
  step('Skipping GitHub upload (--no-upload)');
  printLocalSummary(uploadFiles);
  process.exit(0);
}

step(`Publishing ${tag} to ${repo}`);
await prepareTag(tag, opts.forceTag);
await ensureGitHubRelease({ repo, tag, version, productName });
await run('gh', ['release', 'upload', tag, ...uploadFiles, '--repo', repo, '--clobber'], { cwd: root });

step('Verifying GitHub release assets');
const releaseUrl = await verifyRemoteAssets({ repo, tag, files: uploadFiles });
await updateWebsiteDownloadLinks({ repo, tag, version, productName, arch });
printLocalSummary(uploadFiles);
console.log(`\n[release] Done: ${releaseUrl}`);

function parseArgs(argv) {
  const out = {
    arch: 'arm64',
    allowNonMain: false,
    forceTag: false,
    help: false,
    noUpload: false,
    repo: null,
    skipGitCheck: false,
    tag: null,
    version: null,
    notaryProfile: process.env.APPLE_KEYCHAIN_PROFILE || 'beside',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--':
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--allow-non-main':
        out.allowNonMain = true;
        break;
      case '--arch':
        out.arch = readValue(argv, ++i, arg);
        break;
      case '--force-tag':
        out.forceTag = true;
        break;
      case '--no-upload':
        out.noUpload = true;
        break;
      case '--notary-profile':
        out.notaryProfile = readValue(argv, ++i, arg);
        break;
      case '--repo':
        out.repo = readValue(argv, ++i, arg);
        break;
      case '--skip-git-check':
        out.skipGitCheck = true;
        break;
      case '--tag':
        out.tag = readValue(argv, ++i, arg);
        break;
      case '--version':
        out.version = readValue(argv, ++i, arg);
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  if (!['arm64', 'x64'].includes(out.arch)) {
    fail(`Unsupported --arch ${out.arch}. Use arm64 or x64.`);
  }

  return out;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    fail(`${flag} requires a value.`);
  }
  return value;
}

function printHelp() {
  console.log(`Release the signed/notarized Beside macOS desktop app.

Usage:
  pnpm release:desktop
  pnpm release:desktop -- --force-tag
  pnpm release:desktop -- --no-upload

Options:
  --arch arm64|x64          Build architecture. Default: arm64
  --version 0.0.1           Require a specific package version.
  --tag v0.0.1              Release tag. Default: v<desktop package version>
  --repo owner/name         GitHub repo. Default: inferred from package.json
  --notary-profile name     notarytool keychain profile. Default: beside
  --force-tag               Move an existing tag to HEAD and force-push it.
  --no-upload               Build and verify locally, but skip tag/release upload.
  --allow-non-main          Permit releasing from a branch other than main.
  --skip-git-check          Skip clean-worktree and branch checks.

After a successful publish, updates website download links in website/src/App.tsx,
commits, and pushes to main.
`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function assertReleaseVersionInputs(input) {
  const expectedTag = `v${input.version}`;
  if (input.rootPkg.version !== input.desktopPkg.version) {
    fail(`Root package version (${input.rootPkg.version}) must match desktop version (${input.desktopPkg.version}).`);
  }
  if (input.explicitVersion && input.explicitVersion !== input.desktopPkg.version) {
    fail(`--version ${input.explicitVersion} does not match packages/desktop/package.json (${input.desktopPkg.version}).`);
  }
  if (input.tag !== expectedTag) {
    fail(`Release tag (${input.tag}) must match package version (${input.version}); expected ${expectedTag}.`);
  }
}

function parseGitHubRepo(url) {
  if (!url || typeof url !== 'string') return null;
  const https = url.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
  return https?.[1] ?? null;
}

function makeReleaseEnv(options) {
  const env = { ...process.env };
  const hasApiKey = hasAll(env, ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']);
  const hasAppleId = hasAll(env, ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']);
  if (!hasApiKey && !hasAppleId && !env.APPLE_KEYCHAIN_PROFILE && options.notaryProfile) {
    env.APPLE_KEYCHAIN_PROFILE = options.notaryProfile;
  }
  return env;
}

function makeNotaryArgs(env, notaryProfile) {
  const apiVars = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  const idVars = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

  if (hasAny(env, apiVars)) {
    requireAll(env, apiVars);
    return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  }
  if (hasAny(env, idVars)) {
    requireAll(env, idVars);
    return [
      '--apple-id',
      env.APPLE_ID,
      '--password',
      env.APPLE_APP_SPECIFIC_PASSWORD,
      '--team-id',
      env.APPLE_TEAM_ID,
    ];
  }

  const profile = env.APPLE_KEYCHAIN_PROFILE || notaryProfile;
  if (!profile) {
    fail('No notarization credentials found. Set APPLE_KEYCHAIN_PROFILE or Apple API credentials.');
  }
  return ['--keychain-profile', profile];
}

function hasAny(env, names) {
  return names.some((name) => Boolean(env[name]));
}

function hasAll(env, names) {
  return names.every((name) => Boolean(env[name]));
}

function requireAll(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    fail(`Missing required notarization env var(s): ${missing.join(', ')}`);
  }
}

async function assertToolchain() {
  const tools = ['git', 'pnpm', 'gh', 'security', 'xcrun', 'hdiutil', 'codesign', 'spctl', 'ditto', 'sync'];
  for (const tool of tools) {
    await run('/usr/bin/which', [tool], { capture: true, quiet: true });
  }
}

async function assertGitReady(allowNonMain) {
  const branch = (await run('git', ['branch', '--show-current'], { cwd: root, capture: true, quiet: true })).stdout.trim();
  if (branch !== 'main' && !allowNonMain) {
    fail(`Refusing to release from ${branch || 'detached HEAD'}. Use --allow-non-main to override.`);
  }

  const status = (await run('git', ['status', '--porcelain'], { cwd: root, capture: true, quiet: true })).stdout.trim();
  if (status) {
    fail(`Refusing to release with a dirty worktree:\n${status}\nCommit or stash changes, or use --skip-git-check.`);
  }
}

async function resolveDeveloperIdIdentity() {
  const result = await run('security', ['find-identity', '-v', '-p', 'codesigning'], {
    capture: true,
    quiet: true,
  });
  const match = result.stdout.match(/"([^"]*Developer ID Application[^"]*)"/);
  if (!match) {
    fail('No valid Developer ID Application signing identity found in Keychain.');
  }
  return match[1];
}

async function assertArtifactsExist(files) {
  for (const file of files) {
    if (!existsSync(file)) {
      fail(`Expected artifact is missing: ${rel(file)}`);
    }
  }
}

async function verifyDmgContents(dmg, expectedProductName, { fatal }) {
  const mount = await mkdtemp(path.join(os.tmpdir(), 'beside-dmg-verify.'));
  let attached = false;
  try {
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], {
      capture: true,
      quiet: true,
    });
    attached = true;
    const mountedApp = path.join(mount, `${expectedProductName}.app`);
    const applicationsLink = path.join(mount, 'Applications');
    const appStat = await stat(mountedApp);
    const linkStat = await stat(applicationsLink);
    if (!appStat.isDirectory() || !linkStat.isDirectory()) {
      throw new Error('DMG did not contain the expected app and Applications link.');
    }
    return true;
  } catch (error) {
    if (fatal) {
      throw new Error(`DMG contents check failed for ${rel(dmg)}: ${error.message}`);
    }
    return false;
  } finally {
    if (attached) {
      await run('hdiutil', ['detach', mount], { capture: true, quiet: true, check: false });
    }
    await rm(mount, { recursive: true, force: true });
  }
}

async function rebuildDmgFromApp(input) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'beside-dmg-work.'));
  const mount = path.join(workDir, 'mnt');
  const rwDmg = path.join(workDir, `${input.productName}-rw.dmg`);
  let attached = false;

  try {
    await mkdir(mount, { recursive: true });
    await rm(input.dmgPath, { force: true });
    await rm(input.dmgBlockmapPath, { force: true });

    const appSizeMb = await duMb(input.appPath);
    const imageSizeMb = Math.ceil(appSizeMb * 1.35 + 128);

    await run('hdiutil', [
      'create',
      '-size',
      `${imageSizeMb}m`,
      '-fs',
      'HFS+',
      '-volname',
      `${input.productName} ${input.version}-${input.arch}`,
      '-ov',
      rwDmg,
    ]);
    await run('hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, rwDmg]);
    attached = true;
    await run('ditto', ['--rsrc', '--extattr', '--acl', input.appPath, path.join(mount, `${input.productName}.app`)]);
    await symlink('/Applications', path.join(mount, 'Applications'));
    await run('sync', []);
    await run('hdiutil', ['detach', mount]);
    attached = false;

    await run('hdiutil', ['convert', rwDmg, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', input.dmgPath]);
    await run('codesign', ['--force', '--sign', input.signingIdentity, '--timestamp', input.dmgPath]);
    await run('xcrun', ['notarytool', 'submit', input.dmgPath, ...input.notaryArgs, '--wait', '--output-format', 'json']);
    await run('xcrun', ['stapler', 'staple', input.dmgPath]);
  } finally {
    if (attached) {
      await run('hdiutil', ['detach', mount, '-force'], { check: false, capture: true, quiet: true });
    }
    await rm(workDir, { recursive: true, force: true });
  }
}

async function duMb(file) {
  const result = await run('du', ['-sk', file], { capture: true, quiet: true });
  const kb = Number(result.stdout.trim().split(/\s+/)[0]);
  if (!Number.isFinite(kb) || kb <= 0) {
    fail(`Could not determine size for ${rel(file)}.`);
  }
  return kb / 1024;
}

async function ensureDmgNotarizedAndStapled({ dmgPath, notaryArgs }) {
  const validate = await run('xcrun', ['stapler', 'validate', dmgPath], {
    capture: true,
    quiet: true,
    check: false,
  });
  if (validate.code === 0) return;

  step('Notarizing and stapling DMG');
  await run('xcrun', ['notarytool', 'submit', dmgPath, ...notaryArgs, '--wait', '--output-format', 'json']);
  await run('xcrun', ['stapler', 'staple', dmgPath]);
  await run('xcrun', ['stapler', 'validate', dmgPath]);
}

async function regenerateDmgBlockmap(dmg, blockmap) {
  const appBuilder = await findAppBuilder();
  await run(appBuilder, ['blockmap', '--input', dmg, '--output', blockmap], { capture: true });
}

async function findAppBuilder() {
  const pnpmDir = path.join(root, 'node_modules', '.pnpm');
  const entries = await readdir(pnpmDir, { withFileTypes: true });
  const appBuilderDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('app-builder-bin@'))
    .map((entry) => path.join(pnpmDir, entry.name, 'node_modules', 'app-builder-bin', 'mac'));
  const executable = process.arch === 'arm64' ? 'app-builder_arm64' : 'app-builder_amd64';
  for (const dir of appBuilderDirs) {
    const candidate = path.join(dir, executable);
    if (existsSync(candidate)) return candidate;
  }
  fail(`Could not find ${executable} from app-builder-bin.`);
}

async function writeLatestMacYml(input) {
  const zip = await fileInfo(input.zipPath, 'sha512-base64');
  const dmg = await fileInfo(input.dmgPath, 'sha512-base64');
  const yml = `version: ${input.version}
files:
  - url: ${path.basename(input.zipPath)}
    sha512: ${zip.digest}
    size: ${zip.size}
  - url: ${path.basename(input.dmgPath)}
    sha512: ${dmg.digest}
    size: ${dmg.size}
path: ${path.basename(input.zipPath)}
sha512: ${zip.digest}
releaseDate: '${new Date().toISOString()}'
`;
  await writeFile(input.latestMacPath, yml);
}

async function verifyReleaseArtifacts(input) {
  await verifyReleaseVersionMetadata(input);
  await run('node', [path.join(desktopDir, 'scripts', 'smoke-test-packaged.mjs'), input.appPath], { cwd: root });
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', input.appPath]);
  await run('xcrun', ['stapler', 'validate', input.appPath]);
  await run('xcrun', ['stapler', 'validate', input.dmgPath]);
  await run('spctl', ['-a', '-vvv', '-t', 'exec', input.appPath]);
  await run('spctl', ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', input.dmgPath]);
  await verifyDmgContents(input.dmgPath, input.productName, { fatal: true });
}

async function verifyReleaseVersionMetadata(input) {
  const plistPath = path.join(input.appPath, 'Contents', 'Info.plist');
  const embeddedVersion = await readPackagedAppVersion(input.appPath, input.productName);
  const latestVersion = await readLatestMacVersion(input.latestMacPath);
  const checks = [
    ['CFBundleShortVersionString', await readPlistValue(plistPath, 'CFBundleShortVersionString'), input.version],
    ['CFBundleVersion', await readPlistValue(plistPath, 'CFBundleVersion'), input.version],
    ['CFBundleIconFile', await readPlistValue(plistPath, 'CFBundleIconFile'), 'icon.icns'],
    ['app.asar package.json version', embeddedVersion, input.version],
    ['latest-mac.yml version', latestVersion, input.version],
  ];

  for (const [label, actual, expected] of checks) {
    if (actual !== expected) {
      fail(`Release metadata mismatch for ${label}: ${actual || '<missing>'} != ${expected}`);
    }
  }
}

async function readPlistValue(plistPath, key) {
  const result = await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], {
    capture: true,
    quiet: true,
  });
  return result.stdout.trim();
}

async function readPackagedAppVersion(appPath, productName) {
  const electronExe = path.join(appPath, 'Contents', 'MacOS', productName);
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  const probe = `
const fs = require('node:fs');
const path = require('node:path');
const pkg = JSON.parse(fs.readFileSync(path.join(process.argv[1], 'package.json'), 'utf8'));
process.stdout.write(pkg.version || '');
`;
  const result = await run(electronExe, ['-e', probe, asarPath], {
    capture: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    quiet: true,
  });
  return result.stdout.trim();
}

async function readLatestMacVersion(latestMacPath) {
  const yml = await readFile(latestMacPath, 'utf8');
  return yml.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? null;
}

async function updateWebsiteDownloadLinks(input) {
  step('Updating website download links');
  const releaseBase = `https://github.com/${input.repo}/releases`;
  const latestReleaseUrl = `${releaseBase}/tag/${input.tag}`;
  const downloadArmUrl = `${releaseBase}/download/${input.tag}/${input.productName}-${input.version}-mac-arm64.dmg`;

  let source = await readFile(websiteAppPath, 'utf8');
  const replacements = [
    [/^const LATEST_RELEASE_URL = ".*";$/m, `const LATEST_RELEASE_URL = "${latestReleaseUrl}";`],
  ];
  if (input.arch === 'arm64') {
    replacements.push([
      /^const DOWNLOAD_ARM_URL = ".*";$/m,
      `const DOWNLOAD_ARM_URL = "${downloadArmUrl}";`,
    ]);
  }

  let next = source;
  for (const [pattern, value] of replacements) {
    if (!pattern.test(next)) {
      fail(`Could not find website download link to update in ${rel(websiteAppPath)}`);
    }
    next = next.replace(pattern, value);
  }

  if (next === source) {
    console.log('[release] Website download links already up to date.');
    return;
  }

  await writeFile(websiteAppPath, next);
  await run('git', ['add', rel(websiteAppPath)], { cwd: root });
  await run('git', ['commit', '-m', `Update website download links for ${input.tag}`], { cwd: root });
  await run('git', ['push', 'origin', 'main'], { cwd: root });
  console.log(`[release] Pushed website download links for ${input.tag}.`);
}

async function prepareTag(tagName, forceTag) {
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root, capture: true, quiet: true })).stdout.trim();
  const local = await gitCommitForRef(tagName);
  if (local && local !== head && !forceTag) {
    fail(`Local tag ${tagName} points to ${local}, not HEAD ${head}. Use --force-tag to move it.`);
  }
  if (!local) {
    await run('git', ['tag', tagName, head], { cwd: root });
  } else if (local !== head) {
    await run('git', ['tag', '-f', tagName, head], { cwd: root });
  }

  const remote = await gitRemoteTagCommit(tagName);
  if (remote && remote !== head && !forceTag) {
    fail(`Remote tag ${tagName} points to ${remote}, not HEAD ${head}. Use --force-tag to move it.`);
  }
  const pushArgs = remote && remote !== head ? ['push', '--force', 'origin', `refs/tags/${tagName}`] : ['push', 'origin', `refs/tags/${tagName}`];
  await run('git', pushArgs, { cwd: root });
}

async function gitCommitForRef(ref) {
  const result = await run('git', ['rev-parse', `${ref}^{commit}`], {
    cwd: root,
    capture: true,
    quiet: true,
    check: false,
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

async function gitRemoteTagCommit(tagName) {
  const result = await run('git', ['ls-remote', '--tags', 'origin', tagName], {
    cwd: root,
    capture: true,
    quiet: true,
  });
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tagName}^{}`));
  const exact = lines.find((line) => line.endsWith(`refs/tags/${tagName}`));
  const selected = peeled ?? exact;
  return selected ? selected.split(/\s+/)[0] : null;
}

async function ensureGitHubRelease(input) {
  const view = await run('gh', ['release', 'view', input.tag, '--repo', input.repo, '--json', 'url'], {
    cwd: root,
    capture: true,
    quiet: true,
    check: false,
  });
  if (view.code === 0) return;

  await run('gh', [
    'release',
    'create',
    input.tag,
    '--repo',
    input.repo,
    '--title',
    input.version,
    '--notes',
    `${input.productName} ${input.version}`,
    '--verify-tag',
  ], { cwd: root });
}

async function verifyRemoteAssets(input) {
  const result = await run('gh', [
    'release',
    'view',
    input.tag,
    '--repo',
    input.repo,
    '--json',
    'assets,url',
  ], { cwd: root, capture: true, quiet: true });
  const release = JSON.parse(result.stdout);
  const assetsByName = new Map(release.assets.map((asset) => [asset.name, asset]));

  for (const file of input.files) {
    const asset = assetsByName.get(path.basename(file));
    if (!asset) {
      fail(`Uploaded asset missing from GitHub release: ${path.basename(file)}`);
    }
    const local = await fileInfo(file, 'sha256-hex');
    if (asset.size !== local.size) {
      fail(`Remote size mismatch for ${asset.name}: ${asset.size} != ${local.size}`);
    }
    if (asset.digest && asset.digest !== `sha256:${local.digest}`) {
      fail(`Remote digest mismatch for ${asset.name}: ${asset.digest} != sha256:${local.digest}`);
    }
  }

  return release.url;
}

async function fileInfo(file, digestKind) {
  const buffer = await readFile(file);
  const hashName = digestKind.startsWith('sha512') ? 'sha512' : 'sha256';
  const encoding = digestKind.endsWith('base64') ? 'base64' : 'hex';
  return {
    size: buffer.length,
    digest: createHash(hashName).update(buffer).digest(encoding),
  };
}

function printLocalSummary(files) {
  console.log('\n[release] Local artifacts:');
  for (const file of files) {
    console.log(`  ${rel(file)}`);
  }
}

async function run(command, args, options = {}) {
  const {
    capture = false,
    check = true,
    cwd = root,
    env = process.env,
    quiet = false,
  } = options;

  if (!quiet) {
    console.log(`[run] ${command} ${args.map(shellish).join(' ')}`);
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';

    if (capture) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!quiet) process.stdout.write(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (!quiet) process.stderr.write(chunk);
      });
    }

    child.on('error', reject);
    child.on('exit', (code) => {
      const result = { code, stdout, stderr };
      if (check && code !== 0) {
        const err = new Error(`${command} exited with code ${code}`);
        err.result = result;
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

function shellish(value) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function step(message) {
  console.log(`\n==> ${message}`);
}

function rel(file) {
  return path.relative(root, file);
}

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}
