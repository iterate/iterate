// The integration registry: every provider the platform knows how to ingest,
// route, and expose on itx.integrations.* — including Slack and Google,
// migrated off their bespoke wiring (the D1 secrets/connections layer is
// gone; this registry is THE system).

import type { IntegrationDefinition } from "~/domains/integrations/definition.ts";
import { githubIntegration } from "~/domains/integrations/providers/github.ts";
import { discordIntegration } from "~/domains/integrations/providers/discord.ts";
import { slackIntegration } from "~/domains/integrations/providers/slack.ts";
import { googleIntegration } from "~/domains/integrations/providers/google.ts";

export const INTEGRATIONS: Record<string, IntegrationDefinition> = {
  [githubIntegration.slug]: githubIntegration,
  [discordIntegration.slug]: discordIntegration,
  [slackIntegration.slug]: slackIntegration,
  [googleIntegration.slug]: googleIntegration,
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
