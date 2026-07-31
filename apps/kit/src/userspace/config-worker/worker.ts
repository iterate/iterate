import { IterateDurableObject, itxProjectStream, type Project } from "iterate/sdk";
import {
  DeviceEventSessionMetricsTracker,
  type DeviceEvent,
  type DeviceEventSessionMetrics,
  type DeviceEventSubscriptionDiagnostic,
  subscribePcmBridgeToDeviceEvents,
} from "./device-events.ts";
import { DeviceMetricsSessionTracker, type DeviceMetricsSessionMetrics } from "./device-metrics.ts";
import { executeKitDeviceTool } from "./device-tools.ts";
import {
  ITERATE_KIT_PCM_SAMPLE_RATE_HZ,
  ITERATE_KIT_PCM_SUBPROTOCOL,
  PcmSessionBridge,
  type PcmProxyDiagnostic,
  type ProviderFunctionCall,
  type PcmSessionMetrics,
} from "./pcm-proxy.ts";
import {
  ProviderEventStreamJournal,
  kitDeviceEventStreamPath,
  type ProviderEventStreamMetrics,
} from "./provider-event-stream.ts";
import { connectDeterministicTone, connectGrokRealtimeVoice } from "./providers.ts";
import {
  authenticateProjectBearer,
  handleKitVoiceRequest,
  loadProjectBearerCredential,
  readKitDeviceIdentity,
  type KitVoiceMode,
} from "./routes.ts";
const PCM_MODE_KEY = "kit-pcm-mode";
const PCM_SOCKET_BACKLOG_LIMIT_BYTES = 16 * 640;
const PREVIOUS_PCM_SESSION_KEY = "kit:previous-pcm-session";

interface ActivePcmSession {
  bridge: PcmSessionBridge;
  closeProjectSession(): void;
  deviceEvents: DeviceEventSessionMetricsTracker;
  deviceMetrics: DeviceMetricsSessionTracker;
  deviceId: string;
  deviceEventSubscriptionAttempts: number;
  deviceEventSubscriptionFailures: number;
  mode: KitVoiceMode;
  providerEvents: ProviderEventStreamJournal;
  providerConnectAttempts: number;
  providerConnectFailures: number;
  providerConnectPromise?: Promise<void>;
  server: WebSocket;
  sessionId: string;
}

interface ClosedPcmSessionReport extends PcmSessionMetrics {
  deviceEvents: DeviceEventSessionMetrics;
  deviceMetrics: DeviceMetricsSessionMetrics;
  deviceId: string;
  deviceEventSubscriptionAttempts: number;
  deviceEventSubscriptionFailures: number;
  endedAtMs: number;
  providerEvents: ProviderEventStreamMetrics;
  providerConnectAttempts: number;
  providerConnectFailures: number;
  sessionId: string;
}

/**
 * A production-shaped, intentionally small userspace owner for the two device
 * lanes:
 *
 * - Cap'n Web connects directly to OS and never enters this app.
 * - `/pcm` is only binary PCM plus its response boundary.
 *
 * Keeping this stateful is not for audio buffering. It gives the worker one
 * place to enforce "one current realtime generation" and lets a Cap'n Web
 * callback from the mounted device address that current generation even
 * though the physical button and PCM sockets are independent connections.
 */
export class KitVoiceWorker extends IterateDurableObject {
  #activePcm: ActivePcmSession | undefined;
  #previousPcm: ClosedPcmSessionReport | undefined;

  async fetch(request: Request): Promise<Response> {
    return await handleKitVoiceRequest(request, {
      handlePcm: async (pcmRequest) => await this.#handlePcm(pcmRequest),
      readMode: async () => await this.#readMode(),
    });
  }

  /** Remote tests use the same transition methods as the physical callback. */
  inputStarted(): boolean {
    return this.#activePcm?.bridge.inputStarted() ?? false;
  }

  inputStopped(): boolean {
    return this.#activePcm?.bridge.inputStopped() ?? false;
  }

  /**
   * Deliberately crash this userspace incarnation so every attached socket is
   * severed by the Durable Object runtime, not merely asked to close politely.
   *
   * This is an operational recovery and test primitive: it proves that the
   * device treats a vanished userspace owner as a generation boundary and
   * reconnects without replaying stale PCM. The platform reserves `kill` on a
   * direct dynamic-worker stub, so callers that specifically want this
   * userspace method invoke the flattened capability path `["kill"]`; the
   * platform-owned `worker.kill()` is an equally valid, stronger host+facet
   * reset.
   */
  kill(): void {
    this.#closeActivePcm(1012, "Userspace worker kill requested.");
    /*
     * Cloudflare's deployed runtime exposes abort(), and Iterate's own
     * platform Durable Objects use it, but the standalone workers-types
     * version used to bundle config apps has not caught up with that method.
     * Keep the local refinement narrow so we do not lie about the rest of the
     * DurableObjectState surface.
     */
    (this.ctx as typeof this.ctx & { abort(reason: string): void }).abort(
      "kit voice userspace kill requested",
    );
  }

  pcmMetrics() {
    const active = this.#activePcm;
    if (active === undefined) return this.#readPreviousPcm() ?? null;
    return {
      ...active.bridge.metrics(),
      deviceEvents: active.deviceEvents.metrics(),
      deviceId: active.deviceId,
      deviceMetrics: active.deviceMetrics.metrics(),
      deviceEventSubscriptionAttempts: active.deviceEventSubscriptionAttempts,
      deviceEventSubscriptionFailures: active.deviceEventSubscriptionFailures,
      endedAtMs: null,
      previousSession: this.#readPreviousPcm() ?? null,
      providerEvents: active.providerEvents.metrics(),
      providerConnectAttempts: active.providerConnectAttempts,
      providerConnectFailures: active.providerConnectFailures,
      sessionId: active.sessionId,
    };
  }

  async #handlePcm(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("A WebSocket upgrade is required.", {
        headers: { upgrade: "websocket" },
        status: 426,
      });
    }
    if (!requestedProtocols(request).includes(ITERATE_KIT_PCM_SUBPROTOCOL)) {
      return new Response(`The ${ITERATE_KIT_PCM_SUBPROTOCOL} subprotocol is required.`, {
        headers: { "sec-websocket-protocol": ITERATE_KIT_PCM_SUBPROTOCOL },
        status: 426,
      });
    }

    const authenticated = await authenticateProjectBearer(
      request,
      async () => await this.#loadProjectCredential(),
    );
    if (authenticated === null) {
      return new Response("Unauthorized.", {
        headers: { "www-authenticate": "Bearer" },
        status: 401,
      });
    }
    const deviceId = readKitDeviceIdentity(request);
    if (deviceId === null) {
      return new Response("A valid Iterate Kit device identity is required.", { status: 400 });
    }

    const mode = await this.#readMode();
    let provider: WebSocket;
    try {
      provider =
        mode === "tone"
          ? await connectDeterministicTone({
              durationMs: 2_000,
              frequencyHz: 1_000,
              sampleRateHz: ITERATE_KIT_PCM_SAMPLE_RATE_HZ,
            })
          : await this.#connectGrok();
    } catch (error) {
      this.#log("provider-connect-failed", "error", {
        message: errorMessage(error),
        mode,
      });
      return new Response("The voice provider could not be reached.", { status: 502 });
    }

    /*
     * A replacement must invalidate the old provider and callback before the
     * new button subscription is installed. Otherwise one physical release
     * could commit two generations after an ordinary PCM reconnect.
     */
    this.#closeActivePcm(4001, "A newer PCM session replaced this one.");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const sessionId = `${authenticated.projectId}:${deviceId}:${crypto.randomUUID()}`;
    /*
     * Provider evidence uses its own short ITX sessions and a bounded journal.
     * It must never borrow the retained device-callback session below: stream
     * latency or failure is diagnostic loss, not permission to stall PTT or
     * make Cap'n Web callback ownership compete with PCM-adjacent controls.
     */
    const providerEventStreamPath = kitDeviceEventStreamPath(deviceId);
    const providerEventStream = itxProjectStream(this.env, providerEventStreamPath);
    const providerEvents = new ProviderEventStreamJournal({
      append: async (...events) => {
        await providerEventStream.append(...events);
      },
      onDiagnostic: (diagnostic) => {
        this.#log(diagnostic.code, diagnostic.severity, {
          ...diagnostic.detail,
          sessionId,
          streamPath: providerEventStreamPath,
        });
      },
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
    let active: ActivePcmSession | undefined;
    const bridge = new PcmSessionBridge({
      device: server,
      maximumSocketBufferedBytes: PCM_SOCKET_BACKLOG_LIMIT_BYTES,
      onDiagnostic: (diagnostic) => this.#onPcmDiagnostic(diagnostic),
      onProviderEvent: (event) => providerEvents.observe(event, sessionId),
      onProviderFunctionCall: (call) =>
        this.#executeProviderFunctionCall(call, sessionId, deviceId),
      onProviderUnavailable: () => {
        if (active !== undefined) this.#ensureProvider(active, "provider-unavailable");
      },
      provider,
      sessionId,
    });
    const deviceEvents = new DeviceEventSessionMetricsTracker();
    const deviceMetrics = new DeviceMetricsSessionTracker();

    let project: (Project & Disposable) | undefined;
    let projectSessionClosed = false;
    const closeProjectSession = () => {
      if (projectSessionClosed) return;
      projectSessionClosed = true;
      project?.[Symbol.dispose]();
      project = undefined;
    };
    active = {
      bridge,
      closeProjectSession,
      deviceEvents,
      deviceId,
      deviceMetrics,
      deviceEventSubscriptionAttempts: 0,
      deviceEventSubscriptionFailures: 0,
      mode,
      providerEvents,
      providerConnectAttempts: 1,
      providerConnectFailures: 0,
      server,
      sessionId,
    };
    this.#activePcm = active;
    server.addEventListener(
      "close",
      () => {
        if (this.#activePcm?.server === server) {
          this.#rememberClosedPcm(active);
          this.#activePcm = undefined;
        }
        closeProjectSession();
      },
      { once: true },
    );

    /*
     * The two device sockets reconnect independently. In a cold boot `/pcm`
     * can arrive a few seconds before Cap'n Web has mounted the PTT target.
     * That ordering is ordinary convergence, not a reason to destroy a healthy
     * audio lane. Retry a finite, explicit window and retain the successful
     * project session for exactly the device socket lifetime.
     */
    const subscription = this.#establishDeviceEventSubscription(active, {
      assignProject(openedProject) {
        if (projectSessionClosed) {
          openedProject[Symbol.dispose]();
          return false;
        }
        project = openedProject;
        return true;
      },
    });
    this.ctx.waitUntil(subscription);

    return new Response(null, {
      headers: { "sec-websocket-protocol": ITERATE_KIT_PCM_SUBPROTOCOL },
      status: 101,
      webSocket: client,
    });
  }

  async #connectGrok(): Promise<WebSocket> {
    using project = await this.env.ITX.get();
    return await connectGrokRealtimeVoice({
      fetchCredential: async (request) => await project.egress.fetch(request),
      sampleRateHz: ITERATE_KIT_PCM_SAMPLE_RATE_HZ,
    });
  }

  #executeProviderFunctionCall(
    call: ProviderFunctionCall,
    sessionId: string,
    deviceId: string,
  ): Promise<unknown> {
    const execution = (async () => {
      using project = await this.env.ITX.get();
      const result = await executeKitDeviceTool(project, call, deviceId);
      this.#log("device-tool-completed", "info", {
        callId: call.callId,
        deviceId,
        name: call.name,
        result,
        sessionId,
        wouldPostToStream: true,
      });
      return result;
    })();
    /*
     * A WebSocket MessageEvent does not implicitly extend a Durable Object
     * turn through an arbitrary device RPC. The bridge awaits this same
     * promise for Grok's function output; waitUntil keeps the worker alive,
     * while the rejection is consumed here because the bridge classifies and
     * returns it to the provider itself.
     */
    this.ctx.waitUntil(
      execution.then(
        () => undefined,
        () => undefined,
      ),
    );
    return execution;
  }

  #ensureProvider(active: ActivePcmSession, reason: string): void {
    if (this.#activePcm !== active || active.bridge.metrics().closed) return;
    if (active.providerConnectPromise !== undefined) return;

    active.providerConnectAttempts += 1;
    const connecting = (async () => {
      try {
        const provider =
          active.mode === "tone"
            ? await connectDeterministicTone({
                durationMs: 2_000,
                frequencyHz: 1_000,
                sampleRateHz: ITERATE_KIT_PCM_SAMPLE_RATE_HZ,
              })
            : await this.#connectGrok();
        if (this.#activePcm !== active || !active.bridge.attachProvider(provider)) {
          if (
            provider.readyState === WebSocket.OPEN ||
            provider.readyState === WebSocket.CONNECTING
          ) {
            provider.close(1000, "The device PCM generation was replaced while reconnecting.");
          }
          return;
        }
        this.#log("provider-reconnected", "info", {
          attempt: active.providerConnectAttempts,
          mode: active.mode,
          reason,
          sessionId: active.sessionId,
        });
      } catch (error) {
        active.providerConnectFailures += 1;
        this.#log("provider-reconnect-failed", "error", {
          attempt: active.providerConnectAttempts,
          message: errorMessage(error),
          mode: active.mode,
          reason,
          sessionId: active.sessionId,
        });
      }
    })();
    active.providerConnectPromise = connecting;
    const tracked = connecting.finally(() => {
      if (active.providerConnectPromise === connecting) {
        active.providerConnectPromise = undefined;
      }
    });
    this.ctx.waitUntil(tracked);
  }

  async #establishDeviceEventSubscription(
    active: ActivePcmSession,
    owner: { assignProject(project: Project & Disposable): boolean },
  ): Promise<void> {
    const retryDelaysMs = [0, 250, 500, 1_000, 2_000, 4_000, 8_000];
    for (const delayMs of retryDelaysMs) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      if (this.#activePcm !== active || active.bridge.metrics().closed) return;

      active.deviceEventSubscriptionAttempts += 1;
      let project: (Project & Disposable) | undefined;
      try {
        project = await this.env.ITX.get();
        await this.#subscribeToDeviceEvents(project, active, active.sessionId);
        await this.#subscribeToDeviceMetrics(project, active, active.sessionId);
        if (!owner.assignProject(project)) return;
        this.#log("device-event-subscribed", "info", {
          attempt: active.deviceEventSubscriptionAttempts,
          sessionId: active.sessionId,
        });
        return;
      } catch (error) {
        project?.[Symbol.dispose]();
        active.deviceEventSubscriptionFailures += 1;
        const finalAttempt = active.deviceEventSubscriptionAttempts === retryDelaysMs.length;
        this.#log(
          finalAttempt ? "device-event-subscribe-exhausted" : "device-event-subscribe-retrying",
          finalAttempt ? "error" : "warn",
          {
            attempt: active.deviceEventSubscriptionAttempts,
            message: errorMessage(error),
            nextDelayMs: finalAttempt
              ? null
              : retryDelaysMs[active.deviceEventSubscriptionAttempts],
            sessionId: active.sessionId,
          },
        );
      }
    }
  }

  async #loadProjectCredential() {
    using project = await this.env.ITX.get();
    return await loadProjectBearerCredential(project);
  }

  async #readMode(): Promise<KitVoiceMode> {
    using project = await this.env.ITX.get();
    const mode = await project.kv.get(PCM_MODE_KEY);
    if (mode === null) return "tone";
    if (mode === "tone" || mode === "grok") return mode;
    throw new Error(`${PCM_MODE_KEY} must be either "tone" or "grok".`);
  }

  async #subscribeToDeviceEvents(
    project: Project,
    active: ActivePcmSession,
    sessionId: string,
  ): Promise<void> {
    await subscribePcmBridgeToDeviceEvents(
      {
        subscribeToEvents: async (callback) => {
          /*
           * Every board mounts `kit.<firmware-owned-device-id>` on the project
           * root. Address that root explicitly rather than making this app's
           * `/kit/` scoped host fallback an accidental part of the contract.
           * The identity arrived in the authenticated PCM handshake, so a
           * StackChan session cannot accidentally control or journal a Stick.
           */
          await project.capabilityHosts.get("/").invokeCapability({
            args: [
              (event: DeviceEvent) => {
                /*
                 * This is the explicit MVP stream seam. The event is logged as
                 * something that WOULD be cross-posted, while no durable stream
                 * semantics are implied before that design is agreed.
                 */
                this.#log("device-event", "info", {
                  event,
                  sessionId,
                  wouldPostToStream: true,
                });
                callback(event);
              },
            ],
            path: ["kit", active.deviceId, "subscribeToEvents"],
          });
        },
      },
      active.bridge,
      (diagnostic) => this.#onDeviceEventDiagnostic(diagnostic, active.bridge, sessionId),
      (event) => active.deviceEvents.observe(event),
    );
  }

  async #subscribeToDeviceMetrics(
    project: Project,
    active: ActivePcmSession,
    sessionId: string,
  ): Promise<void> {
    await project.capabilityHosts.get("/").invokeCapability({
      args: [
        (value: unknown) => {
          const observation = active.deviceMetrics.observe(value);
          if (!observation.ok) {
            this.#log("invalid-device-metrics", "error", {
              reason: observation.reason,
              sessionId,
            });
            return;
          }
          /*
           * This is the metrics half of the MVP stream seam. Retaining one
           * defensive latest snapshot gives `pcmMetrics()` a synchronous view;
           * logging the same bounded sample proves the userspace callback
           * fires and records what WOULD later be cross-posted to a stream.
           */
          this.#log("device-metrics", "info", {
            metrics: observation.sample,
            sessionId,
            wouldPostToStream: true,
          });
        },
      ],
      path: ["kit", active.deviceId, "subscribeToMetrics"],
    });
  }

  #onPcmDiagnostic(diagnostic: PcmProxyDiagnostic): void {
    this.#log(diagnostic.code, diagnostic.severity, diagnostic);
  }

  #onDeviceEventDiagnostic(
    diagnostic: DeviceEventSubscriptionDiagnostic,
    bridge: PcmSessionBridge,
    sessionId: string,
  ): void {
    this.#log(diagnostic.code, "error", { ...diagnostic, sessionId });
    if (diagnostic.code === "device-event-sequence-gap") {
      /*
       * Guessing after a lost PTT edge can commit the wrong microphone turn.
       * Close this generation visibly; the firmware's bounded reconnect policy
       * is safer than continuing with an inverted held/released state.
       */
      bridge.close(4002, "Push-to-talk event sequence gap.");
    }
  }

  #closeActivePcm(code: number, reason: string): void {
    const active = this.#activePcm;
    this.#activePcm = undefined;
    if (active === undefined) return;
    active.bridge.close(code, reason);
    this.#rememberClosedPcm(active);
    active.closeProjectSession();
  }

  #readPreviousPcm(): ClosedPcmSessionReport | undefined {
    return (
      this.#previousPcm ?? this.ctx.storage.kv.get<ClosedPcmSessionReport>(PREVIOUS_PCM_SESSION_KEY)
    );
  }

  #rememberClosedPcm(active: ActivePcmSession): void {
    /*
     * A healthy firmware reconnect is fast enough to hide the failed
     * generation between ordinary metric polls. Persist exactly one bounded
     * snapshot at the generation boundary: counters and selected provider
     * error/close fields survive eviction. Raw non-PCM provider frames live in
     * the normal device stream instead; PCM is never retained.
     */
    const report: ClosedPcmSessionReport = {
      ...active.bridge.metrics(),
      deviceEvents: active.deviceEvents.metrics(),
      deviceMetrics: active.deviceMetrics.metrics(),
      deviceId: active.deviceId,
      deviceEventSubscriptionAttempts: active.deviceEventSubscriptionAttempts,
      deviceEventSubscriptionFailures: active.deviceEventSubscriptionFailures,
      endedAtMs: Date.now(),
      providerEvents: active.providerEvents.metrics(),
      providerConnectAttempts: active.providerConnectAttempts,
      providerConnectFailures: active.providerConnectFailures,
      sessionId: active.sessionId,
    };
    this.#previousPcm = report;
    this.ctx.storage.kv.put(PREVIOUS_PCM_SESSION_KEY, report);
  }

  #log(code: string, severity: "debug" | "error" | "info" | "warn", detail: unknown): void {
    const record = JSON.stringify({
      code,
      detail,
      service: "iterate-kit-voice",
      severity,
      timestamp: new Date().toISOString(),
    });
    if (severity === "error") console.error(record);
    else if (severity === "warn") console.warn(record);
    else console.log(record);
  }
}

function requestedProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
