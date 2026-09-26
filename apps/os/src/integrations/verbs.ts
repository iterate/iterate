// src/integrations/verbs.ts — connect, finish and disconnect, for either owner: the project facet on a
// project's `/` (project/durable-object.ts) and the account facet on a person's `/users/<id>`
// (account/durable-object.ts) each run these over their own scope and their own `state.integrations`.
// A person connects Google or Cloudflare here (GitHub comes from signing in with it); a project any
// of the four. Waitrose has no consent: either owner connects it with a username and password
// (`connectWaitrose`). A PERSON'S ACCOUNT used by a project (a row with `ownerUserId`) is connected
// by `itx.integrations.connect(provider, { account })` on the project (context/built-ins.ts), or here
// when the consent it needed finishes (the attempt's `connectToProject`); disconnecting it from the
// project leaves the person's own connection standing. `finishIntegrationConnect` and a connect with
// `connectToProject` are the platform's alone: the facets do not publish them. An account another
// project holds (Slack, GitHub) is offered to move here, and `confirmIntegrationMove` moves it.
import { codedError, errorCode, reportIssue } from "iterate/lib";
import { z } from "zod";
import { appConfigOf, sessionSigningSecretOf } from "../app-config.ts";
import { verifyClaims } from "../caller.ts";
import { DurableObjectNameCodec } from "../context/paths.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import type { IntegrationConnectionRow, IntegrationProvider } from "./contract.ts";
import {
  appendPlatformFact,
  assertConnectionName,
  attemptKeyOf,
  connectionPathOf,
  connectionRowOf,
  consentAttemptKeyOf,
  ROUTED_PROVIDERS,
  tokenSecretPathOf,
  type ConnectionAttempt,
  type HeldToken,
  type IntegrationScope,
  type MovableAttempt,
  type MoveOffered,
} from "./connections.ts";
import { connectCloudflare, disconnectCloudflare, finishCloudflareConnect } from "./cloudflare.ts";
import { connectGithub, connectGithubInstallation, disconnectGithub } from "./github.ts";
import { connectGoogle, disconnectGoogle, finishGoogleConnect } from "./google.ts";
import {
  connectMovedSlackTeam,
  connectSlack,
  disconnectSlack,
  dropHeldSlackToken,
  finishSlackConnect,
} from "./slack.ts";
import { disconnectWaitrose } from "./waitrose-connection.ts";
import { missingScopes } from "./rules.ts";

export type ConnectInput = {
  provider: IntegrationProvider;
  connection: string;
  client: "iterate" | "project";
  next?: string;
  /** More permissions than the client's default (Google, Cloudflare, Slack). */
  scopes?: string[];
  /** A GitHub App of the project's own: its public half. */
  appSlug?: string;
  clientId?: string;
  /** GitHub: an installation the App already has, connected without GitHub's configure page (the
   *  human authorizes the App at once, coming back to `platformOrigin`'s callback). */
  installationId?: string;
  platformOrigin?: string;
};

/** The providers a person connects on their own context. */
const PERSONAL_PROVIDERS: readonly IntegrationProvider[] = ["google", "cloudflare"];

/** CONNECT: where to send a human to consent. Again for a connection that exists asks for more on
 *  the same account: the union of scopes, and the provider must answer for the account the
 *  connection holds (a GitHub App's permissions are the App's: its install page adds repositories). */
export async function connectIntegration(
  scope: IntegrationScope,
  integrations: Record<string, IntegrationConnectionRow>,
  input: ConnectInput,
  /** The platform's alone (a person's connect a project asked for, on their own context): never
   *  read off `input`, which a facet's caller writes. */
  connectToProject?: ConnectionAttempt["connectToProject"],
): Promise<{ authorizationUrl: string }> {
  const { connectToProject: _neverTheCallers, ...fields } = input as ConnectInput & {
    connectToProject?: unknown;
  };
  const request = { ...fields, connection: assertConnectionName(input?.connection) };
  if (connectToProject && scope.rootPath === "/")
    throw codedError(
      "INVALID_INPUT",
      "integrations: connectToProject is a person's connect, on their own context",
    );
  if (request.client !== "iterate" && request.client !== "project")
    throw codedError("INVALID_INPUT", 'integrations: client is "iterate" or "project"');
  request.scopes = z.array(z.string().min(1)).optional().parse(request.scopes);
  if (scope.rootPath !== "/" && !PERSONAL_PROVIDERS.includes(request.provider))
    throw codedError(
      "INVALID_INPUT",
      `integrations: a person connects ${PERSONAL_PROVIDERS.join(" or ")} (GitHub by signing in with it); a project connects ${request.provider}`,
    );
  const existing = integrations[connectionPathOf(request.provider, request.connection)];
  if (request.provider === "slack")
    return connectSlack(scope, { ...request, expectAccount: existing?.externalId });
  if (request.provider === "google")
    return connectGoogle(scope, { ...request, expectAccount: existing, connectToProject });
  if (request.provider === "cloudflare")
    return connectCloudflare(scope, {
      ...request,
      expectAccount: existing?.externalId,
      connectToProject,
    });
  if (request.provider === "github") return connectGithub(scope, request);
  if (request.provider === "waitrose")
    throw codedError(
      "INVALID_INPUT",
      "integrations: Waitrose has no consent to send a human to — set /secrets/waitrose-<connection> to { username, password } and call connectWaitrose",
    );
  throw codedError(
    "INVALID_INPUT",
    `integrations: no provider ${JSON.stringify(request.provider)}`,
  );
}

/** How the platform's callback finishes a connect: the OAuth attempt it completed (its nonce), what
 *  the provider granted, and — for a person's connect a project asked for — whether the human who
 *  consented is that person with the `account` scope, and their address (secret-oauth-callback.ts). */
export type FinishConnectInput = {
  provider: "slack" | "google" | "cloudflare";
  connection: string;
  nonce: string;
  grantedScopes: string[];
  consentedBy: { person: boolean; email?: string };
  /** The secret held the token aside: another project holds the account (Slack). */
  held?: HeldToken;
};

/** What the finish hands the callback: the offer to move the account here, when another project
 *  holds it, for the callback to sign. */
export type FinishConnectAnswer = { move?: MoveOffered };

const HeldTokenInput = z
  .object({ externalId: z.string().min(1), account: z.string(), until: z.number() })
  .optional();

/** THE CALLBACK FINISHES THE ATTEMPT IT COMPLETED — the platform's alone (context/built-ins.ts
 *  `integrations.finishConnect`): the attempt its nonce names, never one begun after it on the same
 *  connection. The finish is CLAIMED on the attempt before anything is called out (storage alone
 *  between the read and the write, so no other callback interleaves), and runs once: a second
 *  callback for the same consent, concurrent or a refresh, answers what the first did — its refusal
 *  again, success only once the project has the account, else "did not finish". The connection
 *  records what the provider granted. A person's connect a project asked for then connects the
 *  account to that project, when the consent granted what the project needs, the human who
 *  consented is the person themselves, and — for an account the project had already — the project
 *  has not disconnected it meanwhile. Again for a connection already connected, with no attempt
 *  left, is a no-op. */
export async function finishIntegrationConnect(
  scope: IntegrationScope,
  integrations: Record<string, IntegrationConnectionRow>,
  input: FinishConnectInput,
): Promise<FinishConnectAnswer> {
  const connection = assertConnectionName(input?.connection);
  const nonce = z.string().min(1).parse(input.nonce);
  const grantedScopes = z.array(z.string()).parse(input.grantedScopes);
  const held = HeldTokenInput.parse(input.held);
  const key = consentAttemptKeyOf(input.provider, connection, nonce);
  const attempt = await scope.storage.get<ConnectionAttempt>(key);
  if (!attempt || attempt.until < Date.now()) {
    if (integrations[connectionPathOf(input.provider, connection)]) return {};
    throw new Error("no connect of this connection is in flight — connect again");
  }
  if (attempt.finishing) {
    await answerAgain(scope, integrations, { provider: input.provider, connection }, attempt);
    return {};
  }
  await scope.storage.put<ConnectionAttempt>(key, { ...attempt, finishing: true });
  if (input.provider === "slack") {
    const move = await finishSlackConnect(
      scope,
      connection,
      attempt,
      held && { ...held, nonce },
    ).catch(async (error: unknown) => {
      await scope.storage.put<ConnectionAttempt>(key, attempt); // nothing connected: a refresh retries
      throw error;
    });
    await scope.storage.delete(key);
    return { move };
  }
  const row = await (
    input.provider === "google"
      ? finishGoogleConnect(scope, connection, attempt, grantedScopes)
      : finishCloudflareConnect(scope, connection, attempt, grantedScopes)
  ).catch(async (error: unknown) => {
    await scope.storage.put<ConnectionAttempt>(key, attempt); // nothing connected: a refresh retries
    throw error;
  });
  const target = attempt.connectToProject;
  if (target) {
    try {
      assertMayConnectToProject(row, target, input.consentedBy);
    } catch (error) {
      await scope.storage.put<ConnectionAttempt>(key, {
        ...attempt,
        finishing: true,
        refused: {
          code: errorCode(error) === "FORBIDDEN" ? "FORBIDDEN" : "INVALID_INPUT",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
    await connectAccountToProject(scope, row, target, input.consentedBy);
  }
  await scope.storage.delete(key);
  return {};
}

/** A second callback for a consent whose finish was claimed: the first one's answer again. */
async function answerAgain(
  scope: IntegrationScope,
  integrations: Record<string, IntegrationConnectionRow>,
  { provider, connection }: { provider: FinishConnectInput["provider"]; connection: string },
  attempt: ConnectionAttempt,
): Promise<void> {
  if (attempt.refused) throw codedError(attempt.refused.code, attempt.refused.message);
  const target = attempt.connectToProject;
  if (!target) {
    if (integrations[connectionPathOf(provider, connection)]) return;
    throw codedError("INVALID_INPUT", "this connect is still finishing — reload in a moment");
  }
  const connected = await connectionRowOf(
    scope.env,
    target.projectId,
    connectionPathOf(provider, connection),
  );
  if (connected?.ownerUserId === scope.rootPath.slice("/users/".length)) return;
  throw codedError(
    "INVALID_INPUT",
    "connecting this account to the project did not finish — connect it again from the project",
  );
}

/** Why a finished consent connects nothing to the project: the human who consented is not the
 *  person with the `account` scope, or the provider did not grant what the project needs. */
function assertMayConnectToProject(
  row: IntegrationConnectionRow,
  target: NonNullable<ConnectionAttempt["connectToProject"]>,
  consentedBy: FinishConnectInput["consentedBy"],
): void {
  if (!consentedBy?.person)
    throw codedError(
      "FORBIDDEN",
      "only the person themselves, signed in with access to their account, connects it to a project — the account is updated, but not connected to the project",
    );
  const missing = missingScopes(row.provider, row.scopes || [], target.requiredScopes);
  if (missing.length > 0)
    throw codedError(
      "INVALID_INPUT",
      `${row.provider} did not grant ${missing.join(", ")}, which the project needs — the account was not connected to the project`,
    );
}

/** A person's own connection (`row`, just finished on `scope`'s `/users/<id>`) connected to the
 *  project its consent was for: the platform's own call on the connection's secret
 *  (context/built-ins.ts `connectToProject`), which keeps the project's path a pointer to it. */
async function connectAccountToProject(
  scope: Pick<IntegrationScope, "env" | "projectId" | "rootPath">,
  row: IntegrationConnectionRow,
  target: NonNullable<ConnectionAttempt["connectToProject"]>,
  consentedBy: FinishConnectInput["consentedBy"],
): Promise<void> {
  const secretPath = tokenSecretPathOf(row.provider, row.connection);
  await scope.env.ITERATE_CONTEXT.getByName(
    DurableObjectNameCodec.stringify({ projectId: scope.projectId, path: scope.rootPath }),
  ).invoke(
    [
      "itx",
      "builtins",
      "secrets",
      [
        "connectToProject",
        secretPath,
        {
          projectId: target.projectId,
          connection: row,
          ownerEmail: consentedBy.email,
          onlyIfConnected: target.reconnect,
        },
      ],
    ],
    [],
    { principal: null, platform: true },
  );
}

/** DISCONNECT: the token revoked where the provider allows, the route and the secret gone, any
 *  connect in flight dropped, `<provider>/disconnected` on the owner's root. */
export async function disconnectIntegration(
  scope: IntegrationScope,
  integrations: Record<string, IntegrationConnectionRow>,
  input: {
    provider: IntegrationProvider;
    connection: string;
    /** Slack, GitHub: this connection's account moved to another project
     *  (`confirmIntegrationMove`) — disconnected only while it still names that account. */
    movedExternalId?: string;
  },
): Promise<void> {
  const connection = assertConnectionName(input?.connection);
  const movedExternalId = z.string().min(1).optional().parse(input.movedExternalId);
  const moved = movedExternalId ? { externalId: movedExternalId } : undefined;
  const row = integrations[connectionPathOf(input.provider, connection)];
  // the connection since took another account (or none): nothing of the moved one is left here
  if (moved && row?.externalId !== moved.externalId) return;
  if (row?.ownerUserId) return disconnectPersonalAccount(scope, row);
  if (input.provider === "slack")
    await disconnectSlack(scope, connection, row?.client ?? null, moved);
  else if (input.provider === "google")
    await disconnectGoogle(scope, connection, row?.client ?? null);
  else if (input.provider === "cloudflare") await disconnectCloudflare(scope, connection);
  else if (input.provider === "github") await disconnectGithub(scope, connection, moved);
  else if (input.provider === "waitrose") await disconnectWaitrose(scope, connection);
  else
    throw codedError(
      "INVALID_INPUT",
      `integrations: no provider ${JSON.stringify(input.provider)}`,
    );
}

/** The claims of a move offer (connections.ts `IntegrationMoveOffer`), once its signature checked. */
const MoveOfferClaims = z.object({
  kind: z.literal("integration-move"),
  provider: z.enum(ROUTED_PROVIDERS),
  projectId: z.string(),
  connection: z.string(),
  nonce: z.string(),
  externalId: z.string(),
  account: z.string(),
  exp: z.number(),
});

/** THE MOVE, on the human's confirmation of the offer a provider's callback signed: the route moves
 *  here in one batch, only while the holder still holds THIS account (catalog.ts
 *  `moveIntegrationRoute`), the account connects here (GitHub: its installation's token is minted
 *  here; Slack: the token its consent's exchange held aside goes into this connection's secret), and
 *  the holder's connection is disconnected — only while it still names this account
 *  (`<provider>/disconnected { reason: "moved" }`, its secret gone). The offer's nonce is the
 *  attempt's; a confirmation claims it before anything is called out, so it moves once. A move that
 *  fails before it lands puts every route back as it was, the destination's previous account
 *  included, and keeps no token here. The holder's cleanup is the last step: when it fails, the
 *  confirmation fails too, saying so, and the same offer retries the cleanup alone until it is done
 *  (meanwhile the holder gets no events, its route gone, and its secret facet refuses the account's
 *  token within 30 s of use: secret/durable-object.ts `#assertInstallationRouted`,
 *  `#assertWorkspaceNotMoved`). The human proved they may connect the account; they need not reach
 *  the holder's project. */
export async function confirmIntegrationMove(
  scope: IntegrationScope,
  input: { offer: string },
): Promise<void> {
  const { env, projectId } = scope;
  const expired = () =>
    codedError("INVALID_INPUT", "This offer to move it here has expired — connect again.");
  const claims = MoveOfferClaims.safeParse(
    await verifyClaims(String(input?.offer), await sessionSigningSecretOf(appConfigOf(env))),
  );
  if (!claims.success || claims.data.projectId !== projectId || claims.data.exp <= Date.now())
    throw expired();
  const { provider, connection, externalId } = claims.data;
  const key = attemptKeyOf(provider, connection);
  const attempt = await scope.storage.get<MovableAttempt>(key);
  if (
    !attempt?.move ||
    attempt.nonce !== claims.data.nonce ||
    attempt.move.externalId !== externalId ||
    attempt.until < Date.now()
  )
    throw expired();
  const { move } = attempt;
  if (move.stage === "moving")
    throw codedError("INVALID_INPUT", "This move is already under way — reload in a moment.");
  const { account, holder } = move;
  if (move.stage !== "moved") {
    // claimed before anything is called out: a second confirmation never moves it again
    await scope.storage.put<MovableAttempt>(key, {
      ...attempt,
      move: { ...move, stage: "moving" },
    });
    const path = connectionPathOf(provider, connection);
    const controlPlane = new ControlPlane(env);
    // what this connection held before, whose route the move releases and a failure restores
    const before = await connectionRowOf(env, projectId, path);
    // the offer is spent, and a token held for it is dropped
    const abandon = async () => {
      await scope.storage.delete(key);
      if (move.heldTokenNonce) await dropHeldSlackToken(scope, connection, move.heldTokenNonce);
    };
    try {
      await controlPlane.moveIntegrationRoute(provider, externalId, holder, { projectId, path });
    } catch (error) {
      await abandon();
      throw error;
    }
    try {
      if (provider === "github")
        await connectGithubInstallation(scope, connection, attempt, externalId, account, "held");
      else await connectMovedSlackTeam(scope, connection, attempt, move);
    } catch (error) {
      await controlPlane.moveIntegrationRoute(provider, externalId, { projectId, path }, holder);
      if (before?.client === "iterate" && before.externalId !== externalId)
        await controlPlane.routeIntegration(provider, before.externalId, projectId, path);
      await abandon();
      throw error;
    }
    await scope.storage.put<MovableAttempt>(key, { ...attempt, move: { ...move, stage: "moved" } });
  }
  // The holder's connection goes, but only while it still names this account: its route is gone
  // already; this removes the secret and its row, `reason: "moved"` on its log.
  try {
    await env.ITERATE_CONTEXT.getByName(
      DurableObjectNameCodec.stringify({ projectId: holder.projectId, path: "/" }),
    ).invoke(
      [
        "itx",
        "builtins",
        "facets",
        ["get", "project"],
        [
          "disconnectIntegration",
          {
            provider,
            connection: holder.path.slice(`/integrations/${provider}/`.length),
            movedExternalId: externalId,
          },
        ],
      ],
      [],
      { principal: null, platform: true },
    );
  } catch (error) {
    reportIssue("integrations.move-holder-disconnect", error, {
      provider,
      externalId,
      projectId,
      holderProjectId: holder.projectId,
    });
    throw codedError(
      "INVALID_INPUT",
      `${account} moved here, but the other project still lists it — press Move again to finish.`,
    );
  }
  await scope.storage.delete(key);
}

/** A person's account out of a project: the project's path, a pointer to the person's connection,
 *  deleted — which ends the pointer at their connection, leaves the connection theirs, and lands
 *  `<provider>/disconnected` here (context/built-ins.ts). A pointer already gone (`SECRET_NOT_SET`)
 *  drops the row alone; any other failure is the caller's to see, the row standing. */
async function disconnectPersonalAccount(
  scope: IntegrationScope,
  row: IntegrationConnectionRow,
): Promise<void> {
  const secretPath = tokenSecretPathOf(row.provider, row.connection);
  const deleted = await scope
    .withItx((itx) => itx.secrets.delete(secretPath))
    .then(
      () => true,
      (error: unknown) => {
        if (errorCode(error) === "SECRET_NOT_SET") return false;
        throw error;
      },
    );
  if (!deleted)
    await appendPlatformFact(scope.env, scope.projectId, scope.rootPath, {
      type: `events.iterate.com/${row.provider}/disconnected`,
      payload: { connection: row.connection },
    });
}
