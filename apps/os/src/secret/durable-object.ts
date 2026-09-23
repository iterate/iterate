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
// it dials one and hands it back, so the socket lives as long as the dial does, as it did through the
// secret's former Durable Object (measured 2026-09-21, __workers-tests__/secret-facet-proxies-a-socket.test.ts:
// the frames round-trip; the facet's abort closes it, 1006).
//
// The verbs `itx.secrets` runs (context/built-ins.ts — ON THIS PATH, so the log's order is the
// storage's, and through the facet host's platform entry: a caller's itx expression reaches the reads
// alone, `publicMethods`): `write(record)` and `clear()` store and forget the value; the FACTS (`secret/set`,
// `secret/deleted`, on this path and cross-posted to the owner's root) are the built-in's, attributed
// to the caller — a facet's own appends speak for the project, so they are not made here.
// `beginOAuth` keeps the pending attempt and hands back the authorize URL; `completeOAuth` exchanges
// the code into the record (secret-oauth.ts). The two facts this facet appends itself, best-effort:
// `secret/used` per dispatch and `secret/refreshed` per refresh outcome. It hosts the secret processor
// (processor.ts): `snapshot()` says whether material was set and whether the secret was deleted, by
// the offsets of the facts that say so. Hosted from `ctx.exports` (first-party-facets.ts): ordinary
// bundled worker code with the worker's real env — the at-rest key and the signing secret among it.

import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/next/sdk";
import type { EventInput } from "iterate/next/stream/processor";
import { signClaims, verifyAdminSecret } from "iterate/next/principal";
import { codedError } from "iterate/next/lib";
import {
  appConfigOf,
  atRestKeysOf,
  sessionSigningSecretOf,
  type AppConfigEnv,
} from "../app-config.ts";
import { resourceScope } from "../context/paths.ts";
import { DurableObjectNameCodec, type ItxEntrypointScope } from "../iterate-context.ts";
import {
  decryptSecretMaterial,
  encryptSecretMaterial,
  type EncryptedMaterial,
  type MaterialKeys,
} from "../secret-at-rest.ts";
import {
  beginSecretOAuth,
  completeSecretOAuth,
  SECRET_OAUTH_CALLBACK_PATH,
  type NormalizedSecretOAuthOptions,
  type PendingSecretOAuth,
  type SecretOAuthState,
} from "../secret-oauth.ts";
import {
  originPinned,
  pinRefusal,
  ProjectSecretRefused,
  refreshSecretMaterial,
  substituteProjectSecrets,
  verifySecretHmac,
  type SecretHmacVerification,
  type SecretRecord,
} from "../secrets.ts";
import { SecretContract, type SecretState } from "./contract.ts";
import { SecretProcessor } from "./processor.ts";

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

export class SecretDurableObject extends StreamProcessorDurableObject<
  SecretState,
  { ITX?: ItxEntrypointService } & AppConfigEnv,
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
   *  (iterate-context.ts `resourceScope`): `/secrets/shop` for a project's `/secrets/shop` and for a
   *  user's `/users/<id>/secrets/shop` alike. */
  #address(): { context: string; path: string } {
    const context = this.ctx.props.iterateContextName;
    const { projectId, path } = DurableObjectNameCodec.parse(context);
    const { rootPath } = resourceScope(projectId, path);
    return { context, path: rootPath === "/" ? path : path.slice(rootPath.length) };
  }

  /** Replace the record whole — material always travels with its complete policy
   *  `update` rule), so a value never inherits a pin or a strategy it was not set with. The caller
   *  (`itx.secrets.set`) has appended the fact already; this is the value. */
  async write(record: SecretRecord): Promise<void> {
    const revision = await this.#bump();
    await this.ctx.storage.put<Stored>("stored", await this.#sealed(record, revision));
    // A write supersedes any OAuth attempt in flight: its callback must not overwrite this material.
    await this.ctx.storage.delete("pending");
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
      throw new ProjectSecretRefused(
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
  async clear(): Promise<void> {
    await this.#bump();
    await this.ctx.storage.delete(["stored", "pending", "completed"]);
  }
  /** THE VERIFY LANE (for webhooks): is `signature` the HMAC-SHA256
   *  of `payload` under this secret's material? The material is opened HERE and the answer is one
   *  bit — nothing comes out, and no request goes anywhere, so the pin is not consulted. The
   *  candidate arrives from an unauthenticated door (a webhook): a secret never set, or a material
   *  with no key at the field, answers false rather than describing itself; the comparison is
   *  constant-time. */
  async verifyHmac(input: SecretHmacVerification): Promise<boolean> {
    const stored = await this.ctx.storage.get<Stored>("stored");
    if (!stored) return false;
    const { material } = await this.#opened(stored);
    return verifySecretHmac(material, input);
  }

  /** OAUTH, step one: keep the pending attempt, hand back the authorize URL. The `state` is a
   *  platform-signed claim naming this context plus a nonce only this attempt knows; the redirect
   *  URI is the platform's one callback (secret-oauth.ts). A new attempt replaces an unfinished one;
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
      exp: Date.now() + 10 * 60_000,
    };
    const { pending, authorizationUrl } = await beginSecretOAuth(options, {
      redirectUri: `${platformOrigin}${SECRET_OAUTH_CALLBACK_PATH}`,
      state: await signClaims(state, await sessionSigningSecretOf(config)),
      nonce,
    });
    await this.#bump(); // a new attempt is a write: an exchange started before it will not land
    await this.ctx.storage.put<PendingSecretOAuth>("pending", pending);
    return { authorizationUrl };
  }

  /** OAUTH, step two (the callback, through `itx.secrets.completeOAuth` on this path): the code for
   *  the pending attempt the nonce names → the exchange → the record, as a write. A stale or foreign
   *  callback (a back button, an older authorize URL, a replay with a junk code) fails without
   *  touching the live attempt; the attempt is consumed only when its exchange succeeds. The
   *  exchange lands only if nothing else wrote this facet while the provider was answering: a write
   *  or a clear in that window wins and the tokens are discarded (from the fence to the completion
   *  mark only storage awaits follow, which the input gate holds together). Answers the pin the
   *  record was stored with — what the fact carries; never the material. IDEMPOTENT for the attempt
   *  it completed: the same callback again (a refreshed tab, or the built-in retrying after its fact
   *  append failed) runs no second exchange and answers the same pin, as long as the record is still
   *  the one this attempt wrote — so the log can always catch up with a live facet. `exchanged` says
   *  which happened: THIS call wrote the record (the caller may undo it if its fact append fails), or
   *  a replay found it. */
  async completeOAuth(input: {
    code: string;
    nonce: string;
  }): Promise<{ urls: string[]; exchanged: boolean }> {
    const completed = await this.ctx.storage.get<{ nonce: string; revision: number }>("completed");
    if (completed?.nonce === input.nonce) {
      const stored = await this.ctx.storage.get<Stored>("stored");
      if (stored?.revision === completed.revision)
        return { urls: stored.record.urls, exchanged: false };
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
    const record = await completeSecretOAuth(pending, input.code, (exchange) => {
      if (!originPinned(exchange.url, pending.options.urls))
        throw new Error(`the token endpoint ${new URL(exchange.url).origin} is outside the pin`);
      return dispatch(exchange);
    });
    if ((await this.ctx.storage.get<number>("revision")) !== started)
      throw new Error(
        "the secret was changed while the provider was answering — the tokens were discarded; begin again",
      );
    await this.write(record);
    const revision = await this.ctx.storage.get<number>("revision");
    await this.ctx.storage.put("completed", { nonce: input.nonce, revision });
    return { urls: record.urls, exchanged: true };
  }

  /** Substitute, pin, dispatch — refresh and retry once on a mintable miss or a 401. A refusal is
   *  a 502 to the caller with the reason (never the destination, never the value). Every dispatch
   *  is a `secret/used` fact on this path — the request AS RECEIVED (its placeholders, never a
   *  value) and the upstream's status — appended off the response path. A WebSocket upgrade is a
   *  dispatch like any other: the 101 and its socket go straight back. */
  override async fetch(request: Request): Promise<Response> {
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
          payload: { method: request.method, url: request.url, status: response.status },
        }),
      );
      return response;
    };
    try {
      let stored = await read();
      // This facet answers for ONE secret: a placeholder naming another is refused here, not only
      // at the egress that routed the request (the facet is the boundary that holds the bytes).
      const resolve = (named: string) => {
        if (named !== path)
          throw new ProjectSecretRefused(
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
        if (!(error instanceof ProjectSecretRefused) || !retry || !error.mintable || !stored)
          throw error;
        try {
          await this.#refresh(stored.revision);
        } catch (cause) {
          throw new ProjectSecretRefused(
            `${error.message}; the refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
        stored = await read();
        substituted = await substituteProjectSecrets(retry, resolve);
        retry = null; // one refresh per request: a just-minted token gets no second go
      }
      const response = await dispatch(substituted);
      if (response.status !== 401 || !retry || !stored) return used(response);
      try {
        await this.#refresh(stored.revision);
      } catch {
        // The provider (or the material) refused the refresh: the 401 is the caller's answer.
        return used(response);
      }
      await response.body?.cancel();
      stored = await read();
      return used(await dispatch(await substituteProjectSecrets(retry, resolve)));
    } catch (error) {
      // A refusal is a 502 to the caller with the reason — never the destination, never the value.
      if (error instanceof ProjectSecretRefused)
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
    let next: Record<string, unknown>;
    try {
      next = await refreshSecretMaterial(refresh, record.material, (exchange) => {
        // Refresh moves bytes only toward pinned hosts, like any use.
        if (!originPinned(exchange.url, urls))
          throw new Error(
            `the exchange endpoint ${new URL(exchange.url).origin} is outside the pin`,
          );
        return dispatch(exchange);
      });
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

  /** A fact about this secret onto its own log — a use, a refresh's outcome — the platform's own
   *  append through this facet's loopback (no principal). Best-effort: what it records already
   *  happened, and a lost fact must not fail the request that caused it. */
  async #fact(event: EventInput<typeof SecretContract>): Promise<void> {
    try {
      await this.withItx((itx) => itx.append(event));
    } catch (error) {
      console.error("secret.fact_append_failed", { type: event.type, error: String(error) });
    }
  }
}

/** The terminal fetch. A substituted secret follows NO redirect: a 3xx to another origin would carry
 *  the credential there (the Fetch standard strips `Authorization` on a cross-origin redirect, not
 *  other headers) — the caller sees the 3xx. A network failure is answered generically: the runtime's
 *  own error quotes the request URL, which may by now carry the substituted secret. */
const dispatch = async (request: Request): Promise<Response> => {
  try {
    return await fetch(request, { redirect: "manual" });
  } catch {
    throw new ProjectSecretRefused(
      `itx.fetch: the pinned host ${new URL(request.url).origin} could not be reached`,
    );
  }
};
