// src/integrations/contract.ts — A CONNECTION'S RECORD, spelled once for its two owners: a project's
// connections fold into the `project` state on `/` (project/contract.ts), a person's own into the
// `account` state on `/users/<id>` (account/contract.ts). Both depend on this catalog, so the row and
// the facts are one type. Only the platform appends these (`source.platform`): a connect's callback,
// a disconnect, and a sign-in that keeps its token (identity.ts).
import { z } from "zod";

export const IntegrationProvider = z.enum(["slack", "google", "cloudflare", "github", "waitrose"]);
export type IntegrationProvider = z.infer<typeof IntegrationProvider>;

/** One connection, as its owner's root records it, by the connection's log path
 *  (`/integrations/<provider>/<connection>`). */
export const IntegrationConnectionRow = z.object({
  provider: IntegrationProvider,
  /** The connection's name: its secret is `/secrets/<provider>-<connection>`, its inbound events'
   *  log `/integrations/<provider>/<connection>`. A person's connection is named by the account's
   *  stable id at the provider, never its email. */
  connection: z.string().min(1),
  /** Whose app: iterate's (the deployment's) or the project's own. */
  client: z.enum(["iterate", "project"]),
  /** What the provider calls the account: a Slack workspace's name, a Google or Cloudflare address,
   *  a GitHub login, a Waitrose username. */
  account: z.string(),
  /** Its id there: the Slack team, the Google or Cloudflare user, the GitHub installation (a
   *  project's) or user (a person's). */
  externalId: z.string().min(1),
  /** The scopes the provider says it granted, where it says (Google, Cloudflare). */
  scopes: z.array(z.string()).optional(),
});
export type IntegrationConnectionRow = z.infer<typeof IntegrationConnectionRow>;

const connected = (description: string) => ({
  description,
  payloadSchema: IntegrationConnectionRow.omit({ provider: true }),
});
const disconnected = {
  description:
    "The connection was disconnected: its token revoked where the provider allows, its route and secret gone.",
  payloadSchema: z.object({ connection: z.string().min(1) }),
};

/** The facts, a catalog the owners' contracts depend on (`processorDeps`). */
export const IntegrationEventCatalog = {
  events: {
    "events.iterate.com/slack/connected": connected(
      "A Slack workspace was connected: its bot token is in the connection's secret.",
    ),
    "events.iterate.com/slack/disconnected": disconnected,
    "events.iterate.com/google/connected": connected(
      "A Google account was connected: its tokens are in the connection's secret.",
    ),
    "events.iterate.com/google/disconnected": disconnected,
    "events.iterate.com/cloudflare/connected": connected(
      "A Cloudflare account was connected: its tokens are in the connection's secret.",
    ),
    "events.iterate.com/cloudflare/disconnected": disconnected,
    "events.iterate.com/github/connected": connected(
      "A GitHub App installation (a project's) or a GitHub user (a person's, from signing in) was connected: the connection's secret holds or mints its token.",
    ),
    "events.iterate.com/github/disconnected": disconnected,
    "events.iterate.com/waitrose/connected": connected(
      "A Waitrose account was connected: its username and password are in the connection's secret, which logs in on first use and on a 401.",
    ),
    "events.iterate.com/waitrose/disconnected": disconnected,
  },
};

/** The fold both owners run: a platform `<provider>/connected` is the row at its log path, a
 *  `disconnected` drops it; anything else, or a fact not the platform's, changes nothing. */
export function reduceIntegrations(
  integrations: Record<string, IntegrationConnectionRow>,
  event: { type: string; payload: unknown; source?: { platform?: boolean } },
): Record<string, IntegrationConnectionRow> | undefined {
  if (event.source?.platform !== true) return undefined;
  const [provider, fact] = event.type.slice("events.iterate.com/".length).split("/");
  const parsedProvider = IntegrationProvider.safeParse(provider);
  if (!parsedProvider.success || (fact !== "connected" && fact !== "disconnected"))
    return undefined;
  const { connection } = z.object({ connection: z.string() }).parse(event.payload);
  const path = `/integrations/${parsedProvider.data}/${connection}`;
  const { [path]: _dropped, ...rest } = integrations;
  if (fact === "disconnected") return Object.hasOwn(integrations, path) ? rest : undefined;
  const payload = z.object({}).passthrough().parse(event.payload);
  return {
    ...rest,
    [path]: IntegrationConnectionRow.parse({ ...payload, provider: parsedProvider.data }),
  };
}
