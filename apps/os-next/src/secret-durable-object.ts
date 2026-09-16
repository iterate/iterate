// secret-durable-object.ts — a project secret's Durable Object: one per secret, named
// `<owner>:<name>`, holding one `SecretRecord` (secrets.ts) in its own storage. Its ONLY
// material-touching verb is `fetch`: a request that names this secret arrives from the context DO's
// egress (iterate-context-durable-object.ts `#egress`), the placeholders are substituted HERE, the
// pin checked, the request dispatched — and when the pinned host answers 401, or the material has
// no `accessToken` yet, the refresh strategy re-mints in this same trusted code and the request is
// retried ONCE. One object = one writer: a rotating refresh token is never raced by two contexts.
//
// The catalog (name, pin, strategy kind) is a fact on the owner's root log (`secrets/changed`);
// this object is the physical value — apps/os's Secret DO, minus its stream (the material sits in
// this object's storage, never on a log — ENCRYPTED at rest, secret-at-rest.ts: AES-256-GCM under
// the deployment's key, bound to this object, its pin and the write). Every dispatch through the
// material is a fact on the catalog too (`secrets/used`, the request as received — placeholders,
// never values). `beginOAuth` + `completeOAuth` are the OAuth first-token
// flow (secret-oauth.ts): the pending attempt lives here too, and the code exchange writes the
// record; the catalog fact is the root context's, appended by `itx.secrets.completeOAuth`
// (built-ins.ts) in the same per-name order as `set` and `delete`. A refresh's outcome is a fact
// this object appends itself (`secrets/refreshed`).

import { DurableObject } from "cloudflare:workers";
import { signClaims } from "iterate/next/principal";
import { appConfigOf, type AppConfigEnv } from "./app-config.ts";
import type { IterateContextDurableObject } from "./iterate-context-durable-object.ts";
import {
  decryptSecretMaterial,
  encryptSecretMaterial,
  type EncryptedMaterial,
  type MaterialKeys,
} from "./secret-at-rest.ts";
import {
  beginSecretOAuth,
  completeSecretOAuth,
  SECRET_OAUTH_CALLBACK_PATH,
  type NormalizedSecretOAuthOptions,
  type PendingSecretOAuth,
  type SecretOAuthState,
} from "./secret-oauth.ts";
import {
  originPinned,
  pinRefusal,
  ProjectSecretRefused,
  refreshSecretMaterial,
  substituteProjectSecrets,
  type SecretRecord,
} from "./secrets.ts";

/** What sits in storage. `stored` is the record with the revision it was written at — its material
 *  ENCRYPTED (secret-at-rest.ts), bound to this object, the pin and that revision; `revision` is
 *  THE WRITE COUNTER every change to this object bumps (`set`, `clear`, `beginOAuth`) — a refresh
 *  commits only against the revision it read, and a code exchange only against the counter it
 *  started at, so a `set` or `clear` racing either never has its outcome overwritten by a mint or an
 *  exchange from before it. The counter is never reset: a `clear` bumps it too, so a delete followed
 *  by a new `set` can never present the number a stale mint is waiting for. `pending` is the OAuth
 *  attempt in flight; `completed` the last one finished (its nonce and the revision it wrote), so its
 *  callback completes idempotently instead of exchanging twice.
 *  `catalog` is the owner's root context — the log the facts about this secret go to. */
type Stored = {
  record: Omit<SecretRecord, "material"> & { material: EncryptedMaterial };
  revision: number;
};

type Env = AppConfigEnv & { ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject> };

export class SecretDurableObject extends DurableObject<Env> {
  /** The one refresh in flight, keyed by the revision it read (single-flight: N callers who 401
   *  together on the same material share ONE mint). A caller holding a NEWER revision — a `set`
   *  landed while a mint for the old material was running, and the fence will drop that mint — is
   *  never coalesced onto it: its own mint queues behind the running one. */
  #refreshing: { revision: number; promise: Promise<void> } | undefined;

  /** Replace the record whole — material always travels with its complete policy (apps/os's
   *  `update` rule), so a value never inherits a pin or a strategy it was not set with. `catalog` is
   *  the owner's root context name, where this object appends its own facts. */
  async set(record: SecretRecord, catalog: string): Promise<number> {
    const revision = await this.#bump();
    await this.ctx.storage.put<Stored>("stored", await this.#sealed(record, revision));
    await this.ctx.storage.put("catalog", catalog);
    // A set supersedes any OAuth attempt in flight: its callback must not overwrite this material.
    await this.ctx.storage.delete("pending");
    return revision;
  }

  /** The record as storage holds it: the material encrypted under the deployment's key, bound to
   *  this object, the pin and the revision it is written at. */
  async #sealed(record: SecretRecord, revision: number): Promise<Stored> {
    const { owner, name } = this.#address();
    const material = await encryptSecretMaterial(
      record.material,
      { owner, name, urls: record.urls, revision },
      this.#keys(),
    );
    return { record: { ...record, material }, revision };
  }

  /** The stored record with its material in the clear, for this object's own use only. A record
   *  the previous key opened (a rotation in progress) is written back under the current key here,
   *  so a rotation completes one read at a time. A record neither key opens — one written before
   *  material was encrypted, under a key that is gone, or bound elsewhere — is a refusal that names
   *  the fix. */
  async #opened(stored: Stored): Promise<SecretRecord> {
    const { owner, name } = this.#address();
    const binding = { owner, name, urls: stored.record.urls, revision: stored.revision };
    let opened: Awaited<ReturnType<typeof decryptSecretMaterial>>;
    try {
      opened = await decryptSecretMaterial(stored.record.material, binding, this.#keys());
    } catch {
      throw new ProjectSecretRefused(
        `itx.fetch: the stored material of ${name} cannot be opened (a record from before encryption at rest, a rotated key, or another object's) — set the secret again`,
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
    const config = appConfigOf(this.env);
    return {
      current: config.secretsKey.exposeSecret(),
      previous: config.secretsKeyPrevious.exposeSecret() || undefined,
    };
  }

  /** The write counter, bumped: the number the write that follows is fenced by. */
  async #bump(): Promise<number> {
    const revision = ((await this.ctx.storage.get<number>("revision")) ?? 0) + 1;
    await this.ctx.storage.put("revision", revision);
    return revision;
  }

  /** Forget the record and any attempt — a write like any other (the counter moves on, so a mint or
   *  an exchange started before the clear cannot land after it, even under a new `set`). */
  async clear(): Promise<void> {
    await this.#bump();
    await this.ctx.storage.delete(["stored", "pending", "completed"]);
  }

  /** OAUTH, step one: keep the pending attempt, hand back the authorize URL. The `state` is a
   *  platform-signed claim naming this secret plus a nonce only this attempt knows; the redirect URI
   *  is the platform's one callback (secret-oauth.ts). A new attempt replaces an unfinished one; the
   *  record, if any, stays until the exchange writes over it. Nothing lands on the catalog until the
   *  exchange succeeds — an abandoned attempt leaves no trace. */
  async beginOAuth(
    options: NormalizedSecretOAuthOptions,
    catalog: string,
  ): Promise<{ authorizationUrl: string }> {
    const config = appConfigOf(this.env);
    const { owner, name } = this.#address();
    const nonce = crypto.randomUUID();
    const state: SecretOAuthState = {
      kind: "secret-oauth",
      owner,
      name,
      nonce,
      exp: Date.now() + 10 * 60_000,
    };
    const { pending, authorizationUrl } = await beginSecretOAuth(options, {
      redirectUri: `${config.platformOrigin}${SECRET_OAUTH_CALLBACK_PATH}`,
      state: await signClaims(state, config.sessionSecret.exposeSecret()),
      nonce,
    });
    await this.#bump(); // a new attempt is a write: an exchange started before it will not land
    await this.ctx.storage.put<PendingSecretOAuth>("pending", pending);
    await this.ctx.storage.put("catalog", catalog);
    return { authorizationUrl };
  }

  /** OAUTH, step two (the callback, through `itx.secrets.completeOAuth` on the owner's root
   *  context): the code for the pending attempt the nonce names → the exchange → the record, as a
   *  `set`. A stale or foreign callback (a back button, an older authorize URL, a replay with a junk
   *  code) fails without touching the live attempt; the attempt is consumed only when its exchange
   *  succeeds. The exchange lands only if nothing else wrote this object while the provider was
   *  answering: a `set` or `clear` in that window wins and the tokens are discarded (from the fence
   *  to the completion mark only storage awaits follow, which the input gate holds together).
   *  Answers the pin the record was stored with — what the catalog fact carries; never the
   *  material. IDEMPOTENT for the attempt it completed: the same callback again (a refreshed tab,
   *  or the root context retrying after its catalog append failed) runs no second exchange and
   *  answers the same pin, as long as the record is still the one this attempt wrote — so the
   *  catalog can always catch up with a live object. `exchanged` says which happened: THIS call
   *  wrote the record (the caller may undo it if its catalog write fails), or a replay found it. */
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
    const revision = await this.set(record, (await this.ctx.storage.get<string>("catalog")) ?? "");
    await this.ctx.storage.put("completed", { nonce: input.nonce, revision });
    return { urls: record.urls, exchanged: true };
  }

  /** Substitute, pin, dispatch — refresh and retry once on a mintable miss or a 401. A refusal is
   *  a 502 to the caller with the reason (never the destination, never the value). Every dispatch
   *  is a `secrets/used` fact on the catalog — the request AS RECEIVED (its placeholders, never a
   *  value) and the upstream's status — appended off the response path. A WebSocket upgrade is a
   *  dispatch like any other: the 101 and its socket go straight back. */
  override async fetch(request: Request): Promise<Response> {
    const { name } = this.#address();
    // The record AS OF NOW, its pin checked against THIS request every time it is read — after a
    // refresh (or a `set` that won the revision fence) the pin may have moved, and the retried
    // request must honour the pin the new material was set with.
    const read = async () => {
      const stored = await this.ctx.storage.get<Stored>("stored");
      if (!stored) return null;
      if (!originPinned(request.url, stored.record.urls))
        throw pinRefusal(name, request.url, stored.record.urls);
      return { revision: stored.revision, record: await this.#opened(stored) };
    };
    const used = (response: Response): Response => {
      this.ctx.waitUntil(
        this.#appendOutcome({
          type: "events.iterate.com/secrets/used",
          payload: { name, method: request.method, url: request.url, status: response.status },
        }),
      );
      return response;
    };
    try {
      let stored = await read();
      // This object answers for ONE secret: a placeholder naming another is refused here, not only
      // at the egress that routed the request (the object is the boundary that holds the bytes).
      const resolve = (named: string) => {
        if (named !== name)
          throw new ProjectSecretRefused(
            `itx.fetch: getSecret("/secrets/${named}") does not belong to the secret ${name}`,
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

  /** This object's name, `<owner>:<name>` — the left half is the RESOURCE OWNER's id
   *  (iterate-context.ts `resourceScope`: a project's id, or `global--users--<id>` /
   *  `global--organizations--<id>`), which never holds a `:`. */
  #address(): { owner: string; name: string } {
    const id = this.ctx.id.name ?? ":";
    const colon = id.indexOf(":");
    return { owner: id.slice(0, colon), name: id.slice(colon + 1) };
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

  /** Run the strategy against the record AS READ NOW; commit only if nothing was `set` meanwhile
   *  (the revision fence) — a stale mint must never resurrect material a set replaced. The outcome,
   *  either way, is a fact on the catalog: `secrets/refreshed { name, kind, ok, error? }`. */
  async #doRefresh(revision: number): Promise<void> {
    const stored = await this.ctx.storage.get<Stored>("stored");
    // A set landed first: whatever it stored (new material, or no strategy any more) is the answer,
    // and the caller re-reads it — so the fence comes before any look at the strategy.
    if (stored?.revision !== revision) return;
    const record = await this.#opened(stored);
    const { refresh, urls } = record;
    if (!refresh) throw new Error("no refresh strategy"); // unreachable: this revision was read with one
    const { name } = this.#address();
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
      await this.#appendOutcome({
        type: "events.iterate.com/secrets/refreshed",
        payload: {
          name,
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
    await this.#appendOutcome({
      type: "events.iterate.com/secrets/refreshed",
      payload: { name, kind: refresh.kind, ok: true },
    });
  }

  /** A fact about this secret onto the owner's root log — a refresh's outcome, a use — the
   *  platform's own append, no principal, through THE one write (`itx.builtins.append`,
   *  iterate-context.ts), which no context can mask. Best-effort: what it records already happened,
   *  and a lost fact must not fail the request that caused it. */
  async #appendOutcome(event: { type: string; payload: Record<string, unknown> }): Promise<void> {
    const catalog = await this.ctx.storage.get<string>("catalog");
    if (!catalog) return;
    try {
      await this.env.ITERATE_CONTEXT.getByName(catalog).invoke(
        ["itx", "builtins", ["append", event]],
        [],
        { principal: null },
      );
    } catch (error) {
      console.error("secrets.catalog_append_failed", { type: event.type, error: String(error) });
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
