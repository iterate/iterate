import type { z } from "zod/v4";

export interface ServiceDefinition<TConfig extends z.ZodType = z.ZodType> {
  slug: string;
  version: string;
  configSchema: TConfig;
  sqliteDbPath?: string;
  start(config: z.infer<TConfig>): Promise<ServiceStartResult>;
}

export interface ServiceStartResult {
  /** The address Caddy should route traffic to (e.g. "127.0.0.1:54321") */
  target: string;
}

export function defineService<TConfig extends z.ZodType>(
  def: ServiceDefinition<TConfig>,
): ServiceDefinition<TConfig> {
  return def;
}
