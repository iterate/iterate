import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { SecretUpdateInput } from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";

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
    return this.#stub.substituteFetch(request);
  }

  read(): Promise<unknown> {
    return this.#stub.read();
  }

  update(input: SecretUpdateInput): Promise<unknown> {
    return this.#stub.update(input);
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
