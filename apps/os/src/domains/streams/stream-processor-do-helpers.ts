// Shared plumbing for Durable Objects that host stream processors — the two
// rituals every such DO repeats (SlackIntegrationDurableObject pioneered
// them; the integrations/secrets domain objects share them from here).

import { NotInitializedError } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { InitializedStreamStub } from "~/domains/streams/stream-runtime.ts";

/**
 * Wake-or-adopt: a DO reached by plain getByName (a stream subscription dial,
 * a sibling Secret resolving a derivation source) may not have been through
 * initialize() yet — adopt the runtime name as the structured name.
 */
export async function ensureStartedOrInitializeFromRuntimeName<Params>(host: {
  ensureStarted(): Promise<Params>;
  getDurableObjectName(): string | null | undefined;
  initialize(input: { name: string }): Promise<Params>;
}): Promise<Params> {
  try {
    return await host.ensureStarted();
  } catch (error) {
    if (!(error instanceof NotInitializedError)) throw error;
    const runtimeName = host.getDurableObjectName();
    if (runtimeName == null) throw error;
    return await host.initialize({ name: runtimeName });
  }
}

/**
 * Wait for a processor's checkpoint to reach the newest CONSUMED event — the
 * checkpoint only advances on delivered (consumed-type) events, so the
 * catch-up target is not the stream head.
 */
export async function waitForProcessorCatchUp(input: {
  consumes: readonly string[];
  snapshot(): Promise<{ offset: number }>;
  stream: InitializedStreamStub;
  timeoutMs?: number;
}): Promise<void> {
  const consumedTypes = new Set<string>(input.consumes);
  const events = await input.stream.history({ before: "end" });
  const maxConsumedOffset =
    events.filter((event) => consumedTypes.has(event.type)).at(-1)?.offset ?? 0;
  const deadline = Date.now() + (input.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    if ((await input.snapshot()).offset >= maxConsumedOffset) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
