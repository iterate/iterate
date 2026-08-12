// The notes processor's executable spec: step scenarios on the generic
// harness (makeProcessorHarness from iterate/processors/testing) — the REAL
// StreamProcessorRunner over a MemoryStream with production idempotency
// semantics. The analyze dep is faked per scenario; the stream is the
// assertion surface (every consequential outcome is an event).
import { expect, test } from "vitest";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  type HarnessSubstrate,
} from "../../processors/testing.ts";
import {
  NOTES_ANALYSIS_EXPIRY_MS,
  NotesProcessor,
  NotesProcessorContract,
  searchNotes,
  type NotesAnalysis,
  type NotesProcessorContract as Contract,
} from "./processor.ts";
import { analyzeNoteText } from "./analysis.ts";

function makeNotesHarness(input: {
  analyze: (text: string) => Promise<NotesAnalysis>;
  substrate?: HarnessSubstrate;
}) {
  return makeProcessorHarness<Contract, NotesProcessor>({
    createProcessor: (deps) =>
      new NotesProcessor({ ...deps, analyze: ({ text }) => input.analyze(text) }),
    path: "/notes",
    substrate: input.substrate,
  });
}

const captured = (noteKey: string, text: string) => ({
  type: "events.iterate.com/notes/captured" as const,
  idempotencyKey: `notes-captured-${noteKey}`,
  payload: { noteKey, text, attachments: [], capturedOnDeviceAt: null },
});

test("captured opens an analysis obligation and settles it with title/tags", async () => {
  const h = makeNotesHarness({
    analyze: async (text) => ({ title: `Title for: ${text}`, tags: ["idea"], processedBy: "fake" }),
  });
  await h.append(captured("n1", "prototype the notes composer"));

  expect(h.events("events.iterate.com/notes/analysis-settled")).toMatchObject([
    {
      payload: {
        noteKey: "n1",
        requestOffset: 1,
        result: {
          status: "succeeded",
          title: "Title for: prototype the notes composer",
          tags: ["idea"],
        },
      },
    },
  ]);
  expect(h.state()).toMatchObject({
    notes: { n1: { title: "Title for: prototype the notes composer", analysisError: "" } },
    pendingAnalyses: {},
  });
});

test("a failed analysis settles as failure and reanalyze-requested retries it", async () => {
  let attempts = 0;
  const h = makeNotesHarness({
    analyze: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("model unavailable");
      return { title: "Second time lucky", tags: [], processedBy: "fake" };
    },
  });
  await h.append(captured("n1", "flaky analysis"));
  expect(h.state()).toMatchObject({
    notes: { n1: { title: "", analysisError: "model unavailable" } },
    pendingAnalyses: {},
  });

  await h.append({
    type: "events.iterate.com/notes/reanalyze-requested",
    payload: { noteKey: "n1" },
  });
  expect(h.state()).toMatchObject({
    notes: { n1: { title: "Second time lucky", analysisError: "" } },
    pendingAnalyses: {},
  });
});

test("updated overlays text, supersedes the stale attempt, and re-earns the title", async () => {
  // The FIRST analysis hangs (its attempt is in flight when the edit lands);
  // later analyses answer from the text they were given.
  let hangFirst = true;
  const hung: { resolve: (analysis: NotesAnalysis) => void }[] = [];
  const h = makeNotesHarness({
    analyze: async (text) => {
      if (hangFirst) {
        hangFirst = false;
        return new Promise<NotesAnalysis>((resolve) => hung.push({ resolve }));
      }
      return { title: `Title for: ${text}`, tags: [], processedBy: "fake" };
    },
  });
  await h.append(captured("n1", "old text"));
  expect(Object.keys(h.state().pendingAnalyses)).toEqual(["n1:1"]);

  await h.append({
    type: "events.iterate.com/notes/updated",
    idempotencyKey: "notes-updated-n1-e1",
    payload: { noteKey: "n1", text: "new text" },
  });
  // The edit reset the garnish and the fresh obligation retitled from the
  // NEW text.
  expect(h.state()).toMatchObject({
    notes: { n1: { text: "new text", title: "Title for: new text" } },
    pendingAnalyses: {},
  });

  // The stale attempt (opened by the original capture) finally answers with
  // a title from the OLD text — its obligation was superseded, so the
  // settlement folds to a no-op instead of overlaying.
  hung[0]!.resolve({ title: "Title for: old text", tags: [], processedBy: "fake" });
  await h.settle();
  expect(h.state().notes.n1).toMatchObject({ title: "Title for: new text" });
});

test("deleted removes the note and drops its open obligation without settling it", async () => {
  // The analyze fake hangs forever — the obligation must stay open until the
  // delete drops it, proving deletion (not settlement) closed it.
  const h = makeNotesHarness({ analyze: () => new Promise(() => {}) });
  await h.append(captured("n1", "delete me"));
  expect(Object.keys(h.state().pendingAnalyses)).toEqual(["n1:1"]);

  await h.append({ type: "events.iterate.com/notes/deleted", payload: { noteKey: "n1" } });
  expect(h.state()).toMatchObject({ notes: {}, pendingAnalyses: {} });
  expect(h.events("events.iterate.com/notes/analysis-settled")).toEqual([]);
});

test("eviction mid-attempt: the revived incarnation restarts from the open obligation", async () => {
  const calls: string[] = [];
  let hang = true;
  const h = makeNotesHarness({
    analyze: async (text) => {
      calls.push(text);
      if (hang) return new Promise(() => {});
      return { title: "Recovered", tags: [], processedBy: "fake" };
    },
  });
  await h.append(captured("n1", "survive eviction"));
  expect(calls).toEqual(["survive eviction"]);
  expect(Object.keys(h.state().pendingAnalyses)).toEqual(["n1:1"]);

  h.crash();
  hang = false;
  // A new append is the production-real wake; the caught-up pass finds the
  // still-open obligation with an empty live-set and restarts it.
  await h.append(captured("n2", "the wake"));
  expect(calls).toContain("survive eviction");
  expect(h.state()).toMatchObject({
    notes: { n1: { title: "Recovered" }, n2: {} },
  });
  await h.settle();
  expect(h.state().pendingAnalyses).toEqual({});
});

test("expired obligation settles as failure without dialing the model", async () => {
  const calls: string[] = [];
  const h = makeNotesHarness({
    analyze: async (text) => {
      calls.push(text);
      return new Promise(() => {});
    },
  });
  await h.append(captured("n1", "goes stale"));
  expect(calls).toEqual(["goes stale"]);

  h.crash();
  // Jump the clock WITHOUT advanceTime: advancing would fire the keepalive
  // alarm at +10s virtual time, a timely revival that legitimately
  // re-attempts. Mutating the clock models "the isolate was gone and the
  // next wake arrived long past the horizon" — the append below is that wake.
  h.clock.now += NOTES_ANALYSIS_EXPIRY_MS + 60_000;
  await h.append(captured("n2", "fresh note"));
  expect(calls.filter((text) => text === "goes stale")).toHaveLength(1);
  expect(h.events("events.iterate.com/notes/analysis-settled")).toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        noteKey: "n1",
        result: expect.objectContaining({ status: "failed" }),
      }),
    }),
  );
});

test("replay: a fresh instance fed the full stream re-executes nothing and converges", async () => {
  const h = makeNotesHarness({
    analyze: async () => ({ title: "Once", tags: ["idea"], processedBy: "fake" }),
  });
  await h.append(captured("n1", "replay me"));
  await h.append({ type: "events.iterate.com/notes/deleted", payload: { noteKey: "n1" } });
  await h.append(captured("n2", "still here"));
  const liveState = h.state();
  const liveEventCount = h.events().length;

  // Fresh progress over the SAME stream = full replay from offset 0. A
  // dangerous analyze THROWS so reaching it fails loudly.
  const replay = makeNotesHarness({
    analyze: async () => {
      throw new Error("replay must not re-dial the model");
    },
    substrate: {
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(NotesProcessorContract),
    },
  });
  await replay.settle();
  expect(replay.events()).toHaveLength(liveEventCount);
  expect(replay.state()).toEqual(liveState);
});

test("searchNotes: every term must match title/text/filenames/tags, newest first", async () => {
  const h = makeNotesHarness({
    analyze: async (text) => ({
      title: text.includes("desk") ? "Standing desk height" : "Grocery list",
      tags: text.includes("desk") ? ["reference"] : ["shopping"],
      processedBy: "fake",
    }),
  });
  await h.append(captured("n1", "desk at 76cm"));
  await h.append(captured("n2", "milk, eggs, flour"));

  const state = h.state();
  expect(searchNotes(state, { q: "desk 76" }).map((note) => note.noteKey)).toEqual(["n1"]);
  expect(searchNotes(state, { q: "shopping" }).map((note) => note.noteKey)).toEqual(["n2"]);
  expect(searchNotes(state, {}).map((note) => note.noteKey)).toEqual(["n2", "n1"]);
  expect(searchNotes(state, { q: "desk shopping" })).toEqual([]);
});

test("analyzeNoteText parses a sloppy model answer defensively", async () => {
  const good = await analyzeNoteText(
    {
      run: async () => ({
        response:
          'Sure! Here you go: {"title": "  Desk height  ", "tags": ["Reference", "REF!!", 42]}',
      }),
    },
    { text: "desk at 76cm" },
  );
  expect(good).toMatchObject({ title: "Desk height", tags: ["reference", "ref"] });

  const garbage = await analyzeNoteText(
    { run: async () => ({ response: "no json here" }) },
    {
      text: "x",
    },
  );
  expect(garbage).toMatchObject({ title: "", tags: ["untagged"] });
});
