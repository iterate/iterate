// Fresh voice-call startup benchmark. It holds one authenticated project
// WebSocket open, then measures distinct new stream paths over that connection.
//
// doppler run --config preview_17 -- pnpm cli voicelab startup --project prj_…
// doppler run --config preview_17 -- pnpm cli voicelab startup --project prj_… --runs 10 --audio
import crypto from "node:crypto";

import type { VoiceAgentRpc } from "@iterate-com/voice-agent";
import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import { z } from "zod";

import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { FRAME_BYTES, hasAudibleSignal, type StreamHandle } from "./probe-audio.ts";
import { closeAndDisposeRpcHandle, discardRpcResult } from "./rpc-ownership.ts";

/** Fields this benchmark reads from each selected voice event. Extra fields
 * are retained by the durable event protocol but are irrelevant here. */
const StartupVoicePayload = z.object({
  // Provider error/disconnect events identify only their conversation.
  activation: z.string().optional(),
  conversationId: z.string(),
  handshakeTookMs: z.number().optional(),
  message: z.string().optional(),
  pcm: z.string().optional(),
  reason: z.string().optional(),
  text: z.string().optional(),
});

const STARTUP_EVENTS = [
  "events.iterate.com/voice-agent/call-started",
  "events.iterate.com/voice-agent/conversation-accepted",
  "events.iterate.com/voice-agent/session-configured",
  "events.iterate.com/voice-agent/spk-frame",
  "events.iterate.com/voice-agent/provider-error",
  "events.iterate.com/voice-agent/provider-disconnected",
] as const;

/** Benchmark teardown is evidence-gathering, never an unbounded operation. */
const CLEANUP_TIMEOUT_MS = 1_000;

/** Options for `pnpm cli voicelab startup`. */
export interface StartupOptions extends VoicelabConnectOptions {
  /** Number of new stream paths to create over the one established project connection. */
  runs?: number;
  /** Prefix for the distinct, disposable stream paths. */
  streamPrefix?: string;
  /** Request a short answer after the session is configured and measure its first non-silent PCM frame. */
  audio?: boolean;
  /** Start the provider from setup's first stream batch; false measures the previous mic-trigger path. */
  activateOnSetup?: boolean;
  /** Fail if the provider has not configured a fresh session within this many milliseconds. */
  maxStartupMs?: number;
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve: resolve! };
}

function waitForEvent<T>(promise: Promise<T>, timeoutMs: number, description: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${description} within ${String(timeoutMs)}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * p;
  const lower = ordered[Math.floor(index)]!;
  return lower + (ordered[Math.ceil(index)]! - lower) * (index % 1);
}

function metric(values: Array<number | null>) {
  const measured = values.filter((value): value is number => value !== null);
  return {
    count: measured.length,
    min: measured.length === 0 ? null : Math.min(...measured),
    p50: percentile(measured, 0.5),
    p95: percentile(measured, 0.95),
    max: measured.length === 0 ? null : Math.max(...measured),
  };
}

type StartupWatch = {
  conversationId: string | null;
  callStartedMs: number | null;
  sessionConfiguredMs: number | null;
  conversationAcceptedMs: number | null;
  handshakeTookMs: number | null;
  /** Arrival at this subscriber, not speaker submission or physical audibility. */
  firstNonSilentPcmMs: number | null;
  errors: string[];
};

type StartupResult = StartupWatch & {
  streamPath: string;
  activation: string;
  setupStartedMs: number;
  setupResolvedMs: number | null;
  micAppendSentMs: number | null;
  micAppendAcknowledgedMs: number | null;
  commentaryAppendSentMs: number | null;
  commentaryAppendAcknowledgedMs: number | null;
  failure: string | null;
};

/**
 * Measures the stream setup which starts an OpenAI call. This deliberately
 * does not install source, create a project, or reveal a secret: those are
 * preparation operations rather than the latency on a button press.
 */
export async function startup(options: StartupOptions) {
  const runs = options.runs ?? 5;
  if (!Number.isInteger(runs) || runs < 1 || runs > 30) {
    throw new Error(`--runs must be an integer from 1 through 30; received ${String(runs)}`);
  }
  const maxStartupMs = options.maxStartupMs ?? 10_000;
  if (!Number.isFinite(maxStartupMs) || maxStartupMs <= 0) {
    throw new Error(`--max-startup-ms must be greater than zero; received ${String(maxStartupMs)}`);
  }
  const prefix = options.streamPrefix || `/agents/voice/startup-${Date.now().toString(36)}`;
  if (!prefix.startsWith("/"))
    throw new Error(`--stream-prefix must be absolute; received ${prefix}`);

  const projectSocketClosed = deferred<{ code: number; reason: string }>();
  // The installed voice capability is supplied by project source and is absent
  // from the static SDK type. Narrow to the surfaces this benchmark exercises.
  const itx = (await connectProject(options, {
    onWebSocketClose: ({ code, reason }) => projectSocketClosed.resolve({ code, reason }),
  })) as unknown as {
    voice: Pick<VoiceAgentRpc, "setupVoiceAgent">;
    streams: { get(path: string): StreamHandle };
    [Symbol.dispose](): void;
  };
  const activateOnSetup = options.activateOnSetup ?? true;
  const results: StartupResult[] = [];
  let projectSocketClose: { code: number; reason: string } | null = null;
  let projectSocketCloseFailure: string | null = null;
  try {
    for (let index = 1; index <= runs; index += 1) {
      const streamPath = `${prefix}/${String(index).padStart(2, "0")}-${crypto.randomUUID().slice(0, 8)}`;
      const stream = itx.streams.get(streamPath);
      const activation = crypto.randomUUID();
      const beganAt = Date.now();
      const clock = () => Date.now() - beganAt;
      const deadlineAt = beganAt + maxStartupMs;
      const configured = deferred<void>();
      const accepted = deferred<void>();
      const speaking = deferred<void>();
      const setupFailed = deferred<unknown>();
      const malformedEvent = deferred<Error>();
      const watch: StartupWatch = {
        conversationId: null,
        callStartedMs: null,
        sessionConfiguredMs: null,
        conversationAcceptedMs: null,
        handshakeTookMs: null,
        firstNonSilentPcmMs: null,
        errors: [],
      };
      const subscriptionState: { value: { close(): void } | null } = { value: null };
      let closing = false;
      const subscriptionResult = Promise.resolve(
        stream.openConnection({
          connectionKey: `voicelab-startup-${activation}`,
          // Setup races this RPC deliberately. Durable replay prevents a fast
          // initial `call-started` from being invisible to the subscriber.
          replayAfterOffset: 0,
          eventTypes: [...STARTUP_EVENTS],
          processEventBatch: (batch) => {
            for (const event of batch.events || []) {
              // StreamHandle erases event-specific payload types. Reject malformed
              // selected events instead of reporting a plausible startup timeout.
              const parsed = StartupVoicePayload.safeParse(event.payload);
              if (!parsed.success) {
                const failure = new Error(
                  `malformed ${event.type} payload: ${parsed.error.issues[0]?.message ?? parsed.error.message}`,
                );
                watch.errors.push(failure.message);
                malformedEvent.resolve(failure);
                continue;
              }
              const payload = parsed.data;
              if (event.type === "events.iterate.com/voice-agent/call-started") {
                if (payload.activation !== activation) continue;
                watch.conversationId = payload.conversationId;
                watch.callStartedMs ??= clock();
                continue;
              }
              if (
                payload.activation !== activation &&
                payload.conversationId !== watch.conversationId
              )
                continue;
              if (event.type === "events.iterate.com/voice-agent/session-configured") {
                watch.sessionConfiguredMs ??= clock();
                configured.resolve();
                continue;
              }
              if (event.type === "events.iterate.com/voice-agent/conversation-accepted") {
                watch.conversationAcceptedMs ??= clock();
                watch.handshakeTookMs ??= payload.handshakeTookMs ?? null;
                accepted.resolve();
                continue;
              }
              if (event.type === "events.iterate.com/voice-agent/provider-error") {
                watch.errors.push(payload.message || payload.text || "provider error");
                continue;
              }
              if (event.type !== "events.iterate.com/voice-agent/provider-disconnected") {
                if (event.type !== "events.iterate.com/voice-agent/spk-frame") continue;
                const pcm = payload.pcm || "";
                if (pcm === "" || !hasAudibleSignal(Buffer.from(pcm, "base64"))) continue;
                watch.firstNonSilentPcmMs ??= clock();
                speaking.resolve();
                continue;
              }
              watch.errors.push(payload.reason || "provider disconnected");
            }
          },
        }),
      ).then(
        (opened) => {
          if (closing) closeAndDisposeRpcHandle(opened);
          else subscriptionState.value = opened;
          return { opened, error: null };
        },
        (error: unknown) => ({ opened: null, error }),
      );
      const result: StartupResult = {
        streamPath,
        activation,
        setupStartedMs: clock(),
        setupResolvedMs: null,
        micAppendSentMs: null,
        micAppendAcknowledgedMs: null,
        commentaryAppendSentMs: null,
        commentaryAppendAcknowledgedMs: null,
        failure: null,
        ...watch,
      };
      let setup: Promise<{ error: unknown | null }> | null = null;
      try {
        setup = Promise.resolve(
          itx.voice.setupVoiceAgent({
            streamPath,
            instructions: "Speak supplied commentary briefly.",
            ...(activateOnSetup && { activation }),
          }),
        ).then(
          (setupResult) => {
            try {
              result.setupResolvedMs = clock();
              return { error: null };
            } finally {
              disposeIgnoredRpcResult(setupResult);
            }
          },
          (error: unknown) => {
            setupFailed.resolve(error);
            return { error };
          },
        );
        if (activateOnSetup) {
          // `conversation-accepted` is delivered by the active subscription, so
          // it proves the callback is receiving this stream even if the RPC which
          // returned its disposable connection handle still has bookkeeping to
          // finish. Do not place that tail on the microphone critical path.
          const acceptedOrSetupFailure = Promise.race([
            accepted.promise,
            setupFailed.promise.then((error) => Promise.reject(error)),
            malformedEvent.promise.then((error) => Promise.reject(error)),
            subscriptionResult.then(({ error }) =>
              error === null ? new Promise<never>(() => {}) : Promise.reject(error),
            ),
          ]);
          await waitForEvent(
            acceptedOrSetupFailure,
            Math.max(0, deadlineAt - Date.now()),
            "conversation-accepted did not arrive",
          );
        } else {
          const setupResult = await waitForEvent(
            setup,
            Math.max(0, deadlineAt - Date.now()),
            "voice-agent setup did not resolve",
          );
          if (setupResult.error !== null) throw setupResult.error;
        }
        result.micAppendSentMs = clock();
        await waitForEvent(
          discardRpcResult(
            stream.append({
              type: "events.iterate.com/voice-agent/mic-frame",
              ephemeral: true,
              payload: { activation, pcm: Buffer.alloc(FRAME_BYTES).toString("base64") },
            }),
          ),
          Math.max(0, deadlineAt - Date.now()),
          "microphone append did not resolve",
        );
        result.micAppendAcknowledgedMs = clock();
        const remainingMs = () => Math.max(0, deadlineAt - Date.now());
        if (options.audio === true) {
          result.commentaryAppendSentMs = clock();
          await waitForEvent(
            discardRpcResult(
              stream.append({
                type: "events.iterate.com/voice-agent/commentary",
                payload: { activation, delegationId: null, content: "Say: ready." },
              }),
            ),
            remainingMs(),
            "commentary append did not resolve",
          );
          result.commentaryAppendAcknowledgedMs = clock();
        }
        await waitForEvent(configured.promise, remainingMs(), "session-configured did not arrive");
        await waitForEvent(accepted.promise, remainingMs(), "conversation-accepted did not arrive");
        if (watch.conversationAcceptedMs === null || watch.conversationAcceptedMs > maxStartupMs) {
          throw new Error(
            `conversation-accepted exceeded ${String(maxStartupMs)}ms: ${String(watch.conversationAcceptedMs)}`,
          );
        }
        const opened = await waitForEvent(
          subscriptionResult,
          remainingMs(),
          "stream subscription did not resolve",
        );
        if (opened.error !== null) throw opened.error;
        const setupResult = await waitForEvent(
          setup,
          remainingMs(),
          "voice-agent setup did not resolve",
        );
        if (setupResult.error !== null) throw setupResult.error;
        if (options.audio === true) {
          await waitForEvent(
            speaking.promise,
            remainingMs(),
            "first non-silent PCM did not arrive",
          );
        }
      } catch (error) {
        result.failure = error instanceof Error ? error.message : String(error);
        watch.errors.push(result.failure);
      } finally {
        closing = true;
        const subscription = subscriptionState.value;
        if (subscription) closeAndDisposeRpcHandle(subscription);
        // This terminal is a durable activation fence: if setup is still queued,
        // its later call-started event is ignored; if a dial already exists, the
        // facet hangs it up. Never leave a late setup un-fenced.
        try {
          await waitForEvent(
            discardRpcResult(
              stream.append({
                type: "events.iterate.com/voice-agent/conversation-ended",
                payload: { activation, reason: "voicelab startup benchmark complete" },
              }),
            ),
            CLEANUP_TIMEOUT_MS,
            "terminal append did not resolve",
          );
        } catch (error) {
          watch.errors.push(
            `terminal cleanup: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        disposeIgnoredRpcResult(stream);
        Object.assign(result, watch);
        results.push(result);
        console.log(JSON.stringify({ type: "voicelab-startup-run", result }, null, 2));
      }
    }
  } finally {
    // trpc-cli calls process.exit() when this command resolves. Wait for the
    // requested close handshake so process exit cannot turn it into a loss.
    try {
      itx[Symbol.dispose]();
    } catch (error) {
      projectSocketCloseFailure =
        error instanceof Error ? error.message : `dispose failed: ${String(error)}`;
    }
    try {
      projectSocketClose = await waitForEvent(
        projectSocketClosed.promise,
        CLEANUP_TIMEOUT_MS,
        "project WebSocket close did not arrive",
      );
    } catch (error) {
      projectSocketCloseFailure ||= error instanceof Error ? error.message : String(error);
    }
    if (projectSocketClose?.code !== 1000) {
      projectSocketCloseFailure ||= `project WebSocket closed ${String(projectSocketClose?.code)}`;
    }
  }
  const summary = {
    project: options.project,
    connection: "one established authenticated project WebSocket for all runs",
    contract: {
      runs,
      streamPrefix: prefix,
      audio: options.audio === true,
      activateOnSetup,
      maxStartupMs,
    },
    results,
    teardown: {
      projectSocketClose,
      projectSocketCloseFailure,
    },
    metricsMs: {
      micAppendAcknowledged: metric(results.map((result) => result.micAppendAcknowledgedMs)),
      commentaryAppendAcknowledged: metric(
        results.map((result) => result.commentaryAppendAcknowledgedMs),
      ),
      setupResolved: metric(results.map((result) => result.setupResolvedMs)),
      callStarted: metric(results.map((result) => result.callStartedMs)),
      sessionConfigured: metric(results.map((result) => result.sessionConfiguredMs)),
      conversationAccepted: metric(results.map((result) => result.conversationAcceptedMs)),
      providerHandshake: metric(results.map((result) => result.handshakeTookMs)),
      // This is first non-silent PCM delivered to this process. It excludes
      // device buffering, DAC, speaker, and acoustic latency.
      firstNonSilentPcm: metric(results.map((result) => result.firstNonSilentPcmMs)),
    },
  };
  const failures = results.filter((result) => result.errors.length > 0);
  console.log(JSON.stringify(summary, null, 2));
  if (projectSocketCloseFailure) {
    throw new Error(`project WebSocket cleanup failed: ${projectSocketCloseFailure}`);
  }
  if (failures.length > 0)
    throw new Error(`${String(failures.length)} startup run(s) emitted provider diagnostics`);
}
