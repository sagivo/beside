import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type {
  BackupObjectCandidate,
  BackupObjectRecord,
  BackupProvider,
  BackupRestoreResult,
  BackupRunResult,
  BackupStatus,
  IStorage,
  Logger,
  StorageStats,
} from '@beside/interfaces';
import { BESIDE_GOOGLE_DRIVE_CLIENT_ID, type BesideConfig } from '@beside/core';

const KEY_AAD = Buffer.from('beside-cloud-backup-v1');
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const OAUTH_TIMEOUT_MS = 10 * 60_000;

interface BackupRemoteStatus {
  configured: boolean;
  connected: boolean;
  label: string | null;
  lastError: string | null;
}

interface BackupRemote {
  readonly provider: BackupProvider;
  getStatus(): Promise<BackupRemoteStatus>;
  startConnect?(): Promise<{ url: string; expiresAt: string }>;
  disconnect?(): Promise<void>;
  upload(candidate: BackupObjectCandidate, encrypted: Buffer, encryptedHash: string): Promise<{ remoteKey: string }>;
  download(object: BackupObjectRecord): Promise<Buffer>;
}

type BackupConfig = BesideConfig['backup'];
type DriveConfig = BackupConfig['drive'];

interface StoredDriveTokens {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

interface DriveFile {
  id: string;
  name?: string;
  size?: string;
}

export class BackupService {
  private readonly logger: Logger;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private remote: BackupRemote | null = null;

  constructor(
    private readonly storage: IStorage,
    logger: Logger,
    private readonly config: BesideConfig,
    private readonly dataDir: string,
  ) {
    this.logger = logger.child('backup-service');
  }

  async getStatus(storageStats?: StorageStats): Promise<BackupStatus> {
    const cfg = this.config.backup;
    const localStats = storageStats ?? await this.storage.getStats().catch(() => null);
    const storeStats = await this.storage.getBackupStoreStats?.().catch((err) => {
      this.logger.debug('backup store stats unavailable', { err: String(err) });
      return null;
    });
    const remote = this.getRemote();
    const remoteStatus = await remote.getStatus().catch((err) => ({
      configured: false,
      connected: false,
      label: null,
      lastError: err instanceof Error ? err.message : String(err),
    }));
    const mode: BackupStatus['mode'] = !cfg.enabled
      ? 'disabled'
      : remoteStatus.lastError
        ? 'error'
        : !remoteStatus.configured
          ? 'needs_provider_config'
          : !remoteStatus.connected
            ? 'needs_connection'
            : 'ready';

    return {
      enabled: cfg.enabled,
      provider: cfg.provider,
      configured: remoteStatus.configured,
      connected: remoteStatus.connected,
      mode,
      remoteLabel: remoteStatus.label,
      localMaxBytes: gbToBytes(this.config.storage.local.max_size_gb),
      localBytes: localStats?.totalBytes ?? 0,
      remoteBytes: storeStats?.remoteBytes ?? 0,
      pendingObjects: storeStats?.pendingObjects ?? 0,
      uploadedObjects: storeStats?.uploadedObjects ?? 0,
      evictedObjects: storeStats?.evictedObjects ?? 0,
      failedObjects: storeStats?.failedObjects ?? 0,
      lastRunAt: this.lastRunAt,
      lastUploadedAt: storeStats?.lastUploadedAt ?? null,
      lastError: this.lastError ?? remoteStatus.lastError ?? storeStats?.lastError ?? null,
    };
  }

  async startProviderConnect(provider?: BackupProvider): Promise<{ url: string; expiresAt: string }> {
    const remote = this.getRemote(provider);
    if (!remote.startConnect) throw new Error(`${provider ?? this.config.backup.provider} does not support in-app connection yet.`);
    return await remote.startConnect();
  }

  async disconnectProvider(provider?: BackupProvider): Promise<void> {
    const remote = this.getRemote(provider);
    if (!remote.disconnect) return;
    await remote.disconnect();
    this.lastError = null;
  }

  async tick(): Promise<BackupRunResult> {
    const cfg = this.config.backup;
    if (!cfg.enabled) return { uploaded: 0, failed: 0, evicted: 0, freedBytes: 0, skippedReason: 'disabled' };
    if (!this.storage.listBackupCandidates || !this.storage.markBackupUploading || !this.storage.markBackupUploaded || !this.storage.markBackupFailed) {
      return { uploaded: 0, failed: 0, evicted: 0, freedBytes: 0, skippedReason: 'storage plugin does not support backup' };
    }

    const remote = this.getRemote();
    const remoteStatus = await remote.getStatus();
    if (!remoteStatus.configured) return { uploaded: 0, failed: 0, evicted: 0, freedBytes: 0, skippedReason: 'provider not configured' };
    if (!remoteStatus.connected) return { uploaded: 0, failed: 0, evicted: 0, freedBytes: 0, skippedReason: 'provider not connected' };

    this.lastRunAt = new Date().toISOString();
    this.lastError = null;
    const key = await this.getOrCreateEncryptionKey();
    const candidates = cfg.upload_all
      ? await this.storage.listBackupCandidates(Math.max(1, cfg.batch_size))
      : [];

    let uploaded = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        await this.uploadOne(remote, key, candidate);
        uploaded += 1;
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        this.lastError = message;
        await this.storage.markBackupFailed(candidate.id, message).catch(() => {});
        this.logger.warn('backup upload failed', { id: candidate.id, provider: remote.provider, err: message });
      }
    }

    const evicted = await this.enforceLocalLimit(cfg).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.logger.warn('backup eviction failed', { err: message });
      return { evicted: 0, freedBytes: 0 };
    });

    return { uploaded, failed, evicted: evicted.evicted, freedBytes: evicted.freedBytes };
  }

  async restoreEvicted(limit = 50): Promise<BackupRestoreResult> {
    if (!this.storage.listEvictedBackupObjects || !this.storage.restoreBackedUpAsset) {
      throw new Error('Storage plugin does not support backup restore.');
    }
    const remote = this.getRemote();
    const remoteStatus = await remote.getStatus();
    if (!remoteStatus.configured) throw new Error('Backup provider is not configured.');
    if (!remoteStatus.connected) throw new Error('Backup provider is not connected.');

    const key = await this.getOrCreateEncryptionKey();
    const objects = await this.storage.listEvictedBackupObjects(limit);
    let restored = 0;
    let failed = 0;
    let bytes = 0;
    for (const object of objects) {
      try {
        const encrypted = await remote.download(object);
        const data = decryptEnvelope(encrypted, key);
        const result = await this.storage.restoreBackedUpAsset(object.id, data);
        restored += 1;
        bytes += result.bytes;
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        this.lastError = message;
        await this.storage.markBackupFailed?.(object.id, message).catch(() => {});
        this.logger.warn('backup restore failed', { id: object.id, provider: remote.provider, err: message });
      }
    }
    return { restored, failed, bytes };
  }

  private async uploadOne(remote: BackupRemote, key: Buffer, candidate: BackupObjectCandidate): Promise<void> {
    await this.storage.markBackupUploading!(candidate);
    const plaintext = await this.storage.readAsset(candidate.localPath);
    const plaintextHash = crypto.createHash('sha256').update(plaintext).digest('hex');
    if (plaintextHash !== candidate.contentHash) throw new Error('backup candidate changed before upload');
    const encrypted = encryptEnvelope(plaintext, key);
    const encryptedHash = crypto.createHash('sha256').update(encrypted).digest('hex');
    const uploaded = await remote.upload(candidate, encrypted, encryptedHash);
    const uploadedAt = new Date().toISOString();
    await this.storage.markBackupUploaded!({
      id: candidate.id,
      encryptedHash,
      encryptedBytes: encrypted.byteLength,
      remoteKey: uploaded.remoteKey,
      uploadedAt,
    });
  }

  private async enforceLocalLimit(cfg: BackupConfig): Promise<{ evicted: number; freedBytes: number }> {
    if (!this.storage.evictBackedUpAssets) return { evicted: 0, freedBytes: 0 };
    return await this.storage.evictBackedUpAssets(
      gbToBytes(this.config.storage.local.max_size_gb),
      Math.max(1, cfg.evict_batch_size),
    );
  }

  private getRemote(provider: BackupProvider = this.config.backup.provider): BackupRemote {
    if (this.remote && this.remote.provider === provider) return this.remote;
    if (provider === 'drive') {
      this.remote = new GoogleDriveBackupRemote(this.config.backup.drive, this.dataDir, this.logger);
      return this.remote;
    }
    this.remote = new UnsupportedBackupRemote(provider);
    return this.remote;
  }

  private async getOrCreateEncryptionKey(): Promise<Buffer> {
    const keyPath = path.join(this.dataDir, 'backups', 'cloud-backup-key.json');
    try {
      const parsed = JSON.parse(await fs.readFile(keyPath, 'utf8')) as { key?: string };
      if (typeof parsed.key === 'string') {
        const key = Buffer.from(parsed.key, 'base64');
        if (key.byteLength === 32) return key;
      }
    } catch {
      // create below
    }
    const key = crypto.randomBytes(32);
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, JSON.stringify({ version: 1, key: key.toString('base64') }, null, 2), { mode: 0o600 });
    return key;
  }
}

class UnsupportedBackupRemote implements BackupRemote {
  constructor(readonly provider: BackupProvider) {}

  async getStatus(): Promise<BackupRemoteStatus> {
    return {
      configured: false,
      connected: false,
      label: `${this.provider === 'box' ? 'Box' : this.provider} (coming later)`,
      lastError: null,
    };
  }

  async upload(): Promise<{ remoteKey: string }> {
    throw new Error(`Backup provider "${this.provider}" is not supported yet.`);
  }

  async download(): Promise<Buffer> {
    throw new Error(`Backup provider "${this.provider}" is not supported yet.`);
  }
}

class GoogleDriveBackupRemote implements BackupRemote {
  readonly provider = 'drive' as const;
  private pendingServer: http.Server | null = null;

  constructor(
    private readonly cfg: DriveConfig,
    private readonly dataDir: string,
    private readonly logger: Logger,
  ) {}

  async getStatus(): Promise<BackupRemoteStatus> {
    const configured = Boolean(this.clientId());
    if (!configured) return { configured, connected: false, label: 'Google Drive', lastError: null };
    const tokens = await this.readTokens();
    return {
      configured,
      connected: Boolean(tokens?.refresh_token),
      label: 'Google Drive app data',
      lastError: null,
    };
  }

  async startConnect(): Promise<{ url: string; expiresAt: string }> {
    const clientId = this.clientId();
    if (!clientId) throw new Error('Google Drive client ID is not configured.');
    await this.closePendingServer();

    const codeVerifier = base64Url(crypto.randomBytes(32));
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    const state = base64Url(crypto.randomBytes(24));
    const server = http.createServer();
    this.pendingServer = server;

    const { port } = await new Promise<{ port: number }>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') reject(new Error('Could not start OAuth listener.'));
        else resolve({ port: address.port });
      });
    });

    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
    const expiresAt = new Date(Date.now() + OAUTH_TIMEOUT_MS).toISOString();
    const timeout = setTimeout(() => void this.closePendingServer(), OAUTH_TIMEOUT_MS);
    timeout.unref?.();

    server.on('request', (req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '/', redirectUri);
          if (url.pathname !== '/oauth2callback') {
            res.writeHead(404).end('Not found');
            return;
          }
          if (url.searchParams.get('state') !== state) throw new Error('OAuth state mismatch.');
          const code = url.searchParams.get('code');
          if (!code) throw new Error(url.searchParams.get('error') ?? 'Missing OAuth code.');
          const tokens = await this.exchangeCode({ code, codeVerifier, redirectUri });
          await this.writeTokens(tokens);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(successPage());
          clearTimeout(timeout);
          void this.closePendingServer();
        } catch (err) {
          this.logger.warn('Google Drive connection failed', { err: String(err) });
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Google Drive connection failed: ${String(err)}`);
          clearTimeout(timeout);
          void this.closePendingServer();
        }
      })();
    });

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', DRIVE_SCOPE);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    return { url: authUrl.toString(), expiresAt };
  }

  async disconnect(): Promise<void> {
    const tokens = await this.readTokens();
    if (tokens?.refresh_token) {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refresh_token }),
      }).catch(() => null);
    }
    await fs.unlink(this.tokenPath()).catch(() => {});
  }

  async upload(candidate: BackupObjectCandidate, encrypted: Buffer, encryptedHash: string): Promise<{ remoteKey: string }> {
    const token = await this.getAccessToken();
    const name = `${candidate.id}.besidebackup`;
    const existing = await this.findFileByName(token, name);
    const initUrl = existing
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=id,name,size`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size';
    const metadata = existing
      ? { name, mimeType: 'application/octet-stream' }
      : { name, parents: ['appDataFolder'], mimeType: 'application/octet-stream', appProperties: { backupObjectId: candidate.id, encryptedHash } };
    const init = await fetch(initUrl, {
      method: existing ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': String(encrypted.byteLength),
      },
      body: JSON.stringify(metadata),
    });
    if (!init.ok) throw new Error(await googleError(init, 'Could not start Drive upload'));
    const location = init.headers.get('location');
    if (!location) throw new Error('Drive upload did not return a resumable location.');
    const upload = await fetch(location, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(encrypted.byteLength),
      },
      body: encrypted,
    });
    if (!upload.ok) throw new Error(await googleError(upload, 'Drive upload failed'));
    const file = await upload.json() as DriveFile;
    if (!file.id) throw new Error('Drive upload response did not include a file id.');
    return { remoteKey: file.id };
  }

  async download(object: BackupObjectRecord): Promise<Buffer> {
    if (!object.remoteKey) throw new Error(`Backup object ${object.id} has no Drive file id.`);
    const token = await this.getAccessToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(object.remoteKey)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(await googleError(res, 'Drive download failed'));
    return Buffer.from(await res.arrayBuffer());
  }

  private async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<StoredDriveTokens> {
    const body = new URLSearchParams({
      client_id: this.clientId(),
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    });
    const secret = this.clientSecret();
    if (secret) body.set('client_secret', secret);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(await googleError(res, 'Google OAuth token exchange failed'));
    const json = await res.json() as StoredDriveTokens & { expires_in?: number };
    return {
      ...json,
      expiry_date: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : json.expiry_date,
    };
  }

  private async getAccessToken(): Promise<string> {
    const tokens = await this.readTokens();
    if (!tokens?.refresh_token) throw new Error('Google Drive is not connected.');
    if (tokens.access_token && tokens.expiry_date && tokens.expiry_date > Date.now() + 60_000) {
      return tokens.access_token;
    }
    const body = new URLSearchParams({
      client_id: this.clientId(),
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    });
    const secret = this.clientSecret();
    if (secret) body.set('client_secret', secret);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(await googleError(res, 'Google OAuth token refresh failed'));
    const json = await res.json() as StoredDriveTokens & { expires_in?: number };
    const next = {
      ...tokens,
      ...json,
      refresh_token: json.refresh_token ?? tokens.refresh_token,
      expiry_date: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : json.expiry_date,
    };
    await this.writeTokens(next);
    return next.access_token!;
  }

  private async findFileByName(accessToken: string, name: string): Promise<DriveFile | null> {
    const q = `name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`;
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('spaces', 'appDataFolder');
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'files(id,name,size)');
    url.searchParams.set('pageSize', '1');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(await googleError(res, 'Drive file lookup failed'));
    const json = await res.json() as { files?: DriveFile[] };
    return json.files?.[0] ?? null;
  }

  private clientId(): string {
    return process.env.BESIDE_GOOGLE_DRIVE_CLIENT_ID || this.cfg.client_id?.trim() || BESIDE_GOOGLE_DRIVE_CLIENT_ID;
  }

  private clientSecret(): string {
    return process.env.BESIDE_GOOGLE_DRIVE_CLIENT_SECRET || this.cfg.client_secret?.trim() || '';
  }

  private tokenPath(): string {
    return path.join(this.dataDir, 'backups', 'google-drive-token.json');
  }

  private async readTokens(): Promise<StoredDriveTokens | null> {
    try {
      return JSON.parse(await fs.readFile(this.tokenPath(), 'utf8')) as StoredDriveTokens;
    } catch {
      return null;
    }
  }

  private async writeTokens(tokens: StoredDriveTokens): Promise<void> {
    await fs.mkdir(path.dirname(this.tokenPath()), { recursive: true });
    await fs.writeFile(this.tokenPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }

  private async closePendingServer(): Promise<void> {
    const server = this.pendingServer;
    this.pendingServer = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function encryptEnvelope(data: Buffer, key: Buffer): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(KEY_AAD);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  const header = Buffer.from(JSON.stringify({
    version: 1,
    algorithm: 'aes-256-gcm',
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
  }) + '\n', 'utf8');
  return Buffer.concat([header, ciphertext]);
}

function decryptEnvelope(envelope: Buffer, key: Buffer): Buffer {
  const newline = envelope.indexOf(0x0a);
  if (newline <= 0) throw new Error('Invalid backup envelope.');
  const header = JSON.parse(envelope.subarray(0, newline).toString('utf8')) as {
    version?: number;
    algorithm?: string;
    nonce?: string;
    tag?: string;
  };
  if (header.version !== 1 || header.algorithm !== 'aes-256-gcm' || !header.nonce || !header.tag) {
    throw new Error('Unsupported backup envelope.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.nonce, 'base64'));
  decipher.setAAD(KEY_AAD);
  decipher.setAuthTag(Buffer.from(header.tag, 'base64'));
  return Buffer.concat([decipher.update(envelope.subarray(newline + 1)), decipher.final()]);
}

function gbToBytes(gb: number): number {
  return Math.max(1, Math.floor(gb * 1024 * 1024 * 1024));
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function googleError(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => '');
  return `${fallback}: ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`;
}

function successPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Google Drive connected</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:32px;line-height:1.5"><h1>Google Drive connected</h1><p>You can close this tab and return to Beside.</p></body></html>`;
}
