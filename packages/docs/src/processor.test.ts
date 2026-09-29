import { expect, test, vi } from "vitest";
import * as Y from "yjs";
import { ProcessorEngine, type StreamEventInput } from "iterate/stream/processor";
import {
  memoryStorage,
  memoryStream,
  nodeSqliteDurableObjectStorage,
} from "iterate/stream/test-support";
import {
  COMMIT_NOTICED,
  DOC_LEFT,
  DOC_OPENED,
  EDIT_FRAME,
  EditFrame,
  fromBase64,
  toBase64,
} from "./frames.ts";
import { DocProcessor } from "./processor.ts";
import { DocsProcessor } from "./root.ts";

test("two people's edits land in one autosave commit, the second as a co-author", async () => {
  // time for Jonas to see Misha's line and add his before the save
  const doc = openDoc({ "plan.md": "# Plan\n" }, { autosave: { idleMs: 200, maxMs: 1000 } });
  const misha = await doc.join("misha@iterate.com");
  const jonas = await doc.join("jonas@iterate.com");
  misha.type(misha.text().length, "Misha's line.\n");
  await vi.waitFor(() => expect(jonas.text()).toBe("# Plan\nMisha's line.\n"));
  jonas.type(jonas.text().length, "Jonas's line.\n");

  await vi.waitFor(() =>
    expect(doc.repo.latest()).toMatchObject({
      files: { "plan.md": "# Plan\nMisha's line.\nJonas's line.\n" },
      author: { email: "misha@iterate.com" },
      message: "docs: edit plan.md\n\nCo-authored-by: jonas@iterate.com <jonas@iterate.com>",
    }),
  );
  expect(doc.live()).toMatchObject({ commitOid: doc.repo.latest().oid, dirty: false });
});

test("a commit made elsewhere merges into the live text, and every open editor gets it", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n\nWe fly in on Tuesday.\n\n## Agenda\n" });
  const misha = await doc.join("misha@iterate.com");
  // Misha is typing under Agenda while an agent rewords the date and commits
  misha.type(misha.text().length, "- Retro\n");
  doc.repo.commitElsewhere("plan.md", "# Plan\n\nWe fly in on Wednesday.\n\n## Agenda\n");
  doc.notice();

  const merged = "# Plan\n\nWe fly in on Wednesday.\n\n## Agenda\n- Retro\n";
  await vi.waitFor(() => expect(misha.text()).toBe(merged));
  await vi.waitFor(() => expect(doc.repo.latest().files["plan.md"]).toBe(merged));
});

test("a save the repo refuses because main moved takes the tip in and saves the merge on top", async () => {
  const doc = openDoc({ "plan.md": "one\ntwo\nthree\n" });
  const misha = await doc.join("misha@iterate.com");
  // an agent commits and no notice arrives: the save finds out
  doc.repo.commitElsewhere("plan.md", "one\ntwo\nthree\nfour\n");
  misha.type(0, "zero\n");

  await vi.waitFor(() =>
    expect(doc.repo.latest().files["plan.md"]).toBe("zero\none\ntwo\nthree\nfour\n"),
  );
  expect(doc.repo).toMatchObject({ refusals: 1 });
  await vi.waitFor(() => expect(misha.text()).toBe("zero\none\ntwo\nthree\nfour\n"));
});

test("the last person closing the doc saves it at once, not a minute later", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n" }, { autosave: { idleMs: 60_000, maxMs: 60_000 } });
  const misha = await doc.join("misha@iterate.com");
  const jonas = await doc.join("jonas@iterate.com");
  misha.type(misha.text().length, "Misha's line.\n");
  await vi.waitFor(() => expect(jonas.text()).toBe("# Plan\nMisha's line.\n"));
  jonas.type(jonas.text().length, "Jonas's line.\n");
  await vi.waitFor(() => expect(misha.text()).toBe("# Plan\nMisha's line.\nJonas's line.\n"));

  misha.leave();
  jonas.leave();
  await vi.waitFor(() =>
    expect(doc.repo.latest()).toMatchObject({
      files: { "plan.md": "# Plan\nMisha's line.\nJonas's line.\n" },
      author: { email: "misha@iterate.com" },
      message: "docs: edit plan.md\n\nCo-authored-by: jonas@iterate.com <jonas@iterate.com>",
    }),
  );
});

test("someone joining gets the live text, unsaved edits included", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n" }, { autosave: { idleMs: 60_000, maxMs: 60_000 } });
  const misha = await doc.join("misha@iterate.com");
  misha.type(misha.text().length, "Unsaved.\n");
  await vi.waitFor(() => expect(doc.live()).toMatchObject({ dirty: true }));

  const jonas = await doc.join("jonas@iterate.com");
  expect(jonas.text()).toBe("# Plan\nUnsaved.\n");
});

test("a facet reset loses nothing: the next incarnation has the unsaved text and saves it", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n" }, { autosave: { idleMs: 60_000, maxMs: 60_000 } });
  const misha = await doc.join("misha@iterate.com");
  misha.type(misha.text().length, "Before the reset.\n");
  await vi.waitFor(() => expect(doc.live()).toMatchObject({ dirty: true }));

  const next = doc.restart({ autosave: { idleMs: 5, maxMs: 20 } });
  await next.engine.revive();
  await vi.waitFor(() =>
    expect(doc.repo.latest()).toMatchObject({
      files: { "plan.md": "# Plan\nBefore the reset.\n" },
      author: { email: "misha@iterate.com" },
    }),
  );
});

test("the root's docs processor tells only the opened docs a commit changed", async () => {
  const root = memoryStream("/");
  const noticed: { path: string; event: StreamEventInput }[] = [];
  const docs = new DocsProcessor((call) =>
    Promise.resolve(
      call({
        cd: (path: string) => ({
          append: (event: StreamEventInput) => noticed.push({ path, event }),
        }),
      } as any),
    ),
  );
  root.engines.push(new ProcessorEngine(docs, { stream: root.stream, storage: memoryStorage() }));
  root.stream.append(
    { type: DOC_OPENED, payload: { repo: "/repos/config", path: "plan.md" } },
    { type: DOC_OPENED, payload: { repo: "/repos/config", path: "notes/retro.md" } },
    commitCompleted("/repos/config", "c1", ["plan.md", "never-opened.md"]),
    // the same path in another repo is another doc
    commitCompleted("/repos/docs", "c2", ["plan.md"]),
    commitCompleted("/repos/config", "c3", ["notes/retro.md"]),
  );

  await vi.waitFor(() =>
    expect(noticed).toEqual([
      {
        path: "/docs/config/plan.md",
        event: expect.objectContaining({ type: COMMIT_NOTICED, payload: { commitOid: "c1" } }),
      },
      {
        path: "/docs/config/notes/retro.md",
        event: expect.objectContaining({ type: COMMIT_NOTICED, payload: { commitOid: "c3" } }),
      },
    ]),
  );
});

// ── fixtures ──

/** One doc's context: its log, its processor over a real engine and node:sqlite, and a fake
 *  repo that refuses a stale parent the way the repo facet does. `join` is a browser: its
 *  own Y.Doc, synced like the Docs app's (`sync`, then edit frames both ways). */
function openDoc(
  files: Record<string, string>,
  options: { autosave: { idleMs: number; maxMs: number } } = { autosave: { idleMs: 5, maxMs: 20 } },
) {
  const log = memoryStream("/docs/config/plan.md");
  const repo = fakeRepo(files);
  const storage = nodeSqliteDurableObjectStorage();
  let liveState: () => unknown = () => null;
  const start = (autosave: { idleMs: number; maxMs: number }) => {
    const processor = new DocProcessor({
      sql: storage.sql as unknown as SqlStorage,
      withItx: (call) =>
        Promise.resolve(
          call({
            whoami: () => ({ path: "/docs/config/plan.md" }),
            // the repos are the root's, as on the platform
            cd: (path: string) => {
              if (path !== "/") throw new Error(`only the root has repos, not ${path}`);
              return { repos: { get: () => repo } };
            },
            append: log.stream.append,
          } as any),
        ),
      publishLiveState: () => {},
      autosave,
    });
    const engine = new ProcessorEngine(processor, { stream: log.stream, storage: memoryStorage() });
    log.engines.splice(0, log.engines.length, engine);
    liveState = () => processor.projectLiveState();
    return { processor, engine };
  };
  let current = start(options.autosave);
  const browsers: Y.Doc[] = [];
  // every edit frame on the log reaches every browser, as the Docs app's subscription does
  const deliver = (event: { type: string; payload?: unknown }) => {
    if (event.type !== EDIT_FRAME) return;
    const frame = EditFrame.parse(event.payload);
    for (const browser of browsers)
      if (frame.client !== browser.clientID)
        Y.applyUpdate(browser, fromBase64(frame.update), "remote");
  };
  const append = log.stream.append;
  log.stream.append = (...events) => {
    const committed = append(...events);
    void Promise.resolve(committed).then((landed) => landed.forEach(deliver));
    return committed;
  };
  return {
    repo,
    live: () => liveState(),
    restart: (next: { autosave: { idleMs: number; maxMs: number } }) =>
      (current = start(next.autosave)),
    get engine() {
      return current.engine;
    },
    /** What the root's docs processor appends when a commit changed the doc. */
    notice: () =>
      log.stream.append({ type: COMMIT_NOTICED, ephemeral: true, payload: { commitOid: "?" } }),
    async join(email: string) {
      const browser = new Y.Doc();
      const synced = await current.processor.sync(
        toBase64(Y.encodeStateVector(browser)),
        browser.clientID,
      );
      Y.applyUpdate(browser, fromBase64(synced.update), "remote");
      browsers.push(browser);
      browser.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === "remote") return;
        log.stream.append({
          type: EDIT_FRAME,
          ephemeral: true,
          payload: { update: toBase64(update), client: browser.clientID },
          source: { principal: { actor: email, email } },
        });
      });
      return {
        text: () => browser.getText("file").toString(),
        type: (at: number, text: string) => browser.getText("file").insert(at, text),
        leave: () =>
          log.stream.append({
            type: DOC_LEFT,
            ephemeral: true,
            payload: { client: browser.clientID },
          }),
      };
    },
  };
}

type Commit = {
  oid: string;
  files: Record<string, string>;
  message: string;
  author?: { name: string; email: string };
};

function fakeRepo(files: Record<string, string>) {
  const commits: Commit[] = [{ oid: oid(0), files, message: "first" }];
  const repo = {
    refusals: 0,
    latest: () => commits.at(-1)!,
    tip: async () => repo.latest().oid,
    readFile: async (path: string, options: { commitOid: string }) =>
      commits.find((commit) => commit.oid === options.commitOid)?.files[path] ?? null,
    commitFiles: async (input: {
      message: string;
      changes: { path: string; content: string }[];
      parent: string | null;
      author?: { name: string; email: string };
    }) => {
      if (input.parent !== repo.latest().oid) {
        repo.refusals += 1;
        throw new Error(`the commit was refused: main is at ${repo.latest().oid}`);
      }
      const next = { ...repo.latest().files };
      for (const change of input.changes) next[change.path] = change.content;
      commits.push({
        oid: oid(commits.length),
        files: next,
        message: input.message,
        author: input.author,
      });
      return {
        commitOid: repo.latest().oid,
        changedPaths: input.changes.map((change) => change.path),
      };
    },
    commitElsewhere: (path: string, content: string) =>
      commits.push({
        oid: oid(commits.length),
        files: { ...repo.latest().files, [path]: content },
        message: "elsewhere",
      }),
  };
  return repo;
}

const oid = (n: number) => n.toString(16).padStart(40, "0");

function commitCompleted(path: string, commitOid: string, changedPaths: string[]) {
  return {
    type: "events.iterate.com/repo/commit-completed",
    payload: { path, commitOid, message: "m", changedPaths },
  };
}
