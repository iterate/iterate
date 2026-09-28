import type { AuthenticatedApp } from "iterate/app";

/** A new integration connection's name: short and random. It names the connection's secret
 *  (`/secrets/<provider>-<name>`) and a project app's webhook URL for life. */
export function freshConnectionName() {
  return crypto.randomUUID().slice(0, 8);
}

/** Where Waitrose logs in (apps/os/src/integrations/waitrose.ts): the secret's pin and its login. */
const WAITROSE_GRAPHQL_URL = "https://www.waitrose.com/api/graphql";

export type WaitroseCredentials = { username: string; password: string };

/** CONNECT A WAITROSE ACCOUNT on `owner` — a project's context, or the person's (`api.user`) —
 *  whose `facet` records its connections. The username and password go to the new connection's
 *  secret alone, `/secrets/waitrose-<connection>` with the `waitrose-session` strategy, which the
 *  platform logs in with on first use and whenever Waitrose answers 401; then the facet records the
 *  connection (apps/os/src/integrations/waitrose-connection.ts `connectWaitrose`). A connect the
 *  facet refuses deletes the secret it set. */
export async function connectWaitrose(
  owner: AuthenticatedApp["api"]["user"],
  facet: "project" | "account",
  { username, password }: WaitroseCredentials,
) {
  const connection = freshConnectionName();
  const secretPath = `/secrets/waitrose-${connection}`;
  await owner.secrets.set(
    secretPath,
    { username, password },
    {
      urls: [new URL(WAITROSE_GRAPHQL_URL).origin],
      refresh: { kind: "waitrose-session", graphqlUrl: WAITROSE_GRAPHQL_URL },
    },
  );
  await owner.facets
    .get(facet)
    .invoke([["connectWaitrose", { connection, account: username }]])
    .catch(async (caught: unknown) => {
      await owner.secrets.delete(secretPath).catch(() => {});
      throw caught;
    });
}
