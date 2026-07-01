import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import type { SecretDescription, SecretUpdateInput } from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamProcessorRpcTarget } from "../streams/stream-processor.ts";
import { decryptSecretMaterial, encryptSecretMaterial } from "./crypto.ts";
import { SecretProcessor } from "./secret-processor-implementation.ts";
import { SecretProcessorContract } from "./secret-processor-contract.ts";
import {
  requestWithSecretHeaders,
  secretErrorResponse,
  secretReferencePathsFromHeaders,
} from "./utils.ts";

export class SecretDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  });
  readonly #secretProcessor = this.#processorHost.add(
    SecretProcessorContract.slug,
    (deps) => new SecretProcessor(deps),
  );

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#secretProcessor);
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
              encryptedMaterial: await encryptSecretMaterial(
                input.material,
                this.env.SECRET_ENCRYPTION_KEY,
              ),
            }),
      },
    });
    return event!;
  }

  async describe(): Promise<SecretDescription> {
    const { state } = await this.#secretProcessor.snapshot();
    return {
      audit: state.audit,
      egress: state.egress,
      hasMaterial: state.encryptedMaterial !== null,
    };
  }

  async fetch(request: Request): Promise<Response> {
    // TODO: support websocket upgrade requests here once egress substitution
    // needs non-HTTP fetches. Keeping this on fetch() preserves that path.
    const requestedPaths = secretReferencePathsFromHeaders(request.headers);
    if (requestedPaths.length > 1) {
      return secretErrorResponse("multiple_secret_paths_not_supported", 400);
    }
    if (requestedPaths.length !== 1 || requestedPaths[0] !== this.#name.path) {
      return secretErrorResponse("secret_reference_required", 400);
    }

    const { state } = await this.#secretProcessor.snapshot();
    if (state.encryptedMaterial === null) {
      return secretErrorResponse("secret_not_found", 404);
    }

    const origin = new URL(request.url).origin;
    if (!state.egress.urls.some((url) => new URL(url).origin === origin)) {
      return secretErrorResponse("secret_not_allowed_for_origin", 403);
    }

    const material = await decryptSecretMaterial(
      state.encryptedMaterial,
      this.env.SECRET_ENCRYPTION_KEY,
    );
    await this.#processorHost.stream.append({
      type: "events.iterate.com/secret/used",
      payload: {
        usedAt: new Date().toISOString(),
        usedBy: this.#name.projectId,
        url: request.url,
      },
    });
    return fetch(
      requestWithSecretHeaders({
        material,
        path: this.#name.path,
        request,
      }),
    );
  }
}

function normalizeEgress(egress: { urls: string[] }): { urls: string[] } {
  for (const url of egress.urls) new URL(url);
  return { urls: [...egress.urls] };
}
