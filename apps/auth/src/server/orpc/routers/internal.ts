import { ORPCError } from "@orpc/server";
import { os, serviceMiddleware } from "../orpc.ts";
import { auth } from "../../auth.ts";
import { parseStringArray } from "../../db/helpers.ts";
import {
  disableOAuthClientById,
  getOAuthClientByClientId,
  getOAuthClientByReferenceId,
  overwriteOAuthClientByClientId,
  updateOAuthClientReferenceByClientId,
} from "../../db/queries/index.ts";
import { BOOTSTRAP_ADMIN_EMAIL } from "../../bootstrap-admin.ts";

// Deploy-time OAuth client provisioning, called by Node processes that
// authenticate with SERVICE_AUTH_TOKEN (serviceMiddleware):
//  - ensureClient: apps/os alchemy dev bootstrap
//    (apps/os/src/auth/dev-oauth-client-bootstrap.ts) and the Doppler sync
//    script (apps/os/scripts/sync-auth-clients.ts). Server-generated secrets.
//  - setClient: the post-deploy seed (apps/auth/scripts/seed-oauth-clients.ts).
//    Caller-provided credentials, Doppler is the source of truth.
//
// Everything else that used to live in this router (project directory reads,
// project creation, project-id minting) moved to Workers RPC on the worker
// entrypoint — see ../../project-directory.ts and worker.ts.

function extractCookieHeader(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const firstCookie = setCookieHeader.split(/,(?=[^;]+=[^;]+)/)[0]?.trim();
  if (!firstCookie) return null;
  return firstCookie.split(";")[0] ?? null;
}

// Client CREATION goes through better-auth's admin API (adminCreateOAuthClient)
// so rows get the oauth-provider plugin's defaults (grant/response types, token
// endpoint auth method, hashed secret storage). That API wants an admin
// SESSION, so we sign in as the seeded bootstrap admin — whose password IS the
// service token (scripts/render-admin-seed.ts writes that credential row at
// deploy time). The caller already proved it holds the token via
// serviceMiddleware, so this is a format conversion, not an extra trust step.
async function getBootstrapAdminAuthHeaders(params: {
  serviceAuthToken: string;
}): Promise<Headers> {
  const signInResult = await auth.api.signInEmail({
    returnHeaders: true,
    body: {
      email: BOOTSTRAP_ADMIN_EMAIL,
      password: params.serviceAuthToken,
    },
  });

  const cookie = extractCookieHeader(signInResult.headers.get("set-cookie"));
  if (!cookie) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Failed to establish bootstrap admin auth session",
    });
  }

  return new Headers({ cookie });
}

function requireServiceAuthToken(env: { SERVICE_AUTH_TOKEN?: string }): string {
  const serviceAuthToken = env.SERVICE_AUTH_TOKEN?.trim();
  if (!serviceAuthToken) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "SERVICE_AUTH_TOKEN is required for OAuth client provisioning",
    });
  }
  return serviceAuthToken;
}

async function createOAuthClientViaAdminApi(params: {
  serviceAuthToken: string;
  clientName: string;
  redirectURIs: string[];
}) {
  const headers = await getBootstrapAdminAuthHeaders({
    serviceAuthToken: params.serviceAuthToken,
  });
  const created = await auth.api.adminCreateOAuthClient({
    headers,
    body: {
      client_name: params.clientName,
      redirect_uris: params.redirectURIs,
    },
  });
  if (!created.client_name || !created.client_secret) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Failed to create OAuth client, got unexpected response from auth API",
      cause: { created },
    });
  }
  return {
    client_id: created.client_id,
    client_name: created.client_name,
    client_secret: created.client_secret,
    redirect_uris: created.redirect_uris,
  };
}

// ensureClient keeps a deploy-managed client in sync with what the deploy
// wants, identified by a stable referenceId (e.g. "os:dev_jonas:web"):
//  - Caller still holds the secret and nothing changed -> no-op / metadata
//    update.
//  - Caller lost the secret (fresh checkout) or asked for rotation -> disable
//    the old row and create a fresh client. Secrets are stored hashed
//    (see hashOAuthClientSecret below), so handing back an existing secret is
//    impossible by design.
//
// The dev-referenceId special case: personal dev stages recreate their env
// often, and a developer's stored (clientId, clientSecret) pair may have been
// re-referenced under a different referenceId along the way. For those we
// trust the caller's pair over the referenceId lookup and re-point the
// referenceId at the caller's client instead of rotating — otherwise every
// `pnpm dev` in a second worktree would invalidate the first worktree's
// client.
const ensureOAuthClient = os.internal.oauth.ensureClient
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const redirectURIs = [...new Set(input.redirectURIs.map((uri) => uri.trim()))].sort();
    const existingByReferenceId = await getOAuthClientByReferenceId(context.db, {
      referenceId: input.referenceId,
    });
    const existingByClientId = input.existingClientId
      ? await getOAuthClientByClientId(context.db, {
          clientId: input.existingClientId,
        })
      : null;
    const isDevStageClient =
      input.referenceId.startsWith("dev:") || input.referenceId.includes(":dev_");

    const trustCallerClientId = isDevStageClient && Boolean(existingByClientId?.clientSecret);
    const existing = trustCallerClientId ? existingByClientId : existingByReferenceId;
    const callerHoldsSecret = Boolean(input.existingClientSecret) && !input.rotateClientSecret;

    if (existing?.clientSecret && callerHoldsSecret && input.existingClientSecret) {
      // Re-pointing a dev referenceId at the caller's client may leave the
      // previously referenced row dangling — disable it.
      if (
        trustCallerClientId &&
        existingByReferenceId &&
        existingByReferenceId.id !== existing.id
      ) {
        await disableOAuthClientById(
          context.db,
          { updatedAt: Date.now() },
          { id: existingByReferenceId.id },
        );
      }

      const existingSorted = parseStringArray(existing.redirectUrisJson).sort();
      const needsUpdate =
        existing.name !== input.clientName ||
        existing.disabled !== 0 ||
        existing.referenceId !== input.referenceId ||
        JSON.stringify(existingSorted) !== JSON.stringify(redirectURIs);

      if (needsUpdate) {
        await updateOAuthClientReferenceByClientId(
          context.db,
          {
            referenceId: input.referenceId,
            name: input.clientName,
            redirectUris: JSON.stringify(redirectURIs),
            updatedAt: Date.now(),
          },
          {
            clientId: existing.clientId,
          },
        );
      }

      return {
        clientId: existing.clientId,
        clientName: input.clientName,
        clientSecret: input.existingClientSecret,
        redirectURIs,
      };
    }

    // Fresh client needed: disable whatever rows currently answer to this
    // referenceId or client id so exactly one active client remains.
    const staleIds = new Set(
      [existingByReferenceId, existingByClientId]
        .filter((row) => row && row.disabled === 0)
        .map((row) => row!.id),
    );
    for (const staleId of staleIds) {
      await disableOAuthClientById(context.db, { updatedAt: Date.now() }, { id: staleId });
    }

    const created = await createOAuthClientViaAdminApi({
      serviceAuthToken: requireServiceAuthToken(context.env),
      clientName: input.clientName,
      redirectURIs,
    });

    await updateOAuthClientReferenceByClientId(
      context.db,
      {
        referenceId: input.referenceId,
        name: input.clientName,
        redirectUris: JSON.stringify(redirectURIs),
        updatedAt: Date.now(),
      },
      {
        clientId: created.client_id,
      },
    );

    return {
      clientId: created.client_id,
      clientName: created.client_name,
      clientSecret: created.client_secret,
      redirectURIs: created.redirect_uris,
    };
  });

// The oauth-provider plugin stores client secrets as unsalted SHA-256
// base64url (its `defaultHasher` with storeClientSecret: "hashed") and
// compares hashes at the token endpoint — seeded secrets must be stored in
// the same format.
async function hashOAuthClientSecret(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// Declarative upsert with caller-provided credentials. Unlike ensureClient
// (which generates/rotates secrets server-side), the caller's Doppler config is
// the source of truth: re-running with the same input is a no-op, and nothing
// in the auth app ever rotates a seeded client. Used by the OAuth client seed
// (apps/auth/scripts/seed-oauth-clients.ts) after each deploy.
const setOAuthClient = os.internal.oauth.setClient
  .use(serviceMiddleware)
  .handler(async ({ context, input }) => {
    const redirectURIs = [...new Set(input.redirectURIs.map((uri) => uri.trim()))].sort();
    const overwrite = {
      newClientId: input.clientId,
      clientSecret: await hashOAuthClientSecret(input.clientSecret),
      name: input.clientName,
      redirectUris: JSON.stringify(redirectURIs),
      referenceId: input.referenceId ?? null,
      skipConsent: input.skipConsent ? 1 : 0,
      updatedAt: Date.now(),
    };

    const existing = await getOAuthClientByClientId(context.db, { clientId: input.clientId });
    if (existing) {
      await overwriteOAuthClientByClientId(context.db, overwrite, { clientId: input.clientId });
    } else {
      // Create through the admin API so the row gets the plugin's defaults
      // (token endpoint auth method, grant/response types, …), then overwrite
      // the generated credentials with the caller-provided constants.
      const created = await createOAuthClientViaAdminApi({
        serviceAuthToken: requireServiceAuthToken(context.env),
        clientName: input.clientName,
        redirectURIs,
      });
      await overwriteOAuthClientByClientId(context.db, overwrite, {
        clientId: created.client_id,
      });
    }

    return {
      clientId: input.clientId,
      clientName: input.clientName,
      clientSecret: input.clientSecret,
      redirectURIs,
    };
  });

export const internal = os.internal.router({
  oauth: {
    ensureClient: ensureOAuthClient,
    setClient: setOAuthClient,
  },
});
