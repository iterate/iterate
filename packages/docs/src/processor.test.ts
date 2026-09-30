import { expect, test, vi } from "vitest";
import * as Y from "yjs";
import { ProcessorEngine, type StreamEventInput } from "iterate/stream/processor";
import {
  memoryStorage,
  memoryStream,
  nodeSqliteDurableObjectStorage,
} from "iterate/stream/test-support";
import { quoteAt } from "./anchor.ts";
import {
  COMMENT_ADDED,
  COMMENT_DELETED,
  COMMENT_EDITED,
  COMMENT_REPLIED,
  COMMENT_RESOLVED,
} from "./comments.ts";
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
  expect(await doc.live()).toMatchObject({ commitOid: doc.repo.latest().oid, dirty: false });
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

test("a commit deleting a doc with unsaved edits in it: the save writes it back, edits and all", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n" }, { autosave: { idleMs: 60_000, maxMs: 60_000 } });
  const misha = await doc.join("misha@iterate.com");
  misha.type(misha.text().length, "Unsaved.\n");
  await vi.waitFor(async () => expect(await doc.live()).toMatchObject({ dirty: true }));

  doc.repo.deleteElsewhere("plan.md");
  doc.notice();
  misha.leave();

  await vi.waitFor(() =>
    expect(doc.repo.latest()).toMatchObject({ files: { "plan.md": "# Plan\nUnsaved.\n" } }),
  );
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
  await vi.waitFor(async () => expect(await doc.live()).toMatchObject({ dirty: true }));

  const jonas = await doc.join("jonas@iterate.com");
  expect(jonas.text()).toBe("# Plan\nUnsaved.\n");
});

test("a facet reset loses nothing: the next incarnation has the unsaved text and saves it", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n" }, { autosave: { idleMs: 60_000, maxMs: 60_000 } });
  const misha = await doc.join("misha@iterate.com");
  misha.type(misha.text().length, "Before the reset.\n");
  await vi.waitFor(async () => expect(await doc.live()).toMatchObject({ dirty: true }));

  const next = doc.restart({ autosave: { idleMs: 5, maxMs: 20 } });
  await next.engine.revive();
  await vi.waitFor(() =>
    expect(doc.repo.latest()).toMatchObject({
      files: { "plan.md": "# Plan\nBefore the reset.\n" },
      author: { email: "misha@iterate.com" },
    }),
  );
});

test("people comment, reply and resolve, an agent replies for one of them, and only a comment's author edits or deletes it", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n\nWe fly in on Tuesday.\n" });
  const misha = await doc.join("misha@iterate.com");
  const jonas = await doc.join("jonas@iterate.com");
  const text = misha.text();
  const at = text.indexOf("Tuesday");

  misha.append(COMMENT_ADDED, {
    thread: "t1",
    quote: quoteAt(text, at, at + "Tuesday".length),
    body: "Wednesday?",
  });
  // Jonas's Claude Code, over MCP: a script run for Jonas, which calls as the project's code
  doc.appendAsScriptFor("jonas@iterate.com", COMMENT_REPLIED, {
    thread: "t1",
    comment: "c2",
    body: "Flights are cheaper.",
    via: "Claude Code",
  });
  // not his comment: ignored
  jonas.append(COMMENT_EDITED, { thread: "t1", comment: "t1", body: "Thursday?" });
  misha.append(COMMENT_EDITED, { thread: "t1", comment: "t1", body: "Wednesday, surely?" });
  jonas.append(COMMENT_RESOLVED, { thread: "t1" });
  misha.append(COMMENT_ADDED, { thread: "t2", quote: null, body: "Who's booking?" });
  misha.append(COMMENT_DELETED, { thread: "t2", comment: "t2" });

  await vi.waitFor(async () =>
    expect(await doc.live()).toMatchObject({
      threads: [
        {
          id: "t1",
          quote: { exact: "Tuesday" },
          detached: false,
          resolved: { by: "jonas@iterate.com" },
          comments: [
            { author: "misha@iterate.com", via: null, body: "Wednesday, surely?", edited: true },
            { author: "jonas@iterate.com", via: "Claude Code", body: "Flights are cheaper." },
          ],
        },
      ],
    }),
  );
});

test("a typo fixed under a comment keeps the comment, and a deleted sentence detaches it", async () => {
  const doc = openDoc({
    "plan.md": "The hotle is booked for three nights near the station.\n\nBring a coat.\n",
  });
  const misha = await doc.join("misha@iterate.com");
  const text = misha.text();
  const quote = (part: string) =>
    quoteAt(text, text.indexOf(part), text.indexOf(part) + part.length);
  misha.append(COMMENT_ADDED, { thread: "typo", quote: quote("hotle"), body: "Which one?" });
  misha.append(COMMENT_ADDED, {
    thread: "coat",
    quote: quote("Bring a coat."),
    body: "It's July.",
  });
  await vi.waitFor(async () => expect(await doc.live()).toMatchObject({ threads: [{}, {}] }));

  misha.fix("hotle", "hotel");
  misha.fix("Bring a coat.\n", "");

  await vi.waitFor(() =>
    expect(doc.repo.latest().files["plan.md"]).toBe(
      "The hotel is booked for three nights near the station.\n\n",
    ),
  );
  await vi.waitFor(async () =>
    expect(await doc.live()).toMatchObject({
      threads: [
        { id: "typo", quote: { exact: "hotel", prefix: "The " }, detached: false },
        { id: "coat", quote: { exact: "Bring a coat." }, detached: true },
      ],
    }),
  );
});

test("a reply on a doc whose processor has just started again still shows the doc as saved", async () => {
  const doc = openDoc({ "plan.md": "# Plan\n" });
  const misha = await doc.join("misha@iterate.com");
  misha.append(COMMENT_ADDED, { thread: "t1", quote: null, body: "Looks good?" });
  await vi.waitFor(async () => expect(await doc.live()).toMatchObject({ threads: [{}] }));
  // a new incarnation (a new build of the config, an eviction): nothing has loaded the doc yet
  doc.restart({ autosave: { idleMs: 5, maxMs: 20 } });

  const [reply] = await misha.append(COMMENT_REPLIED, {
    thread: "t1",
    comment: "c2",
    body: "Yes.",
  });

  // as the page sees it: the live state the push published, not a read that catches up first
  await doc.engine.waitUntilProcessed({ offset: reply!.offset });
  expect(await doc.live()).toMatchObject({
    commitOid: doc.repo.latest().oid,
    dirty: false,
    threads: [{ comments: [{ body: "Looks good?" }, { body: "Yes." }] }],
  });
});

test("the root's docs processor tells only the opened docs a commit changed", async () => {
  const root = memoryStream("/");
  const noticed: { path: string; event: StreamEventInput }[] = [];
  const docs = new DocsProcessor(
    () =>
      ({
        cd: (path: string) => ({
          append: (event: StreamEventInput) => noticed.push({ path, event }),
        }),
        [Symbol.dispose]: () => {},
      }) as any,
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
  // the engine's checkpoint outlives an incarnation, as the facet's storage does
  const checkpoints = memoryStorage();
  const start = (autosave: { idleMs: number; maxMs: number }) => {
    const processor = new DocProcessor({
      sql: storage.sql as unknown as SqlStorage,
      getItx: () =>
        ({
          whoami: () => ({ path: "/docs/config/plan.md" }),
          // the repos are the root's, as on the platform
          cd: (path: string) => {
            if (path !== "/") throw new Error(`only the root has repos, not ${path}`);
            return { repos: { get: () => repo } };
          },
          append: log.stream.append,
          [Symbol.dispose]: () => {},
        }) as any,
      publishLiveState: () => engine.publishLiveState(),
      autosave,
    });
    const engine = new ProcessorEngine(processor, { stream: log.stream, storage: checkpoints });
    log.engines.splice(0, log.engines.length, engine);
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
    live: async () => (await current.engine.liveSnapshot()).state,
    restart: (next: { autosave: { idleMs: number; maxMs: number } }) =>
      (current = start(next.autosave)),
    get engine() {
      return current.engine;
    },
    /** What a `run` script appends for `email` (core/os on-behalf-of.ts): no principal, the person
     *  it runs for in `onBehalfOf`. */
    appendAsScriptFor: (email: string, type: string, payload: Record<string, unknown>) =>
      log.stream.append({
        type,
        payload,
        source: { onBehalfOf: { principal: { actor: email, email }, run: "/@1" } },
      }),
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
      const text = () => browser.getText("file").toString();
      return {
        text,
        type: (at: number, insert: string) => browser.getText("file").insert(at, insert),
        /** Replace the first `from` with `to`, as someone selecting it and typing would. */
        fix: (from: string, to: string) => {
          const at = text().indexOf(from);
          browser.transact(() => {
            browser.getText("file").delete(at, from.length);
            browser.getText("file").insert(at, to);
          });
        },
        /** A durable event from this person, as the Docs app appends a comment. */
        append: (type: string, payload: Record<string, unknown>) =>
          log.stream.append({ type, payload, source: { principal: { actor: email, email } } }),
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
    deleteElsewhere: (path: string) => {
      const { [path]: _deleted, ...files } = repo.latest().files;
      commits.push({ oid: oid(commits.length), files, message: "deleted elsewhere" });
    },
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
