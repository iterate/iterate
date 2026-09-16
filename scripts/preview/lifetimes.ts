import { previewLifetimesForEnvironment } from "../lib/preview-lifetimes.ts";

/** Run with trpc-cli. Beginning a group requires the preview lifecycle lock. */
export default class Lifetimes {
  async begin(options: { env: string; group: string; expiresAt: number }) {
    const lifetime = { group: options.group, expiresAt: options.expiresAt };
    await (await previewLifetimesForEnvironment(options.env)).begin(lifetime);
    return lifetime;
  }

  async retire(options: { env: string; group: string }) {
    await (await previewLifetimesForEnvironment(options.env)).retire(options.group);
    return { retired: options.group, env: options.env };
  }
}
