// src/integrations/waitrose-connection.ts — WAITROSE as a connection (connections.ts), for a project
// or a person: no consent and no app, a username and a password. The Dash (or any caller) sets
// `/secrets/waitrose-<connection>` to `{ username, password }` with the `waitrose-session` strategy
// (waitrose.ts logs in on first use and on a 401), then `connectWaitrose` records the connection:
// a platform `waitrose/connected` on the owner's root naming the username. A project connects a
// person's as it is, like any account of theirs (`itx.integrations.connect("waitrose", { account })`).
//   connectWaitrose → the secret checked, then `waitrose/connected`
// Waitrose sends no webhooks, so nothing is routed, and a disconnect revokes nothing.
import { codedError } from "iterate/lib";
import { z } from "zod";
import {
  appendConnected,
  assertConnectionName,
  tokenSecretPathOf,
  type IntegrationScope,
} from "./connections.ts";

export async function connectWaitrose(
  scope: IntegrationScope,
  input: { connection: string; account: string },
): Promise<void> {
  const connection = assertConnectionName(input?.connection);
  const account = z.string().min(1, "account is the Waitrose username").parse(input.account);
  const secretPath = tokenSecretPathOf("waitrose", connection);
  const secrets = await scope.withItx((itx) => itx.secrets.list());
  if (
    !secrets.some((secret) => secret.path === secretPath && secret.refresh === "waitrose-session")
  )
    throw codedError(
      "INVALID_INPUT",
      `Set ${secretPath} to { username, password } with refresh { kind: "waitrose-session" } first.`,
    );
  await appendConnected(scope, {
    provider: "waitrose",
    connection,
    client: "project",
    account,
    externalId: account,
  });
}
