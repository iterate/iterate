// secret-durable-object.ts — THE SECRET CELL's host: one Durable Object per project secret, named
// `<projectId>:<name>`, holding one `SecretRecord` (secrets.ts) in its own storage. Its ONLY
// material-touching verb is `fetch`: a request that names this secret arrives from the context DO's
// egress (iterate-context-durable-object.ts `#egress`), the placeholders are substituted HERE,
// the pin checked, the request dispatched — and when the pinned host answers 401, or the material
// has no `accessToken` yet, the refresh strategy re-mints in this same trusted code and the request
// is retried ONCE. One object = one writer: a rotating refresh token is never raced by two contexts.
//
// The catalog (name, pin, strategy kind) is a fact on the project's log (`secrets/changed`); this
// object is the physical value — apps/os's Secret DO, minus its stream (the material sits in this
// object's storage, never on a log).

import { DurableObject } from "cloudflare:workers";
import {
  originPinned,
  pinRefusal,
  ProjectSecretRefused,
  refreshSecretMaterial,
  substituteProjectSecrets,
  type SecretRecord,
} from "./secrets.ts";

/** What sits in storage: the record and a revision `set` bumps — a refresh commits only against the
 *  revision it read, so a `set` racing a refresh never has its new material overwritten by a mint
 *  from the old. */
type Stored = { record: SecretRecord; revision: number };

export class SecretDurableObject extends DurableObject {
  /** The one refresh in flight, keyed by the revision it read (single-flight: N callers who 401
   *  together on the same material share ONE mint). A caller holding a NEWER revision — a `set`
   *  landed while a mint for the old material was running, and the fence will drop that mint — is
   *  never coalesced onto it: its own mint queues behind the running one. */
  #refreshing: { revision: number; promise: Promise<void> } | undefined;

  /** Replace the record whole — material always travels with its complete policy (apps/os's
   *  `update` rule), so a value never inherits a pin or a strategy it was not set with. */
  async set(record: SecretRecord): Promise<void> {
    const current = await this.ctx.storage.get<Stored>("stored");
    await this.ctx.storage.put<Stored>("stored", {
      record,
      revision: (current?.revision ?? 0) + 1,
    });
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  /** THE CELL: substitute, pin, dispatch — refresh and retry once on a mintable miss or a 401. A
   *  refusal is a 502 to the caller with the reason (never the destination, never the value). */
  override async fetch(request: Request): Promise<Response> {
    const name = this.ctx.id.name?.slice(this.ctx.id.name.indexOf(":") + 1) ?? "?";
    // The record AS OF NOW, its pin checked against THIS request every time it is read — after a
    // refresh (or a `set` that won the revision fence) the pin may have moved, and the retried
    // request must honour the pin the new material was set with.
    const read = async () => {
      const stored = await this.ctx.storage.get<Stored>("stored");
      if (stored && !originPinned(request.url, stored.record.urls))
        throw pinRefusal(name, request.url, stored.record.urls);
      return stored;
    };
    try {
      let stored = await read();
      const resolve = () => stored?.record.material ?? null;
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
      if (response.status !== 401 || !retry || !stored) return response;
      try {
        await this.#refresh(stored.revision);
      } catch {
        // The provider (or the material) refused the refresh: the 401 is the caller's answer.
        return response;
      }
      await response.body?.cancel();
      stored = await read();
      return await dispatch(await substituteProjectSecrets(retry, resolve));
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

  /** Run the strategy against the record AS READ NOW; commit only if nothing was `set` meanwhile
   *  (the revision fence) — a stale mint must never resurrect material a set replaced. */
  async #doRefresh(revision: number): Promise<void> {
    const stored = await this.ctx.storage.get<Stored>("stored");
    // A set landed first: whatever it stored (new material, or no strategy any more) is the answer,
    // and the caller re-reads it — so the fence comes before any look at the strategy.
    if (stored?.revision !== revision) return;
    const { refresh, urls } = stored.record;
    if (!refresh) throw new Error("no refresh strategy"); // unreachable: this revision was read with one
    const next = await refreshSecretMaterial(refresh, stored.record.material, (exchange) => {
      // Refresh moves bytes only toward pinned hosts, like any use.
      if (!originPinned(exchange.url, urls))
        throw new Error(`the exchange endpoint ${new URL(exchange.url).origin} is outside the pin`);
      return dispatch(exchange);
    });
    const current = await this.ctx.storage.get<Stored>("stored");
    if (current?.revision !== revision) return;
    await this.ctx.storage.put<Stored>("stored", {
      ...current,
      record: { ...current.record, material: next },
    });
  }
}

/** The terminal fetch. A substituted secret follows NO redirect: a 3xx to another origin would carry
 *  the credential there (the Fetch standard strips `Authorization` on a cross-origin redirect, not
 *  other headers). WS-safe — only the URL and headers were rewritten, so a 101 flows straight back. */
const dispatch = (request: Request) => fetch(request, { redirect: "manual" });
