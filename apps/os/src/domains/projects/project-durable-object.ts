import { DurableObject } from "cloudflare:workers";
import { trustedInternalAuthContext } from "../../auth.ts";
import { parseConfig } from "../../config.ts";
import { workerVersion, type Env } from "../../env.ts";
import {
  itxForScope,
  LiveStateRpcTarget,
  ProjectEgressInterceptRpcTarget,
  StreamProcessorRpcTarget,
  StreamRpcTarget,
} from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { createStreamProcessorHost } from "../streams/stream-processor-host.ts";
import type {
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "../streams/rpc-types.ts";
import { deepRetainRpcStubs } from "../capability-host/live-capability.ts";
import { substitutePlatformApiKeyReferences } from "../secrets/platform-secrets.ts";
import {
  platformReferencesFromHeaders,
  secretErrorResponse,
  secretReferencePathsFromRequest,
  SecretSubstitutionError,
} from "../secrets/utils.ts";
import { SlackProcessor } from "../integrations/slack-processor-implementation.ts";
import { eyesReactionTargetFromWebhookPayload } from "../integrations/slack-agent-processor-implementation.ts";
import { callProjectSlackWebApi } from "../integrations/slack-api.ts";
import { TelegramProcessor } from "../integrations/telegram-processor-implementation.ts";
import { connectionFromIntegrationStreamPath } from "../integrations/utils.ts";
import { EmailProcessor } from "../email/email-processor-implementation.ts";
import { EmailProcessorContract } from "../email/email-processor-contract.ts";
import type { ProjectEgressIntercept, ProjectEgressInterceptor } from "./egress.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";
import { StreamDatabase } from "./stream-database.ts";
import { createCloudflareProjectCustomDomainDeps } from "./custom-domains.ts";

export class ProjectDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  #egressInterceptor?: ReturnType<typeof deepRetainRpcStubs<ProjectEgressInterceptor>>;
  // Demo (stateful live state): a counter every watcher of `itx.live` sees
  // update, mutated by `itx.liveDemo.increment()`. Proves the DO-backed,
  // shared-engine case — and dogfoods the `getLiveState` fold the streams index
  // will use.
  #liveDemo: { count: number } = { count: 0 };
  // The project's streams index — a materialized view in the DO's own SQLite,
  // touched from the processEventBatch fan-in (see touchStreamActivity).
  readonly #streamDatabase = new StreamDatabase(this.ctx.storage.sql);
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
    // `itx.live` = the project's composite live state (see ProjectLiveState):
    // the processor's fold is ONE peer slice, alongside the streams index the DO
    // keeps in SQLite and the demo counter.
    getLiveState: () => {
      const reduced = this.#projectProcessor.currentState;
      // Reconcile any catalog stream missing an index row (cheap when none are),
      // so newly-created quiet streams show up in ⌘K without waiting for events.
      this.#streamDatabase.seedMissing(reduced.streams);
      return { reduced, streamsIndex: this.#streamDatabase.all(), liveDemo: this.#liveDemo };
    },
  });
  readonly #projectProcessor = this.#processorHost.add(
    (deps) =>
      new ProjectProcessor({
        ...deps,
        customDomains: createCloudflareProjectCustomDomainDeps({
          env: this.env,
          projectId: this.#name.projectId,
        }),
        itx: itxForScope({
          auth: trustedInternalAuthContext(),
          ctx: this.ctx,
          path: "/",
          projectId: this.#name.projectId,
        }),
      }),
  );

  // The Slack webhook router. It only ever WAKES on the Durable Object
  // instances addressed at `/integrations/slack/{connection}` (the host stream
  // is this DO's own path stream), where the OAuth connect flow configured
  // its subscription; registering it on every instance is harmless.
  // Registration is the point: the host wakes the router by slug; nothing
  // dials the facet handle directly anymore (status is a journal fold).
  protected readonly slackRouterRegistration = this.#processorHost.add((deps) => {
    // This DO instance hosts one connection's router stream
    // (/integrations/slack/{connection}): the name IS the connection, for both
    // routing and the bot-token secret path. Null (a non-connection path) is
    // passed through — the processor errors loudly if a mis-armed subscription
    // ever wakes it there.
    const connection = connectionFromIntegrationStreamPath(this.#name.path);
    return new SlackProcessor({
      ...deps,
      connection,
      acknowledgeRoutedWebhook: async ({ payload }) => {
        if (connection === null) return;
        const ack = eyesReactionTargetFromWebhookPayload(payload);
        if (ack == null) return;
        try {
          await callProjectSlackWebApi({
            body: { channel: ack.channel, name: "eyes", timestamp: ack.timestamp },
            connection,
            method: "reactions.add",
            projectId: this.#name.projectId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // The slack-agent processor adds the same reaction once the routed
          // stream catches up; whichever lands second dedups here.
          if (message.includes("already_reacted") || message.includes("not_reactable")) return;
          console.error("[slack] routed-webhook acknowledgement failed", {
            error,
            projectId: this.#name.projectId,
          });
        }
      },
    });
  });

  // The Telegram webhook router — same hosting shape as the Slack router: it
  // only ever WAKES on `/integrations/telegram/{connection}` instances, where
  // connectTelegram configured its subscription. No routed-webhook ack dep:
  // Telegram has no reaction primitive; the telegram-agent processor's
  // "typing…" chat action covers acknowledgement.
  protected readonly telegramRouterRegistration = this.#processorHost.add((deps) => {
    return new TelegramProcessor({
      ...deps,
      connection: connectionFromIntegrationStreamPath(this.#name.path),
    });
  });

  // The email thread router — same hosting shape as the Slack router: it only
  // ever WAKES on the Durable Object instance addressed at
  // `/integrations/email`, where project bootstrap (or the email ingress
  // door's belt-and-braces append) configured its subscription.
  readonly #emailProcessor = this.#processorHost.add((deps) => new EmailProcessor(deps));

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  /** The keepalive's revival alarm — see stream-processor-host.ts. */
  alarm(): Promise<void> {
    return this.#processorHost.handleAlarm();
  }

  get emailProcessor() {
    return new StreamProcessorRpcTarget(this.#emailProcessor, {
      // The ingress door reads the sender allowlist from this snapshot; it
      // must reflect a policy event appended moments ago (e.g. the birth
      // seed) even when push delivery is lagging or a wake was dropped.
      catchUpBeforeSnapshot: () => this.#processorHost.catchUp(EmailProcessorContract.slug),
    });
  }

  describe() {
    return {
      projectId: this.#name.projectId,
      name: this.ctx.id.name!,
    };
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#projectProcessor, {
      // Lists served from this snapshot (child streams, secrets) must reflect
      // a child stream created moments ago even when the root stream's push
      // delivery is lagging or a wake was dropped.
      catchUpBeforeSnapshot: () => this.#processorHost.catchUp(ProjectProcessorContract.slug),
    });
  }

  /** The project's live state — the get/set/assign/subscribe surface behind `itx.liveState`. */
  get liveState() {
    return new LiveStateRpcTarget(this.#processorHost);
  }

  /** Demo mutation: bump the shared counter and push it to every `itx.liveState` watcher. */
  incrementLiveDemo(): void {
    this.#liveDemo = { count: this.#liveDemo.count + 1 };
    this.#processorHost.refreshLive();
  }

  /**
   * Record stream activity in the index and push it to `itx.live`. Called from
   * the project's `processEventBatch` fan-in (every project-scoped stream's
   * events flow through it). Idempotent — `StreamDatabase.touch` only advances
   * recency — so a redelivered batch is harmless.
   */
  touchStreamActivity(path: string, at: string, type: string, maxOffset: number): void {
    this.#streamDatabase.touch(path, at, type, maxOffset);
    this.#processorHost.refreshLive();
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#egressInterceptor !== undefined) {
      // Egress interceptors run before secret substitution. They must never
      // receive raw secret material, only getSecret(...) placeholders.
      return await this.#egressInterceptor.value(request);
    }

    let secretPaths: string[];
    try {
      // Placeholders live in the request envelope: headers, or the URL for
      // providers that authenticate in the URL path (Telegram).
      secretPaths = secretReferencePathsFromRequest(request);
    } catch {
      return secretErrorResponse("secret_reference_required");
    }
    const platformReferences = platformReferencesFromHeaders(request.headers);

    // Platform API-key references (`getSecret({ platform: ... })`) resolve
    // HERE, from typed deployment config against a known origin-pinned
    // allowlist — no Durable Object, no synthetic secret. They do not mix
    // with project-secret references in one request.
    if (platformReferences.length > 0) {
      if (secretPaths.length > 0) return secretErrorResponse("secret_reference_foreign");
      try {
        return await fetch(
          substitutePlatformApiKeyReferences({ config: parseConfig(this.env), request }),
        );
      } catch (error) {
        if (error instanceof SecretSubstitutionError) return secretErrorResponse(error.code);
        throw error;
      }
    }

    if (secretPaths.length === 0) return fetch(request);
    // One request, one secret: the referenced Secret DO substitutes its own
    // placeholders under its own host pin (cross-secret chaining is gone).
    if (secretPaths.length > 1) return secretErrorResponse("secret_reference_foreign");

    return this.env.SECRET.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.#name.projectId,
        path: secretPaths[0]!,
      }),
    ).fetch(request);
  }

  interceptEgress(handler: ProjectEgressInterceptor): ProjectEgressIntercept {
    if (typeof handler !== "function")
      throw new Error("project egress interceptor must be a function");
    const retained = deepRetainRpcStubs(handler);
    if (this.#egressInterceptor !== undefined) {
      console.warn("project egress interceptor overwritten", { projectId: this.#name.projectId });
      this.#egressInterceptor[Symbol.dispose]();
    }
    this.#egressInterceptor = retained;

    return new ProjectEgressInterceptRpcTarget({
      ctx: this.ctx,
      release: () => {
        if (this.#egressInterceptor !== retained) return;
        retained[Symbol.dispose]();
        this.#egressInterceptor = undefined;
      },
    });
  }
}
