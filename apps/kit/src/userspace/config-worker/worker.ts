import { IterateDurableObject, itxProjectStream, type Project } from "iterate/sdk";
import {
  DeviceEventSessionMetricsTracker,
  type DeviceEvent,
  type DeviceEventSessionMetrics,
  type DeviceEventSubscriptionDiagnostic,
  subscribePcmBridgeToDeviceEvents,
} from "./device-events.ts";
import { DeviceMetricsSessionTracker, type DeviceMetricsSessionMetrics } from "./device-metrics.ts";
import {
  DeviceSubscriptionCoordinator,
  type DeviceSubscriptionMetrics,
} from "./device-subscriptions.ts";
import { interruptKitDevicePlayback } from "./device-control.ts";
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
import {
  connectDeterministicTone,
  connectGrokRealtimeVoice,
  GrokCredentialPrewarmer,
  mintGrokRealtimeCredential,
  type GrokRealtimeVoiceStage,
} from "./providers.ts";
import {
  authenticateProjectBearer,
  handleKitVoiceRequest,
  loadProjectBearerCredential,
  readKitAudioMode,
  readKitDeviceIdentity,
  type KitAudioMode,
  type KitVoiceMode,
} from "./routes.ts";
const PCM_MODE_KEY = "kit-pcm-mode";
const PCM_SOCKET_BACKLOG_LIMIT_BYTES = 16 * 640;
const PREVIOUS_PCM_SESSION_KEY = "kit:previous-pcm-session";

interface PcmSessionStartupTimeline {
  authenticationAndModeReadyAtMs: number | null;
  credentialPrewarmDecodedAtMs: number | null;
  credentialPrewarmReceivedAtMs: number | null;
  credentialPrewarmStartedAtMs: number | null;
  deviceLaneAcceptedAtMs: number | null;
  providerConnectStartedAtMs: number | null;
  providerSessionUpdateSentAtMs: number | null;
  providerWebSocketCreatedAtMs: number | null;
  providerWebSocketOpenedAtMs: number | null;
  requestReceivedAtMs: number;
}

interface ActivePcmSession {
  audioMode: KitAudioMode;
  bridge: PcmSessionBridge;
  closeProjectSession(): void;
  deviceEvents: DeviceEventSessionMetricsTracker;
  deviceMetrics: DeviceMetricsSessionTracker;
  deviceId: string;
  deviceSubscriptions: DeviceSubscriptionCoordinator<Project & Disposable>;
  grokCredentialPrewarmer?: GrokCredentialPrewarmer;
  lastProviderConnectError: string | null;
  mode: KitVoiceMode;
  providerEvents: ProviderEventStreamJournal;
  providerConnectAttempts: number;
  providerConnectFailures: number;
  providerConnectPromise?: Promise<void>;
  server: WebSocket;
  sessionId: string;
  startup: PcmSessionStartupTimeline;
}

interface ClosedPcmSessionReport extends PcmSessionMetrics {
  audioMode: KitAudioMode;
  deviceEvents: DeviceEventSessionMetrics;
  deviceMetrics: DeviceMetricsSessionMetrics;
  deviceId: string;
  deviceSubscriptions: DeviceSubscriptionMetrics;
  deviceEventSubscriptionAttempts: number;
  deviceEventSubscriptionFailures: number;
  endedAtMs: number;
  grokCredential: ReturnType<GrokCredentialPrewarmer["metrics"]> | null;
  lastProviderConnectError: string | null;
  providerEvents: ProviderEventStreamMetrics;
  providerConnectAttempts: number;
  providerConnectFailures: number;
  sessionId: string;
  startup: ReturnType<typeof pcmSessionStartupMetrics>;
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
    const bridgeMetrics = active.bridge.metrics();
    const deviceSubscriptions = active.deviceSubscriptions.metrics();
    return {
      ...bridgeMetrics,
      audioMode: active.audioMode,
      deviceEvents: active.deviceEvents.metrics(),
      deviceId: active.deviceId,
      deviceMetrics: active.deviceMetrics.metrics(),
      deviceSubscriptions,
      deviceEventSubscriptionAttempts: deviceSubscriptions.eventAttempts,
      deviceEventSubscriptionFailures: deviceSubscriptions.eventFailures,
      endedAtMs: null,
      grokCredential: active.grokCredentialPrewarmer?.metrics() ?? null,
      lastProviderConnectError: active.lastProviderConnectError,
      previousSession: this.#readPreviousPcm() ?? null,
      providerEvents: active.providerEvents.metrics(),
      providerConnectAttempts: active.providerConnectAttempts,
      providerConnectFailures: active.providerConnectFailures,
      sessionId: active.sessionId,
      startup: pcmSessionStartupMetrics(active.startup, bridgeMetrics),
    };
  }

  async #handlePcm(request: Request): Promise<Response> {
    const startup: PcmSessionStartupTimeline = {
      authenticationAndModeReadyAtMs: null,
      credentialPrewarmDecodedAtMs: null,
      credentialPrewarmReceivedAtMs: null,
      credentialPrewarmStartedAtMs: null,
      deviceLaneAcceptedAtMs: null,
      providerConnectStartedAtMs: null,
      providerSessionUpdateSentAtMs: null,
      providerWebSocketCreatedAtMs: null,
      providerWebSocketOpenedAtMs: null,
      requestReceivedAtMs: Date.now(),
    };
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

    /*
     * Authentication and the mode are properties of the same scoped project.
     * A call previously opened two sequential Cap'n Web sessions just to read
     * them. One lazy promise lets authentication retain its existing API while
     * both reads share one project session and execute concurrently.
     */
    let ingressConfigurationPromise:
      | Promise<{
          credential: Awaited<ReturnType<typeof loadProjectBearerCredential>>;
          mode: KitVoiceMode;
        }>
      | undefined;
    const loadIngressConfiguration = () =>
      (ingressConfigurationPromise ??= this.#loadPcmIngressConfiguration());
    const authenticated = await authenticateProjectBearer(request, async () => {
      return (await loadIngressConfiguration()).credential;
    });
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
    const audioMode = readKitAudioMode(request);
    if (audioMode === null) {
      return new Response("A valid Iterate Kit audio mode is required.", { status: 400 });
    }
    const { mode } = await loadIngressConfiguration();
    startup.authenticationAndModeReadyAtMs = Date.now();

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
    startup.deviceLaneAcceptedAtMs = Date.now();
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
    let project: (Project & Disposable) | undefined;
    let projectSessionClosed = false;
    const closeProjectSession = () => {
      if (projectSessionClosed) return;
      projectSessionClosed = true;
      project?.[Symbol.dispose]();
      project = undefined;
    };
    const bridge = new PcmSessionBridge({
      device: server,
      maximumSocketBufferedBytes: PCM_SOCKET_BACKLOG_LIMIT_BYTES,
      onDiagnostic: (diagnostic) => this.#onPcmDiagnostic(diagnostic),
      onPlaybackInterruption: () => {
        const deviceProject = project;
        if (deviceProject === undefined || projectSessionClosed) {
          throw new Error("The retained device capability session is unavailable.");
        }
        const reset = interruptKitDevicePlayback(deviceProject, deviceId);
        /*
         * The bridge owns the acknowledgement as a playout fence. waitUntil
         * independently keeps the Durable Object turn alive without putting
         * the Cap'n Web round trip in the provider MessageEvent receive lane.
         */
        this.ctx.waitUntil(
          reset.then(
            () => undefined,
            () => undefined,
          ),
        );
        return reset;
      },
      onProviderEvent: (event) => providerEvents.observe(event, sessionId),
      onProviderFunctionCall: (call) =>
        this.#executeProviderFunctionCall(call, sessionId, deviceId),
      onProviderUnavailable: () => {
        if (active?.bridge.metrics().conversationActive) {
          this.#ensureProvider(active, "provider-unavailable");
        }
      },
      sessionId,
      turnDetection: audioMode === "full-duplex-aec" ? "server-vad" : "manual",
    });
    const deviceEvents = new DeviceEventSessionMetricsTracker();
    const deviceMetrics = new DeviceMetricsSessionTracker();
    const deviceSubscriptions = new DeviceSubscriptionCoordinator<Project & Disposable>({
      isCurrent: () => {
        const session = active;
        return (
          session !== undefined && this.#activePcm === session && !session.bridge.metrics().closed
        );
      },
      onDiagnostic: (diagnostic) => {
        const severity = diagnostic.code.endsWith("-subscribed") ? "info" : "warn";
        this.#log(diagnostic.code, severity, {
          attempt: diagnostic.attempt,
          message: diagnostic.message,
          nextDelayMs: diagnostic.nextDelayMs,
          sessionId,
        });
      },
      openProject: async () => await this.env.ITX.get(),
      releaseProject(openedProject) {
        if (project === openedProject) {
          project = undefined;
        } else if (projectSessionClosed) {
          /* closeProjectSession already disposed this exact generation. */
          return;
        }
        openedProject[Symbol.dispose]();
      },
      retainProject(openedProject) {
        if (projectSessionClosed) return false;
        project = openedProject;
        return true;
      },
      retryDelaysMs: [0, 250, 500, 1_000, 2_000, 4_000, 8_000],
      subscribeToEvents: async (openedProject) => {
        const session = active;
        if (session === undefined) throw new Error("The PCM session is not initialized.");
        await this.#subscribeToDeviceEvents(openedProject, session, sessionId);
      },
      subscribeToMetrics: async (openedProject) => {
        const session = active;
        if (session === undefined) throw new Error("The PCM session is not initialized.");
        await this.#subscribeToDeviceMetrics(openedProject, session, sessionId);
      },
      wait: async (delayMs) => await new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
    });

    active = {
      audioMode,
      bridge,
      closeProjectSession,
      deviceEvents,
      deviceId,
      deviceMetrics,
      deviceSubscriptions,
      lastProviderConnectError: null,
      mode,
      providerEvents,
      providerConnectAttempts: 0,
      providerConnectFailures: 0,
      server,
      sessionId,
      startup,
    };
    this.#activePcm = active;
    if (mode === "grok") {
      const prewarmer = new GrokCredentialPrewarmer({
        mintCredential: async () =>
          await this.#mintGrokCredential((stage) => {
            if (this.#activePcm === active) observeGrokStartupStage(active.startup, stage);
          }),
        onFailure: (error) => {
          this.#log("provider-credential-prewarm-failed", "error", {
            message: errorMessage(error),
            sessionId,
          });
        },
        runInBackground: (promise) => this.ctx.waitUntil(promise),
      });
      active.grokCredentialPrewarmer = prewarmer;
      /*
       * The authenticated device lane is deliberately boot-warm. Start the
       * slow, secret-confined credential request at that same idle boundary,
       * not on Button B; a measured production mint took 2.67 seconds. The
       * short-lived value never leaves this userspace Durable Object.
       */
      void prewarmer.prewarm().catch(() => undefined);
    }
    server.addEventListener(
      "close",
      () => {
        if (this.#activePcm?.server === server) {
          this.#rememberClosedPcm(active);
          this.#activePcm = undefined;
        }
        active.grokCredentialPrewarmer?.[Symbol.dispose]();
        closeProjectSession();
      },
      { once: true },
    );

    /*
     * The two device sockets reconnect independently. In a cold boot `/pcm`
     * can arrive a few seconds before Cap'n Web has mounted the PTT target.
     * That ordering is ordinary convergence, not a reason to destroy a healthy
     * audio lane. Climb a finite backoff ladder, then retain one capped retry
     * cadence and project session for exactly the device socket lifetime.
     */
    const subscription = deviceSubscriptions.establish();
    this.ctx.waitUntil(subscription);

    return new Response(null, {
      headers: { "sec-websocket-protocol": ITERATE_KIT_PCM_SUBPROTOCOL },
      status: 101,
      webSocket: client,
    });
  }

  async #mintGrokCredential(onStage?: (stage: GrokRealtimeVoiceStage) => void) {
    using project = await this.env.ITX.get();
    return await mintGrokRealtimeCredential({
      fetchCredential: async (request) => await project.egress.fetch(request),
      onStage,
    });
  }

  async #connectGrok(
    active: ActivePcmSession,
    onStage?: (stage: GrokRealtimeVoiceStage) => void,
  ): Promise<WebSocket> {
    const prewarmer = active.grokCredentialPrewarmer;
    if (prewarmer === undefined) {
      throw new Error("The Grok credential prewarmer is unavailable.");
    }
    const credential = await prewarmer.take();
    return await connectGrokRealtimeVoice({
      credential,
      onStage,
      sampleRateHz: ITERATE_KIT_PCM_SAMPLE_RATE_HZ,
      turnDetection: active.audioMode === "full-duplex-aec" ? "server-vad" : "manual",
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
    const bridgeMetrics = active.bridge.metrics();
    if (
      this.#activePcm !== active ||
      bridgeMetrics.closed ||
      !bridgeMetrics.conversationActive ||
      bridgeMetrics.providerAvailable
    ) {
      return;
    }
    if (active.providerConnectPromise !== undefined) return;

    active.providerConnectAttempts += 1;
    active.startup.providerConnectStartedAtMs ??= Date.now();
    const connecting = (async () => {
      try {
        const provider =
          active.mode === "tone"
            ? await connectDeterministicTone({
                durationMs: 2_000,
                frequencyHz: 1_000,
                sampleRateHz: ITERATE_KIT_PCM_SAMPLE_RATE_HZ,
              })
            : await this.#connectGrok(active, (stage) => {
                if (this.#activePcm === active) observeGrokStartupStage(active.startup, stage);
              });
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
        active.lastProviderConnectError = null;
      } catch (error) {
        active.providerConnectFailures += 1;
        active.lastProviderConnectError = errorMessage(error);
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

  async #loadPcmIngressConfiguration() {
    using project = await this.env.ITX.get();
    const [credential, storedMode] = await Promise.all([
      loadProjectBearerCredential(project),
      project.kv.get(PCM_MODE_KEY),
    ]);
    return { credential, mode: parseKitVoiceMode(storedMode) };
  }

  async #readMode(): Promise<KitVoiceMode> {
    using project = await this.env.ITX.get();
    return parseKitVoiceMode(await project.kv.get(PCM_MODE_KEY));
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
      active.audioMode,
      (diagnostic) => this.#onDeviceEventDiagnostic(diagnostic, active.bridge, sessionId),
      (event) => {
        active.deviceEvents.observe(event);
        if (
          event.type === "conversation.started" ||
          (event.snapshot === true && event.conversationActive === true)
        ) {
          /*
           * Button B now pays only for the disposable upstream generation.
           * The Stick's authenticated PCM socket completed its expensive TLS
           * setup while idle, so provider setup can run here without delaying
           * or replacing that device lane. A duplicate edge is harmless:
           * #ensureProvider fences both an attached and an in-flight provider.
           */
          this.#ensureProvider(active, event.snapshot === true ? "snapshot" : "conversation-start");
        }
      },
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
    active.grokCredentialPrewarmer?.[Symbol.dispose]();
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
    const bridgeMetrics = active.bridge.metrics();
    const deviceSubscriptions = active.deviceSubscriptions.metrics();
    const report: ClosedPcmSessionReport = {
      ...bridgeMetrics,
      audioMode: active.audioMode,
      deviceEvents: active.deviceEvents.metrics(),
      deviceMetrics: active.deviceMetrics.metrics(),
      deviceId: active.deviceId,
      deviceSubscriptions,
      deviceEventSubscriptionAttempts: deviceSubscriptions.eventAttempts,
      deviceEventSubscriptionFailures: deviceSubscriptions.eventFailures,
      endedAtMs: Date.now(),
      grokCredential: active.grokCredentialPrewarmer?.metrics() ?? null,
      lastProviderConnectError: active.lastProviderConnectError,
      providerEvents: active.providerEvents.metrics(),
      providerConnectAttempts: active.providerConnectAttempts,
      providerConnectFailures: active.providerConnectFailures,
      sessionId: active.sessionId,
      startup: pcmSessionStartupMetrics(active.startup, bridgeMetrics),
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

function parseKitVoiceMode(mode: unknown): KitVoiceMode {
  if (mode === null) return "tone";
  if (mode === "tone" || mode === "grok") return mode;
  throw new Error(`${PCM_MODE_KEY} must be either "tone" or "grok".`);
}

function observeGrokStartupStage(
  timeline: PcmSessionStartupTimeline,
  stage: GrokRealtimeVoiceStage,
): void {
  /*
   * These fields retain only the first upstream generation. Reconnect timing
   * is separately counted, while overwriting cold-start timestamps would make
   * a later fast retry erase the reason the user originally waited.
   */
  if (stage.code === "credential-prewarm-started") {
    timeline.credentialPrewarmStartedAtMs ??= stage.atMs;
  } else if (stage.code === "credential-prewarm-received") {
    timeline.credentialPrewarmReceivedAtMs ??= stage.atMs;
  } else if (stage.code === "credential-prewarm-decoded") {
    timeline.credentialPrewarmDecodedAtMs ??= stage.atMs;
  } else if (stage.code === "provider-websocket-created") {
    timeline.providerWebSocketCreatedAtMs ??= stage.atMs;
  } else if (stage.code === "provider-websocket-opened") {
    timeline.providerWebSocketOpenedAtMs ??= stage.atMs;
  } else {
    timeline.providerSessionUpdateSentAtMs ??= stage.atMs;
  }
}

function pcmSessionStartupMetrics(
  timeline: PcmSessionStartupTimeline,
  bridge: Pick<
    PcmSessionMetrics,
    | "firstDevicePcmSentAtMs"
    | "firstProviderPcmAtMs"
    | "conversationStartedAtMs"
    | "providerAttachedAtMs"
    | "providerSessionReadyAtMs"
  >,
) {
  const elapsedFromRequest = (atMs: number | null) =>
    atMs === null ? null : Math.max(0, atMs - timeline.requestReceivedAtMs);
  const elapsedFromConversation = (atMs: number | null) =>
    atMs === null || bridge.conversationStartedAtMs === null
      ? null
      : Math.max(0, atMs - bridge.conversationStartedAtMs);
  return {
    ...timeline,
    deviceUpgradeLatencyMs: elapsedFromRequest(timeline.deviceLaneAcceptedAtMs),
    firstDevicePcmLatencyMs: elapsedFromRequest(bridge.firstDevicePcmSentAtMs),
    firstDevicePcmSentAtMs: bridge.firstDevicePcmSentAtMs,
    firstDevicePcmFromConversationMs: elapsedFromConversation(bridge.firstDevicePcmSentAtMs),
    firstProviderPcmAtMs: bridge.firstProviderPcmAtMs,
    firstProviderPcmLatencyMs: elapsedFromRequest(bridge.firstProviderPcmAtMs),
    firstProviderPcmFromConversationMs: elapsedFromConversation(bridge.firstProviderPcmAtMs),
    conversationStartedAtMs: bridge.conversationStartedAtMs,
    providerAttachedAtMs: bridge.providerAttachedAtMs,
    providerAttachedLatencyMs: elapsedFromRequest(bridge.providerAttachedAtMs),
    providerAttachedFromConversationMs: elapsedFromConversation(bridge.providerAttachedAtMs),
    credentialPrewarmLatencyMs:
      timeline.credentialPrewarmStartedAtMs === null ||
      timeline.credentialPrewarmDecodedAtMs === null
        ? null
        : Math.max(
            0,
            timeline.credentialPrewarmDecodedAtMs - timeline.credentialPrewarmStartedAtMs,
          ),
    credentialReadyBeforeConversationMs:
      timeline.credentialPrewarmDecodedAtMs === null || bridge.conversationStartedAtMs === null
        ? null
        : Math.max(0, bridge.conversationStartedAtMs - timeline.credentialPrewarmDecodedAtMs),
    providerWebSocketOpenFromConversationMs: elapsedFromConversation(
      timeline.providerWebSocketOpenedAtMs,
    ),
    providerSessionReadyAtMs: bridge.providerSessionReadyAtMs,
    providerSessionReadyLatencyMs: elapsedFromRequest(bridge.providerSessionReadyAtMs),
    providerSessionReadyFromConversationMs: elapsedFromConversation(
      bridge.providerSessionReadyAtMs,
    ),
  };
}
