// The in-memory itxEnv seam shared by the connect-flow / connection-status /
// repo-link unit suites: STREAM as a map of append-only journals (idempotency
// keys honored, per-CALL append batches recorded so atomicity is assertable)
// and SECRET as a map of explicitly created, merge-updated records. Tests mock `../../env.ts`
// with these bindings via vi.hoisted:
//
//   const network = await vi.hoisted(async () => {
//     const { createFakeItxEnv } = await import("../../test/fake-itx-env.ts");
//     return createFakeItxEnv();
//   });
//   vi.mock("../../env.ts", () => ({ itxEnv: { STREAM: network.STREAM, ... } }));
//
// (The dynamic import is required: vi.hoisted runs before static imports are
// initialized.) This is deliberately a WORKER-BINDING fake — getByName plus
// the few DO methods the flows call — not the itx Stream interface;
// MemoryStream in domains/streams/test-helpers.ts plays that role.

type FakeStreamEvent = {
  createdAt: string;
  idempotencyKey?: string;
  offset: number;
  payload: unknown;
  type: string;
};

type FakeSecretRecord = {
  egress?: { urls: string[] };
  material?: unknown;
  refresh?: unknown;
};

export function createFakeItxEnv(options?: {
  /** Failure injection, called per event before it is stored — throw to
   * simulate a Stream DO refusing exactly that append. */
  onAppend?: (input: { event: { payload: unknown; type: string }; name: string }) => void;
}) {
  const streams = new Map<string, FakeStreamEvent[]>();
  /** One entry per append CALL: which stream, which event types — so tests
   * can assert atomicity (e.g. a steal's [unclaim, claim] committing as one
   * directory append, never two). */
  const appendBatches: Array<{ name: string; types: string[] }> = [];
  /** Every getEvents input, raw — so tests can assert reads stay filtered
   * (e.g. lifecycle-fact reads never page a webhook-heavy journal). */
  const getEventsCalls: Array<{
    afterOffset?: number;
    beforeOffset?: number;
    eventTypes?: readonly string[];
    limit?: number;
    order?: "asc" | "desc";
  }> = [];
  const secrets = new Map<string, FakeSecretRecord>();
  /** Shift-and-run before each secret write — the seam for injecting a
   * concurrent actor exactly between claim-check and record. */
  const secretUpdateHooks: Array<() => Promise<void>> = [];

  function streamEvents(name: string): FakeStreamEvent[] {
    let events = streams.get(name);
    if (!events) {
      events = [];
      streams.set(name, events);
    }
    return events;
  }

  return {
    SECRET: {
      getByName(name: string) {
        return {
          async create(input: FakeSecretRecord) {
            await secretUpdateHooks.shift()?.();
            if (!secrets.has(name)) secrets.set(name, input);
          },
          async describe() {
            return { created: secrets.has(name) };
          },
          async update(input: FakeSecretRecord) {
            await secretUpdateHooks.shift()?.();
            if (!secrets.has(name)) {
              throw new Error(`secret has not been created: ${name}`);
            }
            // Merge, like the Secret DO: material/egress/refresh are separate
            // fields and an egress-only brick must not erase the material.
            secrets.set(name, { ...secrets.get(name), ...input });
          },
        };
      },
    },
    STREAM: {
      getByName(name: string) {
        const stored = streamEvents(name);
        async function append(
          ...inputs: Array<{ idempotencyKey?: string; payload: unknown; type: string }>
        ) {
          appendBatches.push({ name, types: inputs.map((input) => input.type) });
          return inputs.map((input) => {
            options?.onAppend?.({ event: input, name });
            const existing =
              input.idempotencyKey === undefined
                ? undefined
                : stored.find((event) => event.idempotencyKey === input.idempotencyKey);
            if (existing) return existing;
            const event: FakeStreamEvent = {
              ...input,
              createdAt: new Date().toISOString(),
              offset: stored.length + 1,
            };
            stored.push(event);
            return event;
          });
        }
        return {
          async append(
            ...inputs: Array<{ idempotencyKey?: string; payload: unknown; type: string }>
          ) {
            return append(...inputs);
          },
          async appendAck(
            ...inputs: Array<{ idempotencyKey?: string; payload: unknown; type: string }>
          ) {
            await append(...inputs);
          },
          async getEvents(
            input: {
              afterOffset?: number;
              beforeOffset?: number;
              eventTypes?: readonly string[];
              limit?: number;
              order?: "asc" | "desc";
            } = {},
          ) {
            getEventsCalls.push(input);
            const { afterOffset = 0, beforeOffset = Infinity, eventTypes, limit = 500 } = input;
            const matches = stored.filter(
              (event) =>
                event.offset > afterOffset &&
                event.offset < beforeOffset &&
                (eventTypes === undefined || eventTypes.includes(event.type)),
            );
            if (input.order === "desc") matches.reverse();
            return matches.slice(0, limit);
          },
          async head() {
            return { maxOffset: stored.length };
          },
          async runtimeState() {
            return { coreProcessorState: { maxOffset: stored.length } };
          },
        };
      },
    },
    appendBatches,
    getEventsCalls,
    secrets,
    secretUpdateHooks,
    streams,
    seedStream(name: string, ...events: Array<{ payload: unknown; type: string }>) {
      const stored = streamEvents(name);
      for (const event of events) {
        stored.push({ ...event, createdAt: new Date().toISOString(), offset: stored.length + 1 });
      }
    },
    reset() {
      streams.clear();
      secrets.clear();
      appendBatches.length = 0;
      getEventsCalls.length = 0;
      secretUpdateHooks.length = 0;
    },
  };
}
