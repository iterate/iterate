// The integration registry: every provider the platform knows how to ingest,
// route, and expose on itx.integrations.*. Slack and Google predate this
// registry and still run on their bespoke wiring; the migration path is to
// re-express them as definitions here.

import type { IntegrationDefinition } from "~/domains/integrations/definition.ts";
import { githubIntegration } from "~/domains/integrations/providers/github.ts";
import { discordIntegration } from "~/domains/integrations/providers/discord.ts";

export const INTEGRATIONS: Record<string, IntegrationDefinition> = {
  [githubIntegration.slug]: githubIntegration,
  [discordIntegration.slug]: discordIntegration,
};

export function getIntegration(slug: string): IntegrationDefinition {
  const definition = INTEGRATIONS[slug];
  if (!definition) {
    throw new Error(
      `Unknown integration "${slug}". Known: ${Object.keys(INTEGRATIONS).join(", ")}.`,
    );
  }
  return definition;
}
