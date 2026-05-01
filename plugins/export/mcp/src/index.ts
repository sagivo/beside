import type {
  IExport,
  ExportStatus,
  ExportServices,
  IndexPage,
  IndexState,
  IIndexStrategy,
  ReorganisationSummary,
  PluginFactory,
  Logger,
} from '@cofounderos/interfaces';
import {
  createMcpServer,
  startHttpServer,
  startStdioServer,
  type McpServices,
  type RunningHttpServer,
} from './server.js';

interface McpExportConfig {
  host?: string;
  port?: number;
  transport?: 'http' | 'stdio';
}

/**
 * MCP server exposed as a CofounderOS export plugin. The plugin is
 * lifecycle-only: page updates do NOT push anything (MCP clients pull
 * on demand). What we expose here is a stable HTTP endpoint plus the
 * `bindServices` setter used by the app orchestrator to connect storage
 * + index strategy.
 */
class McpExport implements IExport {
  readonly name = 'mcp';

  private readonly logger: Logger;
  private readonly host: string;
  private readonly port: number;
  private readonly transport: 'http' | 'stdio';

  private services: McpServices | null = null;
  private httpServer: RunningHttpServer | null = null;
  private stdioHandle: { close(): Promise<void> } | null = null;

  private running = false;
  private lastSync: string | null = null;

  constructor(config: McpExportConfig, logger: Logger) {
    this.logger = logger.child('export-mcp');
    // Use 127.0.0.1 rather than 'localhost'. On modern Windows and some
    // Linux distros 'localhost' resolves to ::1 first while many MCP
    // clients dial 127.0.0.1, producing spurious "connection refused".
    // Pinning to v4 keeps the loopback story identical across platforms.
    this.host = config.host ?? '127.0.0.1';
    this.port = config.port ?? 3456;
    this.transport = config.transport ?? 'http';
  }

  /**
   * Called by the orchestrator after instantiation, before start(), to
   * inject the storage + strategy + reindex hook. Calling start() before
   * bindServices() throws. Accepts the full host services bag and picks
   * only what MCP needs.
   */
  bindServices(services: ExportServices | McpServices): void {
    this.services = {
      storage: services.storage,
      strategy: services.strategy,
      model: (services as ExportServices).model,
      embeddingModelName: (services as ExportServices).embeddingModelName,
      triggerReindex: (services as ExportServices).triggerReindex,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.services) {
      throw new Error(
        'export-mcp: services not bound. Call bindServices() before start().',
      );
    }
    if (this.transport === 'stdio') {
      // stdio is single-session by definition, so one server is enough.
      const server = createMcpServer(this.services, this.logger);
      this.stdioHandle = await startStdioServer(server, this.logger);
    } else {
      // HTTP is multi-session; the SDK requires a fresh McpServer per
      // transport, so we hand startHttpServer a factory rather than a
      // single instance.
      const services = this.services;
      this.httpServer = await startHttpServer(
        () => createMcpServer(services, this.logger),
        this.host,
        this.port,
        this.logger,
      );
    }
    this.running = true;
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await this.httpServer.close();
      this.httpServer = null;
    }
    if (this.stdioHandle) {
      await this.stdioHandle.close();
      this.stdioHandle = null;
    }
    this.running = false;
  }

  async onPageUpdate(_page: IndexPage): Promise<void> {
    this.lastSync = new Date().toISOString();
  }

  async onPageDelete(_pagePath: string): Promise<void> {
    this.lastSync = new Date().toISOString();
  }

  async onReorganisation(_summary: ReorganisationSummary): Promise<void> {
    this.lastSync = new Date().toISOString();
  }

  async fullSync(_state: IndexState, _strategy: IIndexStrategy): Promise<void> {
    // No-op — MCP serves the live index on every read.
    this.lastSync = new Date().toISOString();
  }

  getStatus(): ExportStatus {
    return {
      name: this.name,
      running: this.running,
      lastSync: this.lastSync,
      pendingUpdates: 0,
      errorCount: 0,
    };
  }
}

const factory: PluginFactory<IExport> = (ctx) => {
  return new McpExport((ctx.config as McpExportConfig) ?? {}, ctx.logger);
};

export default factory;
export { McpExport };
export type { McpServices } from './server.js';
