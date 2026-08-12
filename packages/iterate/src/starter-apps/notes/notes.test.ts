// The notes processor's executable spec, convergence edition: step scenarios
// on the generic harness (makeProcessorHarness — the REAL runner over a
// MemoryStream) with a fake workspace (in-memory file map + recorded
// commits) standing in for the itx workspace slice. Files are truth: the
// interesting assertions are what lands IN the file and in git, with the
// stream carrying obligations and settlements.
import { expect, test } from "vitest";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  type HarnessSubstrate,
} from "../../processors/testing.ts";
import { composeNoteFile, noteDisplayTitle, parseNoteFile } from "./frontmatter.ts";
import {
  NOTES_ANALYSIS_EXPIRY_MS,
  NOTES_COMMIT_DEBOUNCE_MS,
  NotesProcessor,
  NotesProcessorContract,
  type NotesAnalysis,
  type NotesProcessorContract as Contract,
  type NotesWorkspace,
} from "./processor.ts";

const NOTE_PATH = "/repos/notes/2026-08-12T15-01-20-841Z-x7ab.md";

function fakeWorkspace() {
  const files = new Map<string, string>();
  const commits: { message: string; scope: string }[] = [];
  let committed = new Map<string, string>();
  const workspace: NotesWorkspace = {
    readFile: async (path) => (files.has(path) ? files.get(path)! : null),
    writeFile: async (path, content) => void files.set(path, content),
    dirtyNotePaths: async () => {
      const dirty = new Set<string>();
      for (const [path, content] of files) {
        if (committed.get(path) !== content) dirty.add(path);
      }
      for (const path of committed.keys()) if (!files.has(path)) dirty.add(path);
      return [...dirty];
    },
    commit: async (input) => {
      commits.push(input);
      committed = new Map(files);
    },
  };
  return { files, commits, workspace };
}

function makeNotesHarness(input: {
  analyze: (text: string) => Promise<NotesAnalysis>;
  workspace: NotesWorkspace;
  substrate?: HarnessSubstrate;
}) {
  return makeProcessorHarness<Contract, NotesProcessor>({
    createProcessor: (deps) =>
      new NotesProcessor({
        ...deps,
        workspace: input.workspace,
        analyze: ({ text }) => input.analyze(text),
      }),
    path: "/workspaces/notes",
    substrate: input.substrate,
  });
}

const captured = (path: string) => ({
  type: "events.iterate.com/notes/captured" as const,
  idempotencyKey: `notes-captured-${path}`,
  payload: { path },
});

test("capture: analysis lands title/tags IN the file's frontmatter and settles", async () => {
  const { files, workspace } = fakeWorkspace();
  files.set(
    NOTE_PATH,
    composeNoteFile({ capturedAt: "2026-08-12T15:01:20.841Z" }, "desk at 76cm felt right"),
  );
  const h = makeNotesHarness({
    workspace,
    analyze: async (text) => ({
      title: `Title for: ${text}`,
      tags: ["reference"],
      processedBy: "fake",
    }),
  });
  await h.append(captured(NOTE_PATH));

  const note = parseNoteFile(files.get(NOTE_PATH)!);
  expect(note.frontmatter).toMatchObject({
    capturedAt: "2026-08-12T15:01:20.841Z", // preserved
    title: "Title for: desk at 76cm felt right",
    tags: ["reference"],
  });
  expect(note.body).toBe("desk at 76cm felt right");
  expect(h.events("events.iterate.com/notes/analysis-settled")).toMatchObject([
    { payload: { path: NOTE_PATH, result: { status: "succeeded", processedBy: "fake" } } },
  ]);
  expect(h.state().pendingAnalyses).toEqual({});
});

test("re-read guard: a body edited mid-analysis settles superseded, file untouched", async () => {
  const { files, workspace } = fakeWorkspace();
  files.set(NOTE_PATH, composeNoteFile({}, "old text"));
  let releaseAnalysis!: (analysis: NotesAnalysis) => void;
  const h = makeNotesHarness({
    workspace,
    analyze: () => new Promise<NotesAnalysis>((resolve) => (releaseAnalysis = resolve)),
  });
  await h.append(captured(NOTE_PATH));

  // The user edits the FILE while the model call is in flight (no updated
  // event yet — the pure race the re-read guard exists for).
  files.set(NOTE_PATH, composeNoteFile({}, "new text"));
  releaseAnalysis({ title: "Title for old text", tags: [], processedBy: "fake" });
  await h.settle();

  expect(parseNoteFile(files.get(NOTE_PATH)!)).toMatchObject({
    frontmatter: {},
    body: "new text",
  });
  expect(h.events("events.iterate.com/notes/analysis-settled")).toMatchObject([
    { payload: { result: { status: "superseded", reason: "note body changed during analysis" } } },
  ]);
});

test("updated supersedes a hung obligation; the fresh one retitles from the new body", async () => {
  const { files, workspace } = fakeWorkspace();
  files.set(NOTE_PATH, composeNoteFile({}, "old text"));
  let hangFirst = true;
  const h = makeNotesHarness({
    workspace,
    analyze: async (text) => {
      if (hangFirst) {
        hangFirst = false;
        return new Promise(() => {});
      }
      return { title: `Title for: ${text}`, tags: [], processedBy: "fake" };
    },
  });
  await h.append(captured(NOTE_PATH));
  expect(Object.keys(h.state().pendingAnalyses)).toEqual([`${NOTE_PATH}:1`]);

  // The writer rewrote the file, then appended the fact — composer order.
  files.set(NOTE_PATH, composeNoteFile({}, "new text"));
  await h.append({ type: "events.iterate.com/notes/updated", payload: { path: NOTE_PATH } });

  expect(parseNoteFile(files.get(NOTE_PATH)!).frontmatter).toMatchObject({
    title: "Title for: new text",
  });
  expect(h.state().pendingAnalyses).toEqual({});
});

test("deleted drops the note's open obligation without settling it", async () => {
  const { files, workspace } = fakeWorkspace();
  files.set(NOTE_PATH, composeNoteFile({}, "delete me"));
  const h = makeNotesHarness({ workspace, analyze: () => new Promise(() => {}) });
  await h.append(captured(NOTE_PATH));
  expect(Object.keys(h.state().pendingAnalyses)).toEqual([`${NOTE_PATH}:1`]);

  files.delete(NOTE_PATH);
  await h.append({ type: "events.iterate.com/notes/deleted", payload: { path: NOTE_PATH } });
  expect(h.state().pendingAnalyses).toEqual({});
  expect(h.events("events.iterate.com/notes/analysis-settled")).toEqual([]);
});

test("commit lane: a burst of settled notes lands as ONE debounced commit, titled", async () => {
  const { files, workspace, commits } = fakeWorkspace();
  const second = "/repos/notes/2026-08-12T15-02-00-000Z-zz99.md";
  files.set(NOTE_PATH, composeNoteFile({}, "desk at 76cm"));
  files.set(second, composeNoteFile({}, "milk and eggs"));
  const h = makeNotesHarness({
    workspace,
    analyze: async (text) => ({ title: `Title for: ${text}`, tags: [], processedBy: "fake" }),
  });
  await h.append(captured(NOTE_PATH));
  await h.append(captured(second));
  expect(commits).toEqual([]); // debounce window still open

  await h.advanceTime(NOTES_COMMIT_DEBOUNCE_MS + 1_000);
  expect(commits).toHaveLength(1);
  expect(commits[0]).toMatchObject({ scope: "/repos/notes" });
  expect(commits[0]!.message).toMatch(/^notes: Title for: .+ \(\+1 more\)$/);

  // Everything committed → the next at-head pass finds a clean tree and
  // commits nothing more.
  await h.append(captured(NOTE_PATH)); // idempotency-deduped, but drives delivery
  await h.advanceTime(NOTES_COMMIT_DEBOUNCE_MS + 1_000);
  expect(commits).toHaveLength(1);
});

test("eviction mid-attempt: the revived incarnation restarts from the open obligation", async () => {
  const { files, workspace } = fakeWorkspace();
  files.set(NOTE_PATH, composeNoteFile({}, "survive eviction"));
  const calls: string[] = [];
  let hang = true;
  const substrateWorkspace = workspace;
  const h = makeNotesHarness({
    workspace: substrateWorkspace,
    analyze: async (text) => {
      calls.push(text);
      if (hang) return new Promise(() => {});
      return { title: "Recovered", tags: [], processedBy: "fake" };
    },
  });
  await h.append(captured(NOTE_PATH));
  expect(calls).toEqual(["survive eviction"]);

  h.crash();
  hang = false;
  // A new append is the production-real wake; the caught-up pass finds the
  // still-open obligation with an empty live-set and restarts it.
  await h.append({
    type: "events.iterate.com/notes/reanalyze-requested",
    payload: { path: NOTE_PATH },
  });
  await h.settle();
  expect(parseNoteFile(files.get(NOTE_PATH)!).frontmatter).toMatchObject({ title: "Recovered" });
  expect(h.state().pendingAnalyses).toEqual({});
});

test("expired obligation settles as failure without dialing the model or touching the file", async () => {
  const { files, workspace } = fakeWorkspace();
  files.set(NOTE_PATH, composeNoteFile({}, "goes stale"));
  const calls: string[] = [];
  const h = makeNotesHarness({
    workspace,
    analyze: async (text) => {
      calls.push(text);
      return new Promise(() => {});
    },
  });
  await h.append(captured(NOTE_PATH));
  expect(calls).toEqual(["goes stale"]);

  h.crash();
  // Jump the clock WITHOUT advanceTime (advancing fires a timely keepalive
  // revival that legitimately re-attempts): models "isolate gone, next wake
  // long past the horizon".
  h.clock.now += NOTES_ANALYSIS_EXPIRY_MS + 60_000;
  await h.append({
    type: "events.iterate.com/notes/captured",
    idempotencyKey: "notes-captured-second",
    payload: { path: "/repos/notes/2026-08-13T00-00-00-000Z-late.md" },
  });
  expect(calls.filter((text) => text === "goes stale")).toHaveLength(1);
  expect(h.events("events.iterate.com/notes/analysis-settled")).toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({
        path: NOTE_PATH,
        result: expect.objectContaining({ status: "failed" }),
      }),
    }),
  );
  expect(parseNoteFile(files.get(NOTE_PATH)!).frontmatter).toEqual({});
});

test("replay: a fresh instance re-executes no analysis, no writes, no commits", async () => {
  const { files, workspace } = fakeWorkspace();
  files.set(NOTE_PATH, composeNoteFile({}, "replay me"));
  const h = makeNotesHarness({
    workspace,
    analyze: async () => ({ title: "Once", tags: [], processedBy: "fake" }),
  });
  await h.append(captured(NOTE_PATH));
  const liveState = h.state();
  const liveEventCount = h.events().length;

  // Fresh progress over the SAME stream = full replay from offset 0. Every
  // dangerous dep THROWS so reaching one fails loudly; a clean tree makes
  // the commit lane a no-op.
  const replay = makeNotesHarness({
    analyze: async () => {
      throw new Error("replay must not re-dial the model");
    },
    workspace: {
      readFile: workspace.readFile,
      writeFile: async () => {
        throw new Error("replay must not write files");
      },
      dirtyNotePaths: async () => [],
      commit: async () => {
        throw new Error("replay must not commit");
      },
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

test("frontmatter round-trips, preserves foreign keys, and falls back on garbage", () => {
  const composed = composeNoteFile(
    { capturedAt: "2026-08-12T15:01:20.841Z", mood: "curious", tags: ["a"] },
    "the body\nwith two lines",
  );
  const parsed = parseNoteFile(composed);
  expect(parsed).toEqual({
    frontmatter: { capturedAt: "2026-08-12T15:01:20.841Z", mood: "curious", tags: ["a"] },
    body: "the body\nwith two lines",
  });
  // The analysis write-back shape: foreign keys survive.
  const rewritten = parseNoteFile(
    composeNoteFile({ ...parsed.frontmatter, title: "T" }, parsed.body),
  );
  expect(rewritten.frontmatter).toMatchObject({ mood: "curious", title: "T" });

  expect(parseNoteFile("no frontmatter here")).toEqual({
    frontmatter: {},
    body: "no frontmatter here",
  });
  expect(parseNoteFile("---\n: not yaml [\n---\nbody")).toMatchObject({ frontmatter: {} });
  expect(noteDisplayTitle(parseNoteFile("---\ntitle: Hi\n---\nbody"))).toBe("Hi");
  expect(noteDisplayTitle(parseNoteFile("\n\nfirst real line\nmore"))).toBe("first real line");
});
