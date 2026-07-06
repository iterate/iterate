import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import type {
  DynamicWorkerRef,
  SecretComputeHmacInput,
  SecretDescription,
  SecretUpdateInput,
} from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { parseConfig } from "../../config.ts";
import { loadResolvedWorker, resolveWorkerSource } from "../workers/worker-loader.ts";
import { decryptSecretMaterial, encryptSecretMaterial } from "./crypto.ts";
import { isPlatformSecretPath, resolvePlatformSecretReference } from "./platform-secrets.ts";
import { secretWorkerBinding } from "./secret-entrypoint.ts";
import { SecretProcessorContract } from "./secret-processor-contract.ts";
import { SecretProcessor } from "./secret-processor-implementation.ts";
import {
  computeHmacHex,
  type ResolvedFields,
  secretErrorResponse,
  secretReferencesFromHeaders,
  selectSecretField,
  substituteSecretHeaders,
  SecretSubstitutionError,
  timingSafeStringEqual,
} from "./utils.ts";

type SecretState = InstanceType<typeof SecretProcessor>["state"];

export class SecretDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  });
  readonly #secretProcessor = this.#processorHost.add((deps) => new SecretProcessor(deps));

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#secretProcessor, {
      catchUpBeforeSnapshot: () => this.#processorHost.catchUp(SecretProcessorContract.slug),
      // Secret material is write-only: the live state that leaves this DO is
      // the DESCRIPTION — snapshots and onStateChange pushes must never carry
      // the ciphertext, only the hasMaterial fact.
      publicState: describeSecretState,
    });
  }

  async update(input: SecretUpdateInput) {
    if (input.material === undefined && input.egress === undefined && input.worker === undefined) {
      throw new Error("secret.update requires material, egress, or worker");
    }
    if (input.worker != null && input.worker.type !== "stateless") {
      // Secret workers are stateless dynamic workers — the Secret DO owns all
      // durability (design §2.2). A stateful ref has nowhere to live here.
      throw new Error("secret worker must be a stateless dynamic worker");
    }

    const current = (await this.#secretProcessor.snapshot()).state;
    if (
      input.egress !== undefined &&
      input.material === undefined &&
      current.encryptedMaterial === null
    ) {
      throw new Error("secret.update with egress requires existing material");
    }

    const [event] = await this.#processorHost.stream.append({
      type: "events.iterate.com/secret/updated",
      payload: {
        ...(input.egress === undefined ? {} : { egress: normalizeEgress(input.egress) }),
        ...(input.material === undefined
          ? {}
          : {
              // Material is any serializable value, encrypted as one JSON blob.
              // The DO owns the JSON boundary so crypto.ts stays string-based
              // and every legacy string caller keeps round-tripping.
              encryptedMaterial: await encryptSecretMaterial(
                JSON.stringify(input.material),
                this.env.SECRET_ENCRYPTION_KEY,
              ),
            }),
        ...(input.worker === undefined ? {} : { worker: input.worker }),
      },
    });
    return event!;
  }

  async describe(): Promise<SecretDescription> {
    // update() appends to the stream and the processor folds it in
    // asynchronously; pull-through makes update() -> describe()
    // read-your-writes even when the configured subscription's wake is slow
    // or was dropped.
    return describeSecretState(await this.#snapshot());
  }

  /**
   * Audited platform reveal: the ONE lane where material leaves this Durable
   * Object as bytes rather than by substitution — for credentials that must
   * exist outside a fetch header (the exemplar: GH_TOKEN in a sandbox
   * container's environment, where `gh` and `git` do their own TLS and no
   * egress hop exists to substitute at).
   *
   * Deliberately NOT on the public Secret capability (rpc-targets.ts): agents
   * and project scripts can never call it. It is reachable only through the
   * raw env.SECRET namespace stubs that platform code holds.
   */
  async revealForPlatformUse(input: { usedBy: string }): Promise<string> {
    const material = await this.#readMaterial({ requireEgress: true });
    await this.#appendUsed(input.usedBy);
    return selectSecretField(material);
  }

  /**
   * The worker's own material, for a secret worker inside the jail (design
   * §2.2). Reachable only through the SECRET namespace stub / the SecretEntrypoint
   * binding, never the public capability. Reading is fine: the jail's network
   * reach is the secret's pinned hosts, so the bytes cannot leave (ADR 0005).
   */
  read(): Promise<unknown> {
    return this.#readMaterial();
  }

  /**
   * Keyed HMAC over caller-supplied bytes, hex-encoded — the webhook
   * verification primitive (GitHub `sha256=`, Slack `v0=`, Stripe, …). It
   * attenuates "the signing key" to "answers computed under the key": a MAC
   * cannot be inverted, so this is safe to expose on the public Secret
   * capability. See design §2.1.
   */
  async hmac(input: SecretComputeHmacInput): Promise<string> {
    return await computeHmacHex({
      algo: input.algo,
      key: selectSecretField(await this.#readMaterial(), input.field),
      payload: input.payload,
    });
  }

  /** Constant-time equality of a caller value against a field (a URL-embedded
   * verification token, say) — the other half of verification-without-reveal. */
  async matches(input: { field?: string; value: string }): Promise<boolean> {
    return timingSafeStringEqual(
      selectSecretField(await this.#readMaterial(), input.field),
      input.value,
    );
  }

  /**
   * Resolve this secret's own placeholders for a chained egress request, on
   * behalf of the entry secret that holds the request. Platform-only (reachable
   * through the SECRET namespace stub, never the public capability). Enforces
   * THIS secret's host pin against the terminal destination — so a secret's
   * bytes only ever go to a host it trusts, however the chain was assembled —
   * and records the use.
   */
  async resolveSecretReference(input: {
    fields: string[];
    /** The full terminal request URL: its origin is pin-checked, and the whole
     * URL (path included) is recorded on the audit trail as lastUsedUrl. */
    url: string;
    usedBy: string;
  }): Promise<ResolvedFields> {
    const material = await this.#readMaterial({
      origin: new URL(input.url).origin,
      requireEgress: true,
    });
    const resolved: ResolvedFields = {};
    for (const field of input.fields) {
      resolved[field] = selectSecretField(material, field === "" ? undefined : field);
    }
    await this.#appendUsed(input.usedBy, input.url);
    return resolved;
  }

  /**
   * The public entry: a secret worker (if installed) overrides fetch, otherwise
   * the default substituting egress runs (design §2.2). The dispatcher requires
   * a placeholder in the no-worker case — that IS how you "use" a plain secret.
   */
  async fetch(request: Request): Promise<Response> {
    const worker = (await this.#snapshot()).worker;
    if (worker === null) return await this.#egressFetch(request, { requirePlaceholder: true });
    return await this.#runWorker(worker, request);
  }

  /**
   * The default secret behaviour, exposed to the secret worker as both
   * `env.SECRET.fetch` and its jail `globalOutbound` (see SecretEntrypoint):
   * substitute header placeholders and perform the terminal fetch. Unlike the
   * public `fetch`, a placeholder is not required — a worker that holds its own
   * bytes (Discord's frame token) still reaches its pinned hosts through here.
   */
  defaultFetch(request: Request): Promise<Response> {
    return this.#egressFetch(request, { requirePlaceholder: false });
  }

  /**
   * Load and invoke the secret worker. Jailed exactly like every other dynamic
   * worker (WorkerLoader), but with two swapped constructor arguments: the
   * `env.SECRET` binding and the `globalOutbound` are one SecretEntrypoint stub
   * pinned to this secret — so the isolate's only network reach is this
   * secret's hosts and every call substitutes placeholders in trusted DO code
   * (design §2.2, ADR 0005). Loaded on demand; eviction just reloads.
   */
  async #runWorker(worker: DynamicWorkerRef, request: Request): Promise<Response> {
    if (worker.type !== "stateless") {
      throw new Error("secret worker must be a stateless dynamic worker");
    }
    const binding = secretWorkerBinding(this.ctx.exports, {
      path: this.#name.path,
      projectId: this.#name.projectId,
    });
    const resolved = await resolveWorkerSource({
      projectId: this.#name.projectId,
      source: worker.source,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
    const stub = loadResolvedWorker({
      bindings: { SECRET: binding },
      globalOutbound: binding,
      projectId: this.#name.projectId,
      ref: worker,
      resolved,
      scopePath: this.#name.path,
    });
    const entrypoint = stub.getEntrypoint(worker.entrypoint, {
      props: worker.props ?? {},
    }) as { fetch(request: Request): Promise<Response> };
    return await entrypoint.fetch(request);
  }

  async #egressFetch(
    request: Request,
    { requirePlaceholder }: { requirePlaceholder: boolean },
  ): Promise<Response> {
    let references;
    try {
      references = secretReferencesFromHeaders(request.headers);
    } catch {
      return secretErrorResponse("secret_reference_required", 400);
    }
    if (requirePlaceholder && references.length === 0) {
      return secretErrorResponse("secret_reference_required", 400);
    }

    const origin = new URL(request.url).origin;
    try {
      const state = await this.#snapshot();
      // This secret owns the outbound: the destination must be pinned here even
      // when every placeholder is for another (app-tier) secret.
      if (!state.egress.urls.some((url) => new URL(url).origin === origin)) {
        throw new SecretSubstitutionError("secret_not_allowed_for_origin");
      }

      // Group the requested fields by the secret that owns them (fields are
      // already unique per header — secretReferencesFromHeaders dedupes).
      const fieldsByPath = new Map<string, string[]>();
      for (const reference of references) {
        const fields = fieldsByPath.get(reference.path) ?? [];
        fields.push(reference.field ?? "");
        fieldsByPath.set(reference.path, fields);
      }

      // Each referenced secret resolves its own fields and records the use:
      // this secret inline (a same-DO method call), a virtual platform secret
      // from config (§4), or another secret's DO — one mechanism, and every
      // hop substitutes in trusted DO code, never in the jail (ADR 0005).
      const values = new Map<string, string>();
      for (const [path, fields] of fieldsByPath) {
        const resolved = isPlatformSecretPath(path)
          ? resolvePlatformSecretReference({ config: parseConfig(this.env), fields, path })
          : path === this.#name.path
            ? await this.resolveSecretReference({
                fields,
                url: request.url,
                usedBy: this.#name.projectId,
              })
            : await this.env.SECRET.getByName(
                DurableObjectNameCodec.stringify({ path, projectId: this.#name.projectId }),
              ).resolveSecretReference({ fields, url: request.url, usedBy: this.#name.projectId });
        for (const [field, value] of Object.entries(resolved))
          values.set(`${path} ${field}`, value);
      }

      const substituted = substituteSecretHeaders(request, (reference) => {
        const value = values.get(`${reference.path} ${reference.field ?? ""}`);
        if (value === undefined)
          throw new SecretSubstitutionError("secret_reference_field_not_found");
        return value;
      });
      return await fetch(substituted);
    } catch (error) {
      if (error instanceof SecretSubstitutionError) {
        return secretErrorResponse(
          error.code,
          error.code === "secret_not_allowed_for_origin" ? 403 : 400,
        );
      }
      throw error;
    }
  }

  async #snapshot(): Promise<SecretState> {
    await this.#processorHost.catchUp(SecretProcessorContract.slug);
    return (await this.#secretProcessor.snapshot()).state;
  }

  async #readMaterial(opts: { origin?: string; requireEgress?: boolean } = {}): Promise<unknown> {
    const state = await this.#snapshot();
    if (state.encryptedMaterial === null) throw new SecretSubstitutionError("secret_not_found");
    if (opts.requireEgress && state.egress.urls.length === 0) {
      throw new SecretSubstitutionError("secret_not_allowed_for_origin");
    }
    if (
      opts.origin !== undefined &&
      !state.egress.urls.some((url) => new URL(url).origin === opts.origin)
    ) {
      throw new SecretSubstitutionError("secret_not_allowed_for_origin");
    }
    return await this.#decrypt(state.encryptedMaterial);
  }

  async #decrypt(encrypted: NonNullable<SecretState["encryptedMaterial"]>): Promise<unknown> {
    return JSON.parse(await decryptSecretMaterial(encrypted, this.env.SECRET_ENCRYPTION_KEY));
  }

  #appendUsed(usedBy: string, url?: string): Promise<unknown> {
    return this.#processorHost.stream.append({
      type: "events.iterate.com/secret/used",
      payload: { usedAt: new Date().toISOString(), usedBy, ...(url === undefined ? {} : { url }) },
    });
  }
}

function normalizeEgress(egress: { urls: string[] }): { urls: string[] } {
  for (const url of egress.urls) new URL(url);
  return { urls: [...egress.urls] };
}

/**
 * The one projection from internal processor state to the public description.
 * Shared by describe() and the processor facade's publicState so the two can
 * never disagree about what leaves the DO.
 */
function describeSecretState(state: SecretState): SecretDescription {
  return {
    audit: state.audit,
    egress: state.egress,
    hasMaterial: state.encryptedMaterial !== null,
    hasWorker: state.worker !== null,
  };
}
