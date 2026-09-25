// src/secret/durable-object.ts — THE SECRET: the `secret` facet on the context at `/secrets/<name>`
// (contract.ts) — the material's ONE keeper (this facet's own storage: the record with its material
// ENCRYPTED, a write counter, the pending OAuth attempt) and the one code that ever sees it in the
// clear: `fetch(request)`. A request naming this secret arrives from a context's egress
// (iterate-context-durable-object.ts `#egress`: forwarded to this path, and there to this facet), the
// placeholder is substituted HERE, the pin checked, the request dispatched — and when the pinned host
// answers 401, or the material has no `accessToken` yet, the refresh strategy re-mints in this same
// trusted code and the request is retried ONCE. One facet = one writer: a rotating refresh token is
// never raced by two contexts. A WebSocket upgrade is a dispatch like any other: the 101 and its
// socket ride the fetch channel back through the parent to the caller — this facet HOLDS no socket,
// it dials one and hands it back, so the socket lives as long as the dial does (measured 2026-09-21,
// __workers-tests__/secret-facet-proxies-a-socket.test.ts: the frames round-trip; the facet's abort
// closes it, 1006). The one exception is an upgrade whose FRAMES carry the credential (Discord's
// IDENTIFY; secrets.ts `SECRET_FRAMES_HEADER`): this facet holds the upstream socket and pumps
// frames, substituting its placeholder in client text frames (`proxyFrames`,
// __workers-tests__/secret-sockets-over-lends.test.ts).
//
// The verbs `itx.secrets` runs (context/built-ins.ts — ON THIS PATH, so the log's order is the
// storage's, and through the facet host's platform entry: a caller's itx expression reaches the reads
// alone, `publicMethods`): `write(record)` and `clear()` store and forget the value; the FACTS (`secret/set`,
// `secret/deleted`, on this path and cross-posted to the owner's root) are the built-in's, attributed
// to the caller — a facet's own appends speak for the project, so they are not made here.
// `beginOAuth` keeps the pending attempt and hands back the authorize URL; `completeOAuth` exchanges
// the code into the record (secret-oauth.ts). The deployment's own app at a provider (an integration's
// `client: { platform }`, APP_CONFIG `integrations.<provider>`) is attached here, where APP_CONFIG is,
// and only ever toward that app's own provider; a project's own app is this secret's material. The
// two facts this facet appends itself, best-effort:
// `secret/used` per dispatch and `secret/refreshed` per refresh outcome. It hosts the secret processor
// (processor.ts): `snapshot()` says whether material was set and whether the secret was deleted, by
// the offsets of the facts that say so. Hosted from `ctx.exports` (first-party-facets.ts): ordinary
// bundled worker code with the worker's real env — the at-rest key and the signing secret among it.
// A secret refreshed by EXCHANGE CODE (`refresh: { kind: "worker", source }`) is the one place loaded
// code runs under this facet, in its jail (exchange-jail.ts): no env, the pin as its only egress.

import { createPrivateKey } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { EventInput } from "iterate/stream/processor";
import type { SecretHmacVerification, SecretMaterial, SecretRefresh } from "iterate/api";
import { codedError, reportIssue } from "iterate/lib";
import { signClaims, verifyAdminSecret } from "../caller.ts";
import {
  appConfigOf,
  atRestKeysOf,
  sessionSigningSecretOf,
  type AppConfigEnv,
} from "../app-config.ts";
import { DurableObjectNameCodec, pathUnderOwner, resourceScope } from "../context/paths.ts";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import type { IterateContextDurableObject } from "../iterate-context-durable-object.ts";
import { lendVerdict } from "../integrations/rules.ts";
import { googleEndpointsOf } from "../integrations/google.ts";
import { githubApiOriginOf } from "../integrations/github.ts";
import { cloudflareEndpointsOf } from "../integrations/cloudflare.ts";
import {
  decryptSecretMaterial,
  encryptSecretMaterial,
  type EncryptedMaterial,
  type MaterialKeys,
} from "../secret-at-rest.ts";
import {
  beginSecretOAuth,
  completeSecretOAuth,
  secretOAuthCallbackPathOf,
  SECRET_OAUTH_TTL_MS,
  type NormalizedSecretOAuthOptions,
  type PendingSecretOAuth,
  type SecretOAuthState,
} from "../secret-oauth.ts";
import {
  isRecord,
  LEND_USE_HEADER,
  LENT_AS_HEADER,
  oauthTokenRequest,
  oauthTokensOf,
  originPinned,
  pinRefusal,
  SecretRefused,
  refreshSecretMaterial,
  SECRET_FRAMES_HEADER,
  secretPathsIn,
  signLendUse,
  substituteProjectSecrets,
  substituteSecretInFrame,
  verifySecretHmac,
  type SecretRecord,
} from "../secrets.ts";
import { SecretContract, type SecretState } from "./contract.ts";
import { runExchangeCode } from "./exchange-jail.ts";
import { SecretProcessor } from "./processor.ts";

/** The deployment's apps a strategy names as its client (`{ platform }`, secrets.ts). */
type OAuthPlatform = NonNullable<
  Extract<SecretRefresh, { kind: "oauth-refresh-token" }>["client"]
>["platform"];

/** What sits in storage. `stored` is the record with the revision it was written at — its material
 *  ENCRYPTED (secret-at-rest.ts), bound to this context, the pin and that revision; `revision` is
 *  THE WRITE COUNTER every change bumps (`write`, `clear`, `beginOAuth`) — a refresh commits only
 *  against the revision it read, and a code exchange only against the counter it started at, so a
 *  write or a clear racing either never has its outcome overwritten by a mint or an exchange from
 *  before it. The counter is never reset: a `clear` bumps it too, so a delete followed by a new
 *  write can never present the number a stale mint is waiting for. `pending` is the OAuth attempt in
 *  flight; `completed` the last one finished (its nonce and the revision it wrote), so its callback
 *  completes idempotently instead of exchanging twice. */
type Stored = {
  record: Omit<SecretRecord, "material"> & { material: EncryptedMaterial };
  revision: number;
};

/** THE LENDS of this secret (storage `lends`), by lend id: the project it is lent to (or
 *  `every-project`) and the path it is lent as there. A revoked lend is gone. A lend to every project
 *  keeps each project that borrows it under its own key (`borrowerKey`), so a revocation reaches
 *  them all and one project's return ends the lend for it alone. */
type Lends = Record<string, { to: string; as: string }>;

/** A project that borrows a lend to every project: its storage key. */
const borrowerKey = (lendId: string, projectId: string) => `borrower:${lendId}:${projectId}`;

/** The lends a `clear` or an `endLend` ended, each with the projects it reached. */
type EndedLends = Record<string, { to: string; as: string; borrowers: string[] }>;

/** A BORROWED secret's record (storage `borrowed`, instead of `stored`): the lender's secret context
 *  (its Durable Object name), its path under the lender's root and the lend. No material. */
type Borrowed = { lender: string; lenderPath: string; lendId: string };

export class SecretDurableObject extends StreamProcessorDurableObject<
  SecretState,
  {
    ITX?: ItxEntrypointService;
    DB: D1Database;
    ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
    LOADER: WorkerLoader;
  } & AppConfigEnv,
  ItxEntrypointScope
> {
  /** The secret's READS alone — whether material was set and whether it was deleted, by the offsets
   *  of the facts that say so. Everything else here is the platform's: `write`, `clear`,
   *  `beginOAuth`, `completeOAuth` and `verifyHmac` are `itx.secrets`'s (context/built-ins.ts, whose
   *  verbs append the attributed facts), `fetch` is egress's and `exportForProjectSeed` the operator's
   *  native RPC — each reaches this facet through the facet host's platform entry. */
  static override publicMethods = ["snapshot", "liveSnapshot", "waitUntilProcessed"];

  processor = new SecretProcessor();

  /** The one refresh in flight, keyed by the revision it read (single-flight: N callers who 401
   *  together on the same material share ONE mint). A caller holding a NEWER revision — a write
   *  landed while a mint for the old material was running, and the fence will drop that mint — is
   *  never coalesced onto it: its own mint queues behind the running one. */
  #refreshing: { revision: number; promise: Promise<void> } | undefined;

  /** This facet's identity, from its context's name (`ctx.props`, sdk/index.ts): the context, and
   *  the PATH THE PLACEHOLDER SPELLS — the context's path relative to the resource owner's root
   *  (context/paths.ts `resourceScope`): `/secrets/shop` for a project's `/secrets/shop` and for a
   *  user's `/users/<id>/secrets/shop` alike. */
  #address(): { context: string; path: string } {
    const context = this.ctx.props.iterateContextName;
    const { projectId, path } = DurableObjectNameCodec.parse(context);
    return { context, path: pathUnderOwner(resourceScope(projectId, path), path) };
  }

  /** Replace the record whole — material always travels with its complete policy, so a value
   *  never inherits a pin or a strategy it was not set with — or, with `merge`, the record's fields
   *  over the stored material's, under the same pin. The caller
   *  (`itx.secrets.set`) has appended the fact already; this is the value. */
  async write(record: SecretRecord, merge = false): Promise<void> {
    const stored = merge ? await this.ctx.storage.get<Stored>("stored") : undefined;
    if (stored) {
      // the pin travels with the material it guards: a merge never moves stored material elsewhere
      if ([...stored.record.urls].sort().join() !== [...record.urls].sort().join())
        throw new Error(`secrets: a merge keeps the pin ${stored.record.urls.join(", ")}`);
      const { material } = await this.#opened(stored);
      record = {
        ...record,
        material: {
          ...(isRecord(material) && material),
          ...(isRecord(record.material) && record.material),
        },
      };
    }
    const revision = await this.#bump();
    await this.ctx.storage.put<Stored>("stored", await this.#sealed(record, revision));
    // A write supersedes any OAuth attempt in flight: its callback must not overwrite this material;
    // and material of its own replaces a borrowed record.
    await this.ctx.storage.delete(["pending", "borrowed"]);
  }

  /** The record as storage holds it: the material encrypted under the deployment's key, bound to
   *  this context, the pin and the revision it is written at. */
  async #sealed(record: SecretRecord, revision: number): Promise<Stored> {
    const material = await encryptSecretMaterial(
      record.material,
      { context: this.#address().context, urls: record.urls, revision },
      this.#keys(),
    );
    return { record: { ...record, material }, revision };
  }

  /** The stored record with its material in the clear, for this facet's own use only. A record
   *  the previous key opened (a rotation in progress) is written back under the current key here,
   *  so a rotation completes one read at a time. A record neither key opens — one under a key that
   *  is gone, or bound elsewhere — is a refusal that names the fix. */
  async #opened(stored: Stored): Promise<SecretRecord> {
    const { context, path } = this.#address();
    const binding = { context, urls: stored.record.urls, revision: stored.revision };
    let opened: Awaited<ReturnType<typeof decryptSecretMaterial>>;
    try {
      opened = await decryptSecretMaterial(stored.record.material, binding, this.#keys());
    } catch {
      throw new SecretRefused(
        `itx.fetch: the stored material of ${path} cannot be opened (a rotated key, or another context's record) — set the secret again`,
      );
    }
    const record = { ...stored.record, material: opened.material };
    if (opened.rotated) {
      const current = await this.ctx.storage.get<Stored>("stored");
      if (current?.revision === stored.revision)
        await this.ctx.storage.put<Stored>("stored", await this.#sealed(record, stored.revision));
    }
    return record;
  }

  #keys(): MaterialKeys {
    return atRestKeysOf(appConfigOf(this.env));
  }

  /** Operator recovery exports only the current encrypted value, with its original AAD.
   * The credential arrives over native RPC, never through project-authored rewrites. Ordinary
   * facet callers cannot export a cell, even if they own the project. */
  async exportForProjectSeed(adminSecret: unknown) {
    if (
      typeof adminSecret !== "string" ||
      !(await verifyAdminSecret(
        adminSecret,
        appConfigOf(this.env).secrets.adminBearer.exposeSecret(),
      ))
    )
      throw codedError("FORBIDDEN", "Secret recovery exports require operator authority.");
    const stored = await this.ctx.storage.get<Stored>("stored");
    if (!stored)
      throw codedError("INVALID_INPUT", "This secret has no current material to back up.");
    const { context, path } = this.#address();
    return { context, path, revision: stored.revision, ...stored.record };
  }

  /** The write counter, bumped: the number the write that follows is fenced by. */
  async #bump(): Promise<number> {
    const revision = ((await this.ctx.storage.get<number>("revision")) ?? 0) + 1;
    await this.ctx.storage.put("revision", revision);
    return revision;
  }

  /** Forget the record and any attempt — a write like any other (the counter moves on, so a mint or
   *  an exchange started before the clear cannot land after it, even under a new write). */
  async clear(): Promise<{ lends: EndedLends; borrowed: Borrowed | null }> {
    await this.#bump();
    const lends: EndedLends = {};
    for (const [lendId, lend] of Object.entries((await this.ctx.storage.get<Lends>("lends")) ?? {}))
      lends[lendId] = { ...lend, borrowers: await this.#takeBorrowers(lendId, lend) };
    const borrowed = (await this.ctx.storage.get<Borrowed>("borrowed")) ?? null;
    await this.ctx.storage.delete(["stored", "pending", "completed", "lends", "borrowed"]);
    // what the clear ended, for the built-in to end on the other side (context/built-ins.ts `delete`)
    return { lends, borrowed };
  }

  /** The projects a lend reaches, forgotten here: a lend to every project's borrowers, or the one
   *  project it is lent to. */
  async #takeBorrowers(lendId: string, lend: { to: string }): Promise<string[]> {
    if (lend.to !== "every-project") return [lend.to];
    const prefix = borrowerKey(lendId, "");
    const keys = [...(await this.ctx.storage.list({ prefix })).keys()];
    for (let at = 0; at < keys.length; at += 128)
      await this.ctx.storage.delete(keys.slice(at, at + 128));
    return keys.map((key) => key.slice(prefix.length));
  }

  // ── LENDS: a person's secret, or the deployment's own (the operator's), used by a project, the
  // material never leaving this facet. The lender's `itx.secrets.lend` keeps the lend here (`lend`)
  // and the borrower's path keeps only `{ lender, lendId }` (`borrow`); a use of the borrowed path is
  // forwarded to the lender's context over its `fetch` with the lend signed
  // (iterate-context-durable-object.ts `#lentFetch`), admitted here (`admitLend`:
  // integrations/rules.ts `lendVerdict`) and run by this facet's own dispatch (`fetch` with
  // `LENT_AS_HEADER`). The facts are the built-ins' (context/built-ins.ts).

  /** Keep a lend: the pin of the material it lends, for the borrower's catalog. */
  async lend(input: { lendId: string; to: string; as: string }): Promise<{ urls: string[] }> {
    const stored = await this.ctx.storage.get<Stored>("stored");
    if (!stored) throw new Error(`${this.#address().path} holds no material to lend`);
    const lends = (await this.ctx.storage.get<Lends>("lends")) ?? {};
    await this.ctx.storage.put<Lends>("lends", {
      ...lends,
      [input.lendId]: { to: input.to, as: input.as },
    });
    return { urls: stored.record.urls };
  }

  /** A project borrows a lend to every project (`borrowed`), or its borrow failed and it does not
   *  (`!borrowed`). The lend and the path it is lent as, or null when the lend is gone. */
  async everyProjectBorrower(
    lendId: string,
    projectId: string,
    borrowed: boolean,
  ): Promise<{ as: string; urls: string[] } | null> {
    const lend = ((await this.ctx.storage.get<Lends>("lends")) ?? {})[lendId];
    const stored = await this.ctx.storage.get<Stored>("stored");
    if (!lend || lend.to !== "every-project" || !stored) return null;
    if (borrowed) await this.ctx.storage.put(borrowerKey(lendId, projectId), true);
    else await this.ctx.storage.delete(borrowerKey(lendId, projectId));
    return { as: lend.as, urls: stored.record.urls };
  }

  /** The lend ended: what it was and the projects it ended for, or null when it is already gone. A
   *  `borrower` named (the borrower's own delete) must be the one it was lent to — or, a lend to
   *  every project, ends for that project alone and the lend stands. */
  async endLend(
    lendId: string,
    borrower?: string,
  ): Promise<{ to: string; as: string; borrowers: string[] } | null> {
    const { [lendId]: lend, ...rest } = (await this.ctx.storage.get<Lends>("lends")) ?? {};
    if (!lend) return null;
    if (borrower && lend.to === "every-project") {
      if (!(await this.ctx.storage.get(borrowerKey(lendId, borrower)))) return null;
      await this.ctx.storage.delete(borrowerKey(lendId, borrower));
      return { ...lend, borrowers: [borrower] };
    }
    if (borrower && lend.to !== borrower) throw new Error("this lend is to another project");
    await this.ctx.storage.put<Lends>("lends", rest);
    return { ...lend, borrowers: await this.#takeBorrowers(lendId, lend) };
  }

  /** This path borrows: it holds the lend alone, and every use is forwarded to the lender. */
  async borrow(borrowed: Borrowed): Promise<void> {
    // coded: a lend to every project skips a project that keeps its own (built-ins.ts `lendInto`)
    if (await this.ctx.storage.get<Stored>("stored"))
      throw codedError(
        "INVALID_INPUT",
        `${this.#address().path} holds a secret of its own — delete it first`,
      );
    // one lend per path: a second would leave the first live at its lender, unseen
    const held = await this.ctx.storage.get<Borrowed>("borrowed");
    if (held && held.lendId !== borrowed.lendId)
      throw new Error(`${this.#address().path} borrows another lend already — delete it first`);
    await this.#bump();
    await this.ctx.storage.put<Borrowed>("borrowed", borrowed);
  }

  /** The lend this path borrows ended at the lender: forget it. False when this path borrows
   *  another lend, or none. */
  async dropBorrowed(lendId: string): Promise<boolean> {
    const borrowed = await this.ctx.storage.get<Borrowed>("borrowed");
    if (borrowed?.lendId !== lendId) return false;
    await this.#bump();
    await this.ctx.storage.delete("borrowed");
    return true;
  }

  /** Whether `borrower` may use this secret under the lend: the path it borrows as, or why not. */
  async admitLend(input: {
    lendId: string;
    borrower: string;
  }): Promise<{ as: string } | { refused: string; revoke?: "membership-ended" }> {
    const lend = ((await this.ctx.storage.get<Lends>("lends")) ?? {})[input.lendId] ?? null;
    const { projectId, path } = DurableObjectNameCodec.parse(this.#address().context);
    const owner = resourceScope(projectId, path);
    const borrowing =
      lend?.to === "every-project" &&
      Boolean(await this.ctx.storage.get(borrowerKey(input.lendId, input.borrower)));
    const lender =
      owner.kind === "global"
        ? ("instance" as const)
        : {
            reachesBorrower:
              lend?.to === input.borrower &&
              owner.kind === "users" &&
              (await new ControlPlane(this.env).reachesProject(
                { userId: owner.ownerId },
                input.borrower,
              )),
          };
    return lendVerdict({ lend, borrower: input.borrower, borrowing, lender });
  }

  /** THE VERIFY OPERATION (for webhooks): is `signature` the HMAC-SHA256
   *  of `payload` under this secret's material? The material is opened HERE and the answer is one
   *  bit — nothing comes out, and no request goes anywhere, so the pin is not consulted. The
   *  candidate arrives from an unauthenticated caller (a webhook): a secret never set, or a material
   *  with no key at the field, answers false rather than describing itself; the comparison is
   *  constant-time. */
  async verifyHmac(input: SecretHmacVerification): Promise<boolean> {
    const stored = await this.ctx.storage.get<Stored>("stored");
    if (!stored) return false;
    const { material } = await this.#opened(stored);
    return verifySecretHmac(material, input);
  }

  /** OAUTH, step one: keep the pending attempt, hand back the authorize URL. The `state` is a
   *  platform-signed claim naming this context, a nonce only this attempt knows and `next`; the
   *  redirect URI is the platform's callback for the client (secret-oauth.ts). A new attempt replaces an unfinished one;
   *  the record, if any, stays until the exchange writes over it. Nothing lands on any log until the
   *  exchange succeeds — an abandoned attempt leaves no trace. */
  async beginOAuth(
    options: NormalizedSecretOAuthOptions,
    /** the platform origin the callback hangs under — the caller's (a facet knows none itself) */
    platformOrigin: string,
  ): Promise<{ authorizationUrl: string }> {
    const config = appConfigOf(this.env);
    const nonce = crypto.randomUUID();
    const state: SecretOAuthState = {
      kind: "secret-oauth",
      context: this.#address().context,
      nonce,
      exp: Date.now() + SECRET_OAUTH_TTL_MS,
      next: options.next,
    };
    const { clientId } = await this.#oauthClientOf(options);
    const { pending, authorizationUrl } = await beginSecretOAuth(
      { ...options, clientId },
      {
        redirectUri: `${platformOrigin}${secretOAuthCallbackPathOf(options.client)}`,
        state: await signClaims(state, await sessionSigningSecretOf(config)),
        nonce,
      },
    );
    await this.#bump(); // a new attempt is a write: an exchange started before it will not land
    await this.ctx.storage.put<PendingSecretOAuth>("pending", pending);
    return { authorizationUrl };
  }

  /** The OAuth client an attempt exchanges with, and the material kept beside its tokens: the one
   *  passed in the clear; the deployment's app (`{ platform }`), refused toward any endpoint but its
   *  own provider's — the exchange, and every refresh after it, would carry its secret there; or
   *  the project's own app, which this secret's material holds (`{ project }`). */
  async #oauthClientOf(options: {
    client: NormalizedSecretOAuthOptions["client"] | { platform: OAuthPlatform };
    clientId: string;
    clientSecret: string;
    authorizationEndpoint?: string;
    tokenEndpoint: string;
  }): Promise<{ clientId: string; clientSecret: string; kept: Record<string, unknown> }> {
    const { client } = options;
    if (!client)
      return { clientId: options.clientId, clientSecret: options.clientSecret, kept: {} };
    if ("platform" in client) {
      const app = this.#platformOAuthApp(client.platform);
      for (const endpoint of [options.authorizationEndpoint, options.tokenEndpoint])
        if (endpoint && !app.origins.includes(new URL(endpoint).origin))
          throw new Error(
            `secrets: the platform's ${client.platform} app is at ${app.origins.join(", ")} — not ${new URL(endpoint).origin}`,
          );
      return { clientId: app.clientId, clientSecret: app.clientSecret, kept: {} };
    }
    const stored = await this.ctx.storage.get<Stored>("stored");
    const kept = stored ? (await this.#opened(stored)).material : undefined;
    if (!isRecord(kept) || typeof kept.clientId !== "string" || !kept.clientId)
      throw new Error(
        `${this.#address().path} holds no ${client.project} app — set it to { clientId, clientSecret, … } first`,
      );
    const clientSecret = typeof kept.clientSecret === "string" ? kept.clientSecret : "";
    return { clientId: kept.clientId, clientSecret, kept };
  }

  /** The deployment's app at a provider (APP_CONFIG `integrations.<provider>`) and the origins its
   *  provider's OAuth endpoints answer on; refused when the deployment has none. GitHub's is the
   *  App's user-authorization client (a GitHub sign-in's token refreshes with it). */
  #platformOAuthApp(provider: OAuthPlatform) {
    const { slack, google, cloudflare, github } = appConfigOf(this.env).integrations;
    const googleEndpoints = googleEndpointsOf(google?.googleOrigin);
    const app =
      provider === "slack"
        ? slack && { app: slack, origins: [slack.slackOrigin] }
        : provider === "google"
          ? google && {
              app: google,
              origins: [
                ...new Set(
                  [googleEndpoints.authorizationEndpoint, googleEndpoints.tokenEndpoint].map(
                    (endpoint) => new URL(endpoint).origin,
                  ),
                ),
              ],
            }
          : provider === "cloudflare"
            ? cloudflare && {
                app: cloudflare,
                origins: [
                  new URL(cloudflareEndpointsOf(cloudflare.cloudflareOrigin).tokenEndpoint).origin,
                ],
              }
            : github && { app: github, origins: [github.githubOrigin] };
    if (!app)
      throw new Error(
        `secrets: this deployment has no ${provider} app (APP_CONFIG integrations.${provider} is unset)`,
      );
    return {
      clientId: app.app.oauthClientId,
      clientSecret: app.app.oauthClientSecret.exposeSecret(),
      origins: app.origins,
    };
  }

  /** OAUTH, step two (the callback, through `itx.secrets.completeOAuth` on this path): the code for
   *  the pending attempt the nonce names → the exchange → the record, as a write. A stale or foreign
   *  callback (a back button, an older authorize URL, a replay with a junk code) fails without
   *  touching the live attempt; the attempt is consumed only when its exchange succeeds. The
   *  exchange lands only if nothing else wrote this facet while the provider was answering: a write
   *  or a clear in that window wins and the tokens are discarded (from the fence to the completion
   *  mark only storage awaits follow, which the input gate holds together). Answers the pin and the
   *  strategy kind the record was stored with — what the fact carries; never the material. IDEMPOTENT for the attempt
   *  it completed: the same callback again (a refreshed tab, or the built-in retrying after its fact
   *  append failed) runs no second exchange and answers the same pin, as long as the record is still
   *  the one this attempt wrote — so the log can always catch up with a live facet. `exchanged` says
   *  which happened: THIS call wrote the record (the caller may undo it if its fact append fails), or
   *  a replay found it. */
  async completeOAuth(input: {
    code: string;
    nonce: string;
  }): Promise<{ urls: string[]; refresh?: SecretRefresh["kind"]; exchanged: boolean }> {
    const completed = await this.ctx.storage.get<{ nonce: string; revision: number }>("completed");
    if (completed?.nonce === input.nonce) {
      const stored = await this.ctx.storage.get<Stored>("stored");
      if (stored?.revision === completed.revision)
        return {
          urls: stored.record.urls,
          refresh: stored.record.refresh?.kind,
          exchanged: false,
        };
      throw new Error(
        "this attempt completed, but the secret was written or cleared since — begin again",
      );
    }
    const pending = await this.ctx.storage.get<PendingSecretOAuth>("pending");
    if (!pending || pending.nonce !== input.nonce)
      throw new Error("no pending attempt matches this callback — begin again");
    if (pending.until <= Date.now()) {
      await this.ctx.storage.delete("pending");
      throw new Error("the attempt expired — begin again");
    }
    const started = await this.ctx.storage.get<number>("revision");
    const credentials = await this.#oauthClientOf(pending.options);
    const record = await completeSecretOAuth(
      pending,
      input.code,
      (exchange) => {
        if (!originPinned(exchange.url, pending.options.urls))
          throw new Error(`the token endpoint ${new URL(exchange.url).origin} is outside the pin`);
        return dispatch(exchange);
      },
      credentials,
    );
    if ((await this.ctx.storage.get<number>("revision")) !== started)
      throw new Error(
        "the secret was changed while the provider was answering — the tokens were discarded; begin again",
      );
    await this.write(record);
    const revision = await this.ctx.storage.get<number>("revision");
    await this.ctx.storage.put("completed", { nonce: input.nonce, revision });
    return { urls: record.urls, refresh: record.refresh?.kind, exchanged: true };
  }

  /** Substitute, pin, dispatch — refresh and retry once on a mintable miss or a 401. A refusal is
   *  a 502 to the caller with the reason (never the destination, never the value). Every dispatch
   *  is a `secret/used` fact on this path — the request AS RECEIVED (its placeholders, never a
   *  value) and the upstream's status — appended off the response path. A WebSocket upgrade is a
   *  dispatch like any other: the 101 and its socket go straight back. */
  override async fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    // A borrower's use, admitted by this context (iterate-context-durable-object.ts `#lentFetch`,
    // the one sender: every egress strips `x-itx-lend*`): its placeholders spell the borrower's path
    // `as`, which this facet answers for as its own, and `secret/used` names the borrower.
    const lentAs = headers.get(LENT_AS_HEADER);
    headers.delete(LENT_AS_HEADER);
    if (lentAs)
      return this.#serve(
        new Request(request, { headers }),
        JSON.parse(lentAs) as { as: string; borrower: string },
      );
    const borrowed = await this.ctx.storage.get<Borrowed>("borrowed");
    if (!borrowed) return this.#serve(request, null);
    // The lender's context over FETCH, never a Workers-RPC method call: a 101's socket crosses a
    // fetch channel only. The lend rides signed (secrets.ts `LEND_USE_HEADER`).
    headers.set(
      LEND_USE_HEADER,
      await signLendUse(
        {
          lender: borrowed.lender,
          lendId: borrowed.lendId,
          borrower: DurableObjectNameCodec.parse(this.#address().context).projectId,
        },
        await sessionSigningSecretOf(appConfigOf(this.env)),
      ),
    );
    return this.env.ITERATE_CONTEXT.getByName(borrowed.lender).fetch(
      new Request(request, { headers }),
    );
  }

  /** The dispatch itself, for this secret's own path — or, for a lend, the borrower's path `as` too. */
  async #serve(request: Request, lent: { as: string; borrower: string } | null): Promise<Response> {
    const { path } = this.#address();
    // The record AS OF NOW, its pin checked against THIS request every time it is read — after a
    // refresh (or a write that won the revision fence) the pin may have moved, and the retried
    // request must honour the pin the new material was set with.
    const read = async () => {
      const stored = await this.ctx.storage.get<Stored>("stored");
      if (!stored) return null;
      if (!originPinned(request.url, stored.record.urls))
        throw pinRefusal(path, request.url, stored.record.urls);
      return { revision: stored.revision, record: await this.#opened(stored) };
    };
    const used = (response: Response): Response => {
      this.ctx.waitUntil(
        this.#fact({
          type: "events.iterate.com/secret/used",
          payload: {
            method: request.method,
            url: request.url,
            status: response.status,
            ...(lent && { borrower: lent.borrower }),
          },
        }),
      );
      return response;
    };
    // The Discord shape (secrets.ts `SECRET_FRAMES_HEADER`): the upgrade names this secret for its
    // frames, and this facet proxies the socket to substitute them.
    const framesFor = request.headers.get(SECRET_FRAMES_HEADER);
    if (framesFor) {
      const headers = new Headers(request.headers);
      headers.delete(SECRET_FRAMES_HEADER);
      request = new Request(request, { headers });
    }
    try {
      if (
        framesFor &&
        (request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
          !secretPathsIn(framesFor).some((named) => named === path || named === lent?.as))
      )
        throw new SecretRefused(
          `itx.fetch: ${SECRET_FRAMES_HEADER} names this secret on a WebSocket upgrade only`,
        );
      let stored = await read();
      // This facet answers for ONE secret: a placeholder naming another is refused here, not only
      // at the egress that routed the request (the facet is the boundary that holds the bytes).
      const resolve = (named: string) => {
        if (named !== path && named !== lent?.as)
          throw new SecretRefused(
            `itx.fetch: getSecret(${JSON.stringify(named)}) does not belong to the secret ${path}`,
          );
        return stored?.record.material ?? null;
      };
      // A refresh-and-retry needs the request twice; clone while it is undisturbed. (The cast is
      // workers-types' Request<Cf> vs the bare Request the pure half takes.)
      let retry: Request | null = stored?.record.refresh
        ? (request.clone() as unknown as Request)
        : null;
      let substituted: Request;
      try {
        substituted = await substituteProjectSecrets(request, resolve);
      } catch (error) {
        // No accessToken yet with a strategy configured: mint first (the first-use case), then go.
        if (!(error instanceof SecretRefused) || !retry || !error.mintable || !stored) throw error;
        try {
          await this.#refresh(stored.revision);
        } catch (cause) {
          throw new SecretRefused(
            `${error.message}; the refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
        stored = await read();
        substituted = await substituteProjectSecrets(retry, resolve);
        retry = null; // one refresh per request: a just-minted token gets no second go
      }
      // A socket whose frames name this secret is proxied, with the material as of its dial.
      const answer = (response: Response) =>
        used(
          framesFor && response.webSocket && stored
            ? proxyFrames(response, [path, ...(lent ? [lent.as] : [])], stored.record.material)
            : response,
        );
      const response = await dispatch(substituted);
      if (response.status !== 401 || !retry || !stored) return answer(response);
      try {
        await this.#refresh(stored.revision);
      } catch {
        // The provider (or the material) refused the refresh: the 401 is the caller's answer.
        return used(response);
      }
      await response.body?.cancel();
      stored = await read();
      return answer(await dispatch(await substituteProjectSecrets(retry, resolve)));
    } catch (error) {
      // A refusal is a 502 to the caller with the reason — never the destination, never the value.
      if (error instanceof SecretRefused)
        return new Response(`${error.message}\n`, { status: 502 });
      throw error;
    }
  }

  #refresh(revision: number): Promise<void> {
    const inFlight = this.#refreshing;
    if (inFlight?.revision === revision) return inFlight.promise;
    // A different revision is running (or none): run this one after it settles, never alongside.
    const previous = inFlight?.promise.catch(() => {}) ?? Promise.resolve();
    const promise = previous
      .then(() => this.#doRefresh(revision))
      .finally(() => {
        if (this.#refreshing?.promise === promise) this.#refreshing = undefined;
      });
    this.#refreshing = { revision, promise };
    return promise;
  }

  /** Run the strategy against the record AS READ NOW; commit only if nothing was written meanwhile
   *  (the revision fence) — a stale mint must never resurrect material a write replaced. The
   *  outcome, either way, is a fact on this path: `secret/refreshed { kind, ok, error? }`. */
  async #doRefresh(revision: number): Promise<void> {
    const stored = await this.ctx.storage.get<Stored>("stored");
    // A write landed first: whatever it stored (new material, or no strategy any more) is the
    // answer, and the caller re-reads it — so the fence comes before any look at the strategy.
    if (stored?.revision !== revision) return;
    const record = await this.#opened(stored);
    const { refresh, urls } = record;
    if (!refresh) throw new Error("no refresh strategy"); // unreachable: this revision was read with one
    // Refresh moves bytes only toward pinned hosts, like any use.
    const pinnedDispatch = (exchange: Request) => {
      if (!originPinned(exchange.url, urls))
        throw new Error(`the exchange endpoint ${new URL(exchange.url).origin} is outside the pin`);
      return dispatch(exchange);
    };
    let next: Record<string, unknown>;
    try {
      if (refresh.kind === "github-app-installation")
        next = {
          ...(isRecord(record.material) && record.material),
          accessToken: await this.#githubInstallationToken(refresh, record, pinnedDispatch),
        };
      else if (refresh.kind === "oauth-refresh-token" && refresh.client)
        next = await this.#platformRefresh(refresh, refresh.client, record, pinnedDispatch);
      else if (refresh.kind === "worker")
        // Exchange code runs in its jail (exchange-jail.ts), its egress the pin alone. The cast:
        // `ctx.exports` is typed from the generated worker types, which do not see the entrypoint
        // worker.ts exports; the SDK mints `ItxEntrypoint` from it the same way.
        next = await runExchangeCode({
          loader: this.env.LOADER,
          pinnedOutbound: (
            this.ctx.exports as unknown as {
              PinnedOutbound: (options: { props: { urls: string[] } }) => Fetcher;
            }
          ).PinnedOutbound({ props: { urls } }),
          deployId: appConfigOf(this.env).deployId,
          context: this.#address().context,
          urls,
          source: refresh.source,
          material: record.material,
        });
      else next = await refreshSecretMaterial(refresh, record.material, pinnedDispatch);
    } catch (error) {
      await this.#fact({
        type: "events.iterate.com/secret/refreshed",
        payload: {
          kind: refresh.kind,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
    const current = await this.ctx.storage.get<Stored>("stored");
    if (current?.revision !== revision) return;
    await this.ctx.storage.put<Stored>(
      "stored",
      await this.#sealed({ ...record, material: next }, revision),
    );
    await this.#fact({
      type: "events.iterate.com/secret/refreshed",
      payload: { kind: refresh.kind, ok: true },
    });
  }

  /** The refresh grant with the deployment's client (`oauth-refresh-token` + `client`): its
   *  credentials attached here, toward its own provider only (`#oauthClientOf`). */
  async #platformRefresh(
    refresh: Extract<SecretRefresh, { kind: "oauth-refresh-token" }>,
    client: { platform: OAuthPlatform },
    record: SecretRecord,
    pinnedDispatch: (request: Request) => Promise<Response>,
  ): Promise<Record<string, unknown>> {
    const material = isRecord(record.material) ? record.material : {};
    if (typeof material.refreshToken !== "string" || !material.refreshToken)
      throw new Error(`${refresh.kind}: the secret's material has no "refreshToken"`);
    const credentials = await this.#oauthClientOf({
      client,
      clientId: "",
      clientSecret: "",
      tokenEndpoint: refresh.tokenEndpoint,
    });
    const response = await pinnedDispatch(
      oauthTokenRequest({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        tokenEndpoint: refresh.tokenEndpoint,
        clientAuth: refresh.clientAuth || "client_secret_basic",
        params: { grant_type: "refresh_token", refresh_token: material.refreshToken },
      }),
    );
    // A provider may rotate the refresh token on use; keep the newest.
    return { ...material, ...(await oauthTokensOf(response, refresh.kind)) };
  }

  /** A GitHub App installation's token: an App JWT (@octokit/auth-app) traded at the
   *  installation's `access_tokens`. The project's own App signs with the `appId` and `privateKey`
   *  this secret's material holds. The deployment's App signs with APP_CONFIG's key, at its own
   *  GitHub only, and only for an installation the control plane routes to THIS project — so no
   *  project mints for an installation another project connected. */
  async #githubInstallationToken(
    refresh: Extract<SecretRefresh, { kind: "github-app-installation" }>,
    record: SecretRecord,
    pinnedDispatch: (request: Request) => Promise<Response>,
  ): Promise<string> {
    let app: { appId: string; privateKey: string };
    if ("project" in refresh.client) {
      const material = isRecord(record.material) ? record.material : {};
      if (typeof material.appId !== "string" || typeof material.privateKey !== "string")
        throw new Error(`${refresh.kind}: the secret's material holds no "appId" and "privateKey"`);
      app = { appId: material.appId, privateKey: material.privateKey };
    } else {
      const github = appConfigOf(this.env).integrations.github;
      if (!github)
        throw new Error(
          "this deployment has no GitHub App (APP_CONFIG integrations.github is unset)",
        );
      if (refresh.apiOrigin !== githubApiOriginOf(github.githubOrigin))
        throw new Error(
          `the platform's GitHub App answers at ${githubApiOriginOf(github.githubOrigin)}`,
        );
      const { projectId } = DurableObjectNameCodec.parse(this.#address().context);
      const route = await new ControlPlane(this.env).integrationRouteOf(
        "github",
        refresh.installationId,
      );
      if (route?.projectId !== projectId)
        throw new Error(
          `GitHub installation ${refresh.installationId} is not connected to this project`,
        );
      app = { appId: github.appId, privateKey: github.privateKey.exposeSecret() };
    }
    // GitHub hands out PKCS#1 keys; @octokit/auth-app signs with WebCrypto here, which takes PKCS#8
    const privateKey = createPrivateKey(app.privateKey).export({ type: "pkcs8", format: "pem" });
    const { token: jwt } = await createAppAuth({
      appId: app.appId,
      privateKey: String(privateKey),
    })({
      type: "app",
    });
    const response = await pinnedDispatch(
      new Request(
        `${refresh.apiOrigin}/app/installations/${encodeURIComponent(refresh.installationId)}/access_tokens`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${jwt}`,
            "user-agent": "iterate",
          },
        },
      ),
    );
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(data) || typeof data.token !== "string" || !data.token)
      throw new Error(`${refresh.kind}: GitHub answered ${response.status} with no token`);
    return data.token;
  }

  /** A fact about this secret onto its own log — a use, a refresh's outcome — the platform's own
   *  append through this facet's loopback (no principal). Best-effort: what it records already
   *  happened, and a lost fact must not fail the request that caused it. */
  async #fact(event: EventInput<typeof SecretContract>): Promise<void> {
    try {
      await this.withItx((itx) => itx.append(event));
    } catch (error) {
      reportIssue("secret.fact-append-failed", error, { type: event.type });
    }
  }
}

/** THE FRAME PROXY: the upstream's 101 held HERE, and a new socket handed to the caller — every
 *  client→server text frame with this secret's placeholders substituted (secrets.ts
 *  `substituteSecretInFrame`), everything else relayed as is, and each side's close the other's. A
 *  frame naming another secret closes both, 1008. The socket pins this facet (and so its context)
 *  for as long as it is open — as a passed-through 101 already does — plus the frame pump's CPU. */
function proxyFrames(upstream: Response, paths: string[], material: SecretMaterial): Response {
  const outbound = upstream.webSocket!;
  const [caller, inbound] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  outbound.accept();
  inbound.accept();
  const closeBoth = (code: number, reason: string) => {
    for (const socket of [inbound, outbound])
      try {
        socket.close(code, reason);
      } catch {
        // already closed
      }
  };
  inbound.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return outbound.send(event.data);
    try {
      outbound.send(substituteSecretInFrame(event.data, paths, material));
    } catch (error) {
      closeBoth(1008, error instanceof SecretRefused ? error.message.slice(0, 120) : "refused");
    }
  });
  outbound.addEventListener("message", (event) => inbound.send(event.data));
  // 1005 (no code) and 1006 (abnormal) are never sent on the wire: relayed as no code, and as a
  // going-away.
  const relayClose = (to: WebSocket) => (event: CloseEvent) => {
    try {
      if (event.code === 1005) to.close();
      else to.close(event.code === 1006 ? 1001 : event.code, event.reason);
    } catch {
      // already closed
    }
  };
  inbound.addEventListener("close", relayClose(outbound));
  outbound.addEventListener("close", relayClose(inbound));
  inbound.addEventListener("error", () => closeBoth(1011, "caller socket error"));
  outbound.addEventListener("error", () => closeBoth(1011, "upstream socket error"));
  const protocol = upstream.headers.get("sec-websocket-protocol");
  return new Response(null, {
    status: 101,
    webSocket: caller,
    headers: protocol ? { "sec-websocket-protocol": protocol } : {},
  });
}

/** The terminal fetch. A substituted secret follows NO redirect: a 3xx to another origin would carry
 *  the credential there (the Fetch standard strips `Authorization` on a cross-origin redirect, not
 *  other headers) — the caller sees the 3xx. A network failure is answered generically: the runtime's
 *  own error quotes the request URL, which may by now carry the substituted secret. */
const dispatch = async (request: Request): Promise<Response> => {
  try {
    return await fetch(request, { redirect: "manual" });
  } catch {
    throw new SecretRefused(
      `itx.fetch: the pinned host ${new URL(request.url).origin} could not be reached`,
    );
  }
};
