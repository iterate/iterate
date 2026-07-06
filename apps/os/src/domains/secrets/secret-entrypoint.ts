import { WorkerEntrypoint } from "cloudflare:workers";
import { parseConfig } from "../../config.ts";
import type { Env } from "../../env.ts";
import type {
  SecretComputeHmacInput,
  SecretComputeSignInput,
  SecretUpdateInput,
} from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { isPlatformSecretPath, platformSecretMaterialField } from "./platform-secrets.ts";
import {
  computeHmacHex,
  computeSignatureBase64Url,
  timingSafeStringEqual,
  wrapSecretEgressRequest,
} from "./utils.ts";

/** Props identifying which secret a secret worker's `env.SECRET` is bound to.
 * Minted by the hosting Secret DO, never chosen by worker code. */
type SecretWorkerBindingProps = { path: string; projectId: string };

/**
 * The `env.SECRET` binding — and the jail's `globalOutbound` — handed to a
 * secret worker (design §2.2). All three surfaces route to the worker's OWN
 * Secret Durable Object:
 *
 * - `fetch(request)` — the default substituting egress: header placeholders
 *   resolved and the terminal fetch performed in trusted DO code, pinned to
 *   the secret's hosts. This is ALSO the worker's `globalOutbound`, so every
 *   network call the jailed isolate makes (including raw `fetch()`) flows
 *   through the same pinned, substituting door.
 * - `read()` — the worker reads its own material. Confinement is the host pin,
 *   not byte-hiding (ADR 0005): the isolate can only reach the secret's hosts.
 * - `update(input)` — write refreshed material back.
 *
 * Minted only by the Secret DO for code it hosts (via `ctx.exports`); it is
 * never on the public Secret capability, so agents and scripts cannot reach
 * `read()`/`update()`.
 */
export class SecretEntrypoint extends WorkerEntrypoint<Env, SecretWorkerBindingProps> {
  get #stub() {
    return this.env.SECRET.getByName(
      DurableObjectNameCodec.stringify({
        path: this.ctx.props.path,
        projectId: this.ctx.props.projectId,
      }),
    );
  }

  fetch(request: Request): Promise<Response> {
    // MUST be the DO's native fetch() (not an RPC method): only fetch can carry
    // a WebSocket upgrade + return a 101 + WebSocket, and an RPC return cannot
    // serialize a WebSocket. Wrap to the egress sentinel URL so the DO's fetch
    // routes this to substituting egress rather than re-running the worker.
    return this.#stub.fetch(wrapSecretEgressRequest(request));
  }

  read(): Promise<unknown> {
    return this.#stub.read();
  }

  update(input: SecretUpdateInput): Promise<unknown> {
    return this.#stub.update(input);
  }
}

/**
 * The optional `env.APP` binding handed to a secret worker: a **compute-only**
 * view of the integration's APP-TIER secret (design §2.3, ADR 0006). It exposes
 * only `sign`/`hmac`/`matches` — never `read`/`update`/`fetch` — so it returns
 * "answers computed under the key," never the key. That attenuation is what
 * makes it safe to bind even a PLATFORM-tier app secret (a GitHub App private
 * key): the platform bytes are used to sign inside the DO and never enter the
 * jail. The app secret may be a project secret (dial its DO) or a virtual
 * platform secret (compute from deployment config).
 *
 * The connection worker uses this ONLY for signing it cannot express as a
 * header placeholder (GitHub App JWTs); app-tier credentials that CAN ride a
 * header — a Basic client secret — stay `getSecret(appPath, ...)` placeholders
 * substituted at the jailed outbound, not `env.APP` calls.
 */
export class AppSecretEntrypoint extends WorkerEntrypoint<Env, SecretWorkerBindingProps> {
  get #platform(): boolean {
    return isPlatformSecretPath(this.ctx.props.path);
  }

  get #stub() {
    return this.env.SECRET.getByName(
      DurableObjectNameCodec.stringify({
        path: this.ctx.props.path,
        projectId: this.ctx.props.projectId,
      }),
    );
  }

  #platformField(field?: string): string {
    return platformSecretMaterialField(parseConfig(this.env), this.ctx.props.path, field);
  }

  async hmac(input: SecretComputeHmacInput): Promise<string> {
    if (!this.#platform) return await this.#stub.hmac(input);
    return await computeHmacHex({
      algo: input.algo,
      key: this.#platformField(input.field),
      payload: input.payload,
    });
  }

  async sign(input: SecretComputeSignInput): Promise<string> {
    if (!this.#platform) return await this.#stub.sign(input);
    return await computeSignatureBase64Url({
      algo: input.algo,
      payload: input.payload,
      privateKeyPem: this.#platformField(input.field),
    });
  }

  async matches(input: { field?: string; value: string }): Promise<boolean> {
    if (!this.#platform) return await this.#stub.matches(input);
    return timingSafeStringEqual(this.#platformField(input.field), input.value);
  }
}

/**
 * Narrow structural view of the `SecretEntrypoint` loopback export on
 * `ctx.exports` (mirrors `projectEgressFetcher`). Returns one stub used as both
 * `env.SECRET` and the jail `globalOutbound`.
 */
type SecretLoopbackExports = Record<
  "SecretEntrypoint",
  (options: { props: SecretWorkerBindingProps }) => Fetcher & {
    read(): Promise<unknown>;
    update(input: SecretUpdateInput): Promise<unknown>;
  }
>;

export function secretWorkerBinding(exports: unknown, props: SecretWorkerBindingProps) {
  return (exports as SecretLoopbackExports).SecretEntrypoint({ props });
}

/** The compute-only `env.APP` loopback (see {@link AppSecretEntrypoint}). */
type AppSecretLoopbackExports = Record<
  "AppSecretEntrypoint",
  (options: { props: SecretWorkerBindingProps }) => {
    hmac(input: SecretComputeHmacInput): Promise<string>;
    matches(input: { field?: string; value: string }): Promise<boolean>;
    sign(input: SecretComputeSignInput): Promise<string>;
  }
>;

export function appSecretBinding(exports: unknown, props: SecretWorkerBindingProps) {
  return (exports as AppSecretLoopbackExports).AppSecretEntrypoint({ props });
}
