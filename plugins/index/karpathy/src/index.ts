import type { IIndexStrategy, PluginFactory } from '@beside/interfaces';
import { expandPath } from '@beside/core';
import { KarpathyStrategy } from './strategy.js';

interface FactoryConfig {
  index_path?: string;
  batch_size?: number;
  archive_after_days?: number;
  summary_threshold_pages?: number;
  day_page_narrative_text_enabled?: boolean;
  day_page_narrative_timeout_ms?: number;
}

const factory: PluginFactory<IIndexStrategy> = async (ctx) => {
  const cfg = (ctx.config as FactoryConfig) ?? {};
  const root = expandPath(cfg.index_path ?? `${ctx.dataDir}/index`);
  const strat = new KarpathyStrategy(cfg, ctx.logger, { dataDir: ctx.dataDir });
  await strat.init(root);
  return strat;
};

export default factory;
export { KarpathyStrategy };
