// Preview-only direct voice host: exercise the narrow treatment boundary and
// prove its inherited ProcessorFacet state belongs to the hosted child context.
// ProcessorFacet's workerd lifecycle/alarm semantics and VoiceAgentProcessor's
// terminal fence have dedicated suites; this pins the new placement only.

import { expect, test } from "vitest";
import { FACET_IDENTITY_KEY, type ProcessorFacetIdentity } from "iterate/processors/cloudflare";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  InlineVoiceProcessorHost,
  INLINE_VOICE_PROCESSOR_PREFIX,
  INLINE_VOICE_PROCESSOR_PROJECT_ID,
  INLINE_VOICE_PROCESSOR_SOURCE_PIN,
  INLINE_VOICE_PROCESSOR_SUBSCRIPTION,
  isInlineVoiceProcessorExperiment,
  isInlineVoiceProcessorTreatment,
} from "./inline-voice-processor-host.ts";

const PATH = `${INLINE_VOICE_PROCESSOR_PREFIX}call-a`;
const IDENTITY: ProcessorFacetIdentity = {
  parentName: DurableObjectNameCodec.stringify({
    projectId: INLINE_VOICE_PROCESSOR_PROJECT_ID,
    path: PATH,
  }),
  projectId: INLINE_VOICE_PROCESSOR_PROJECT_ID,
  path: PATH,
};

test("admits only the exact preview treatment and immutable voice source", () => {
  const treatment = {
    deploymentEnv: "preview_17",
    projectId: INLINE_VOICE_PROCESSOR_PROJECT_ID,
    path: PATH,
    subscriptionName: INLINE_VOICE_PROCESSOR_SUBSCRIPTION,
  } as const;
  expect(isInlineVoiceProcessorTreatment(treatment)).toBe(true);
  expect(isInlineVoiceProcessorTreatment({ ...treatment, deploymentEnv: "prd" })).toBe(false);
  expect(isInlineVoiceProcessorTreatment({ ...treatment, projectId: "prj_other" })).toBe(false);
  expect(isInlineVoiceProcessorTreatment({ ...treatment, path: "/agents/voice/ordinary" })).toBe(
    false,
  );
  expect(isInlineVoiceProcessorTreatment({ ...treatment, subscriptionName: "agent" })).toBe(false);

  const worker = {
    type: "stateful",
    path: PATH,
    className: "VoiceAgentFacet",
    durableWorkerKey: "voice-agent",
    source: {
      createWorker: {
        entryPoint: "voice-agent.ts",
        files: {
          type: "repo",
          repoPath: "/repos/config",
          ref: { commitOid: INLINE_VOICE_PROCESSOR_SOURCE_PIN },
        },
      },
    },
  };
  expect(isInlineVoiceProcessorExperiment({ path: PATH, worker: worker as never })).toBe(true);
  expect(
    isInlineVoiceProcessorExperiment({
      path: PATH,
      worker: { ...worker, className: "AgentFacet" } as never,
    }),
  ).toBe(false);
  expect(
    isInlineVoiceProcessorExperiment({
      path: PATH,
      worker: {
        ...worker,
        source: {
          createWorker: {
            ...worker.source.createWorker,
            files: {
              ...worker.source.createWorker.files,
              ref: { commitOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
            },
          },
        },
      } as never,
    }),
  ).toBe(false);
});

test("uses the hosted child storage view, restores its identity after reconstruction, and fences foreign wakes", async () => {
  const raw = context();
  const child = context();
  const parentAlarms = {
    proxyDeleteAlarm: async () => undefined,
    proxyGetAlarm: async () => null,
    proxySetAlarm: async () => undefined,
  };
  const options = {
    rawCtx: raw.ctx,
    streamCtx: child.ctx,
    env: environment(),
    identity: IDENTITY,
    parentAlarms,
  };
  const first = new InlineVoiceProcessorHost(options);
  first.configure(IDENTITY);

  // The base ProcessorFacet stashes identity through `this.ctx`; direct
  // placement replaces the raw child context with its hosted storage view.
  // These separate maps are only a wrong-context detector: production uses
  // views of the same hosted child, with its logical id and alarm overrides.
  expect(raw.values.get(FACET_IDENTITY_KEY)).toBeUndefined();
  expect(child.values.get(FACET_IDENTITY_KEY)).toEqual(IDENTITY);

  await expect(
    first.wakeStreamProcessor({
      name: INLINE_VOICE_PROCESSOR_SUBSCRIPTION,
      stream: {
        projectId: INLINE_VOICE_PROCESSOR_PROJECT_ID,
        path: `${INLINE_VOICE_PROCESSOR_PREFIX}foreign`,
        streamId: "11111111-1111-4111-8111-111111111111",
        streamMaxOffset: 0,
      },
    }),
  ).rejects.toThrow(/coordinate mismatch/);

  // A fresh incarnation receives a fresh raw context and the same hosted
  // child storage view. Its boot/configure path accepts the stored identity.
  const rebuilt = new InlineVoiceProcessorHost({ ...options, rawCtx: context().ctx });
  rebuilt.configure(IDENTITY);
  expect(child.values.get(FACET_IDENTITY_KEY)).toEqual(IDENTITY);

  await Promise.allSettled([...raw.work, ...child.work]);
});

test("rejects a malformed child identity before creating a processor host", () => {
  const raw = context();
  const child = context();
  expect(
    () =>
      new InlineVoiceProcessorHost({
        rawCtx: raw.ctx,
        streamCtx: child.ctx,
        env: environment(),
        identity: { ...IDENTITY, parentName: "wrong-parent" },
        parentAlarms: {
          proxyDeleteAlarm: async () => undefined,
          proxyGetAlarm: async () => null,
          proxySetAlarm: async () => undefined,
        },
      }),
  ).toThrow(/parent identity does not match/);
  expect(child.values).toEqual(new Map());
});

function environment(): Env {
  return {
    DEPLOYMENT_ENV: "preview_17",
    CF_VERSION_METADATA: { id: "inline-host-test" },
  } as unknown as Env;
}

function context() {
  const values = new Map<string, unknown>();
  const work: Promise<unknown>[] = [];
  const ctx = {
    storage: {
      kv: {
        get<T>(key: string): T | undefined {
          const value = values.get(key);
          return value === undefined ? undefined : structuredClone(value as T);
        },
        put(key: string, value: unknown): void {
          values.set(key, structuredClone(value));
        },
        delete(key: string): void {
          values.delete(key);
        },
      },
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      deleteAlarm: async () => undefined,
    },
    exports: {
      ProjectEgressEntrypoint: () => ({ fetch: async () => new Response(null, { status: 500 }) }),
    },
    waitUntil(promise: Promise<unknown>): void {
      work.push(promise);
    },
  } as unknown as DurableObjectState;
  return { ctx, values, work };
}

class InspectableInlineVoiceProcessorHost extends InlineVoiceProcessorHost {
  streamFor(identity: ProcessorFacetIdentity) {
    return this.createHost(identity).stream;
  }
}

test("local treatment routes processor reads and agent context appends through the hosted child", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const identity = inlineIdentity(`${INLINE_VOICE_PROCESSOR_PREFIX}local/call-a`);
  const host = new InspectableInlineVoiceProcessorHost({
    rawCtx: context().ctx,
    streamCtx: context().ctx,
    env: environment(),
    identity,
    invokeLocalStream: async (method, args) => {
      calls.push({ method, args });
      if (method === "getEvents")
        return [{ offset: 7, type: "events.iterate.com/voice-agent/created" }];
      return [];
    },
    parentAlarms: {
      proxyDeleteAlarm: async () => undefined,
      proxyGetAlarm: async () => null,
      proxySetAlarm: async () => undefined,
    },
  });
  const stream = host.streamFor(identity);
  const agentContext = {
    type: "events.iterate.com/agents/context-added",
    payload: { content: "The device said hello." },
  };

  await expect(stream.getEvents({ afterOffset: 6 })).resolves.toEqual([
    { offset: 7, type: "events.iterate.com/voice-agent/created" },
  ]);
  await expect(stream.append(agentContext as never)).resolves.toEqual([]);
  await expect(
    stream.appendIfStreamId({
      streamId: "11111111-1111-4111-8111-111111111111",
      events: [agentContext],
    }),
  ).resolves.toEqual([]);

  expect(calls).toEqual([
    { method: "getEvents", args: [{ afterOffset: 6 }] },
    { method: "append", args: [agentContext] },
    {
      method: "appendIfStreamId",
      args: [
        {
          streamId: "11111111-1111-4111-8111-111111111111",
          events: [agentContext],
        },
      ],
    },
  ]);
});

test("a failed local append rejects the processor operation instead of acknowledging it", async () => {
  const failure = new Error("hosted child append failed");
  const identity = inlineIdentity(`${INLINE_VOICE_PROCESSOR_PREFIX}local/failing-call`);
  const local = async (method: string): Promise<unknown> => {
    if (method === "append") throw failure;
    throw new Error(`unexpected local method ${method}`);
  };
  const host = new InspectableInlineVoiceProcessorHost({
    rawCtx: context().ctx,
    streamCtx: context().ctx,
    env: environment(),
    identity,
    invokeLocalStream: local,
    parentAlarms: {
      proxyDeleteAlarm: async () => undefined,
      proxyGetAlarm: async () => null,
      proxySetAlarm: async () => undefined,
    },
  });

  await expect(
    host.streamFor(identity).append({
      type: "events.iterate.com/agents/context-added",
      payload: { content: "must not be acknowledged" },
    } as never),
  ).rejects.toThrow(failure);
});

function inlineIdentity(path: string): ProcessorFacetIdentity {
  return {
    parentName: DurableObjectNameCodec.stringify({
      projectId: INLINE_VOICE_PROCESSOR_PROJECT_ID,
      path,
    }),
    projectId: INLINE_VOICE_PROCESSOR_PROJECT_ID,
    path,
  };
}
