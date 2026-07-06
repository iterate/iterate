import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import type { SecretComputeHmacInput, SecretDescription, SecretUpdateInput } from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { decryptSecretMaterial, encryptSecretMaterial } from "./crypto.ts";
import { SecretProcessorContract } from "./secret-processor-contract.ts";
import { SecretProcessor } from "./secret-processor-implementation.ts";
import {
  computeHmacHex,
  secretErrorResponse,
  secretReferencesFromHeaders,
  selectSecretField,
  substituteSecretHeaders,
  SecretSubstitutionError,
  timingSafeStringEqual,
} from "./utils.ts";

/**
 * Values one referenced secret owes a chained egress request: the substituted
 * string for each requested field. `field: undefined` (the whole-material
 * placeholder) is keyed by the empty string. See `resolveSecretReference`.
 */
type ResolvedFields = Record<string, string>;

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
    if (input.material === undefined && input.egress === undefined) {
      throw new Error("secret.update requires material or egress");
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
      },
    });
    return event!;
  }

  async describe(): Promise<SecretDescription> {
    // update() appends to the stream and the processor folds it in
    // asynchronously; pull-through makes update() -> describe()
    // read-your-writes even when the configured subscription's wake is slow
    // or was dropped.
    await this.#processorHost.catchUp(SecretProcessorContract.slug);
    const { state } = await this.#secretProcessor.snapshot();
    return describeSecretState(state);
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
   * raw env.SECRET namespace stubs that platform code holds. Every reveal
   * requires a live egress allowlist (disconnect empties it, killing reveals
   * and substitutions alike) and lands on the audit trail with `usedBy`.
   */
  async revealForPlatformUse(input: { usedBy: string }): Promise<string> {
    const material = await this.#readMaterial({ requireEgress: true });
    await this.#appendUsed(input.usedBy);
    // Historically material was a bare string; whole-material reveal keeps that
    // contract (JSON.stringify of a string is itself minus quotes on parse).
    return selectSecretField(material);
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
    origin: string;
    usedBy: string;
  }): Promise<ResolvedFields> {
    const material = await this.#readMaterial({ origin: input.origin, requireEgress: true });
    const resolved: ResolvedFields = {};
    for (const field of input.fields) {
      resolved[field] = selectSecretField(material, field === "" ? undefined : field);
    }
    await this.#appendUsed(input.usedBy, input.origin);
    return resolved;
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#defaultFetch(request);
  }

  /**
   * The default secret behaviour: substitute every header placeholder and
   * perform the terminal fetch. Placeholders may reference several secrets
   * (app-tier + connection-tier); each is resolved by its owner — this secret
   * inline, others by RPC to their DO — and each owner enforces its own pin
   * against the destination. Substitution happens here, in trusted DO code,
   * never in a jail (design §2.1–2.2). A secret worker (§2.2, added in S2)
   * overrides `fetch` and calls back into this via its bound outbound.
   *
   * TODO(S4): handle websocket upgrade requests here so frame-time credentials
   * (Discord) and relay handshakes (OpenAI) chain the same way.
   */
  async #defaultFetch(request: Request): Promise<Response> {
    let references;
    try {
      references = secretReferencesFromHeaders(request.headers);
    } catch {
      return secretErrorResponse("secret_reference_required", 400);
    }
    if (references.length === 0) return secretErrorResponse("secret_reference_required", 400);

    const origin = new URL(request.url).origin;
    // Group requested fields by referenced secret path; "" is the
    // whole-material placeholder.
    const fieldsByPath = new Map<string, Set<string>>();
    for (const reference of references) {
      const set = fieldsByPath.get(reference.path) ?? new Set<string>();
      set.add(reference.field ?? "");
      fieldsByPath.set(reference.path, set);
    }

    const values = new Map<string, string>();
    try {
      for (const [path, fields] of fieldsByPath) {
        const resolved =
          path === this.#name.path
            ? await this.resolveSecretReference({
                fields: [...fields],
                origin,
                usedBy: this.#name.projectId,
              })
            : await this.env.SECRET.getByName(
                DurableObjectNameCodec.stringify({ path, projectId: this.#name.projectId }),
              ).resolveSecretReference({
                fields: [...fields],
                origin,
                usedBy: this.#name.projectId,
              });
        for (const [field, value] of Object.entries(resolved))
          values.set(`${path} ${field}`, value);
      }
    } catch (error) {
      if (error instanceof SecretSubstitutionError) {
        return secretErrorResponse(
          error.code,
          error.code === "secret_not_allowed_for_origin" ? 403 : 400,
        );
      }
      throw error;
    }

    const substituted = substituteSecretHeaders(request, (reference) => {
      const value = values.get(`${reference.path} ${reference.field ?? ""}`);
      if (value === undefined)
        throw new SecretSubstitutionError("secret_reference_field_not_found");
      return value;
    });
    return fetch(substituted);
  }

  /** Decrypt + parse this secret's material, optionally asserting a live egress
   * allowlist and that a terminal origin is on it. Throws
   * SecretSubstitutionError so `#defaultFetch` can map failures to 4xx. */
  async #readMaterial(opts: { origin?: string; requireEgress?: boolean } = {}): Promise<unknown> {
    await this.#processorHost.catchUp(SecretProcessorContract.slug);
    const { state } = await this.#secretProcessor.snapshot();
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
    return JSON.parse(
      await decryptSecretMaterial(state.encryptedMaterial, this.env.SECRET_ENCRYPTION_KEY),
    );
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
function describeSecretState(
  state: InstanceType<typeof SecretProcessor>["state"],
): SecretDescription {
  return {
    audit: state.audit,
    egress: state.egress,
    hasMaterial: state.encryptedMaterial !== null,
  };
}
