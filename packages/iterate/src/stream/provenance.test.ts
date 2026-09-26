// stream/provenance.test.ts — whom a reader listens to, as table rows: the one predicate (`trusts`)
// and a contract's `trust` over it (`admits`), then the engine that applies it before every reduce.
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { memoryStorage, memoryStream, settle } from "./test-support.ts";
import {
  ProcessorEngine,
  StreamProcessor,
  admits,
  certifiesItself,
  defineProcessorContract,
  trusts,
  type EventSource,
  type ProcessEventArgs,
  type ReduceArgs,
  type StreamEvent,
  type TrustRule,
} from "./processor.ts";

const member = { actor: "user_1" };

const TRUSTS_ROWS: { here: string; source: EventSource; trusted: boolean }[] = [
  { here: "/agents/b", source: { origin: "/agents/b" }, trusted: true },
  { here: "/agents/b", source: { origin: "/agents" }, trusted: true },
  { here: "/agents/b", source: { origin: "/" }, trusted: true },
  { here: "/agents/b/sandbox", source: { origin: "/agents/b" }, trusted: true },
  { here: "/agents/b", source: { origin: "/agents/a/sandbox" }, trusted: false },
  { here: "/agents/b", source: { origin: "/agents/b/sandbox" }, trusted: false },
  { here: "/agents/bee", source: { origin: "/agents/b" }, trusted: false },
  { here: "/", source: { origin: "/repos/config" }, trusted: false },
  { here: "/agents/b", source: { origin: "/jail", principal: member }, trusted: true },
  { here: "/agents/b", source: { origin: "/jail", platform: true }, trusted: true },
];
test.for(TRUSTS_ROWS)(
  "trusted at $here, written from $source.origin (member: $source.principal, platform: $source.platform) → $trusted",
  ({ here, source, trusted }) => expect(trusts(here, source)).toBe(trusted),
);

const RULES: Record<string, TrustRule> = {
  // a user's words from anyone, anything else from the trusted
  "chat/said": (source, e) =>
    (e.payload as { role?: string }).role === "user" || trusts(e.path, source),
  "open/anything": "anyone",
  "account/fact": "platform",
};
const ADMITS_ROWS: { row: string; event: StreamEvent; admitted: boolean }[] = [
  {
    row: "an undeclared type from a sibling: refused (the default is trusted)",
    event: event("note/added", "/b", { origin: "/a" }),
    admitted: false,
  },
  {
    row: "an undeclared type from an ancestor: admitted",
    event: event("note/added", "/b/c", { origin: "/b" }),
    admitted: true,
  },
  {
    row: "a type open to anyone, from a sibling: admitted",
    event: event("open/anything", "/b", { origin: "/a" }),
    admitted: true,
  },
  {
    row: "the platform's type from a member: refused",
    event: event("account/fact", "/users/u", { origin: "/users/u", principal: member }),
    admitted: false,
  },
  {
    row: "the platform's type the platform wrote: admitted",
    event: event("account/fact", "/users/u", { origin: "/", platform: true }),
    admitted: true,
  },
  {
    row: "an unstamped event: refused (the platform stamps every event it commits)",
    event: event("note/added", "/b"),
    admitted: false,
  },
  {
    row: "an own rule — a user's words from a sibling: admitted",
    event: event("chat/said", "/b", { origin: "/a" }, { role: "user" }),
    admitted: true,
  },
  {
    row: "an own rule — an assistant's words from a sibling: refused",
    event: event("chat/said", "/b", { origin: "/a" }, { role: "assistant" }),
    admitted: false,
  },
  {
    row: "a core itx/* event from a sibling: admitted (the context refused a misplaced one at write)",
    event: event("events.iterate.com/itx/rewrite-rule-configured", "/b", { origin: "/a" }),
    admitted: true,
  },
  {
    row: "a repo's certificate on / from the repo itself: admitted (it certifies itself)",
    event: event(
      "events.iterate.com/repo/created",
      "/",
      { origin: "/repos/r" },
      { path: "/repos/r" },
    ),
    admitted: true,
  },
  {
    row: "a repo's certificate on / from anyone else: refused",
    event: event("events.iterate.com/repo/deleted", "/", { origin: "/x" }, { path: "/repos/r" }),
    admitted: false,
  },
];
test.for(ADMITS_ROWS)("admits: $row", ({ event, admitted }) =>
  expect(admits(event, RULES)).toBe(admitted),
);
test("admits: a contract's own word, `*` included, comes before the platform's first-party default", () => {
  const certificate = event(
    "events.iterate.com/repo/created",
    "/",
    { origin: "/repos/r" },
    { path: "/repos/r" },
  );
  expect(admits(certificate)).toBe(true);
  expect(admits(certificate, { "*": "platform" })).toBe(false);
});

test("certifiesItself: the writer is the path the event names", () => {
  const certificate = event("x/created", "/", { origin: "/agents/a" }, { path: "/agents/a" });
  expect(certifiesItself({ origin: "/agents/a" }, certificate)).toBe(true);
  expect(certifiesItself({ origin: "/agents/b" }, certificate)).toBe(false);
});

// THE ENGINE: an event the contract's trust refuses is neither folded nor acted on, and the skip is
// logged — on a push, a catch-up and a re-reduce alike.
test("the engine ignores an event from a writer the contract does not trust: not folded, not acted on, logged", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const mem = memoryStream("/agents/b");
  mem.stream.append(
    { type: "note/added", source: { origin: "/agents/b" } },
    { type: "note/added", source: { origin: "/agents/a/sandbox" } },
    { type: "note/added", source: { origin: "/", principal: member } },
  );
  const processor = new CountingProcessor();
  const engine = new ProcessorEngine(processor, { stream: mem.stream, storage: memoryStorage() });
  await engine.catchUpFromLog();
  await settle();
  expect(await engine.snapshot()).toMatchObject({ state: { heard: ["/agents/b", "/"] } });
  expect(processor).toMatchObject({ acted: [1, 3] });
  expect(warn).toHaveBeenCalledWith({
    event: "processor.untrusted-event-ignored",
    slug: "counting",
    type: "note/added",
    origin: "/agents/a/sandbox",
    offset: 2,
  });
});

const CountingContract = defineProcessorContract({
  slug: "counting",
  version: "1",
  description: "counts the notes it hears",
  stateSchema: z.object({ heard: z.array(z.string()).default([]) }),
  consumes: ["note/added"],
  emits: ["note/heard"],
});
class CountingProcessor extends StreamProcessor<{ heard: string[] }> {
  readonly contract = CountingContract;
  readonly acted: number[] = [];
  override reduce({ event, state }: ReduceArgs<{ heard: string[] }>) {
    return { heard: [...state.heard, event.source?.origin ?? "(unstamped)"] };
  }
  override processEvent({ event }: ProcessEventArgs<{ heard: string[] }>): undefined {
    if (event) this.acted.push(event.offset);
  }
}

function event(
  type: string,
  path: string,
  source?: EventSource,
  payload: Record<string, unknown> = {},
): StreamEvent {
  return { type, path, source, payload, offset: 1, createdAt: "2026-09-26T00:00:00.000Z" };
}
