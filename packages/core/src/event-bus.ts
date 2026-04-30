import type { RawEvent, Logger } from '@cofounderos/interfaces';

export type RawEventListener = (event: RawEvent) => void | Promise<void>;

/**
 * In-process event bus for raw events flowing from capture to storage and
 * (asynchronously) to live consumers like the index nudger or future
 * realtime exporters.
 *
 * Errors in listeners never affect other listeners — by design, the
 * capture pipeline must keep flowing even if a downstream consumer throws.
 */
export class RawEventBus {
  private readonly listeners = new Set<RawEventListener>();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child('bus');
  }

  on(listener: RawEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(event: RawEvent): Promise<void> {
    for (const l of this.listeners) {
      try {
        await l(event);
      } catch (err) {
        this.logger.error('listener failed', { err: String(err), eventId: event.id });
      }
    }
  }

  size(): number {
    return this.listeners.size;
  }
}
