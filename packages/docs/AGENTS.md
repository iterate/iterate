# Working on docs, for agents

Docs (this package, and apps/docs) edits a project's files in the browser, several people at once.
You work on the same docs with the same moves the page makes: read the file, commit a change, and
append comment events. Each script below is an `async (itx) => …` for the platform's MCP `run`
tool, or any code holding a project `itx`.

A doc is a file in one of the project's repos, `/repos/<repo name>`. Its context is
`/docs/<repo name>/<path>`: `/repos/config`'s `tasks/q4.md` is `/docs/config/tasks/q4.md`. Its
comments are events there, never text in the file.

## Read a doc

```js
async (itx) => itx.repos.get("/repos/config").readFile("tasks/q4.md");
```

That's the last commit. People typing in the doc now have text the next save (within a minute)
commits; your commit merges with it either way.

## Edit a doc

Commit it, with the tip you read as `parent`. The doc's processor merges your commit into the open
editors as if you'd typed it, so change what you mean to change and leave the rest of the text as
it is. End the message with `Via: <your name>`, as you say `via` on a comment: the commit is the
person's who asked, committed by iterate, and this says which agent did the work.

```js
async (itx) => {
  const repo = itx.repos.get("/repos/config");
  const tip = await repo.tip();
  const text = await repo.readFile("tasks/q4.md", { commitOid: tip });
  const next = text.replace("ship by Friday", "ship by Monday");
  if (next === text) throw new Error("the text to change isn't there");
  return repo.commitFiles({
    message: "docs: tasks/q4.md, the ship date\n\nVia: Claude Code",
    parent: tip,
    changes: [{ path: "tasks/q4.md", content: next }],
  });
};
```

A refused commit means someone saved first: read the tip again and redo the change.

## Read a doc's comments

Once someone has opened the doc in Docs, its processor holds the threads:

```js
async (itx) =>
  (await itx.cd("/docs/config/tasks/q4.md").invoke("itx.facets.get('doc').liveSnapshot()")).state
    .threads;
```

Each thread: `id`, `quote` (what it's about, `null` for the whole doc), `detached` (its text is
gone), `resolved` (`{ by, at }` or `null`) and `comments` (`id`, `author`, `via`, `body`, `at`,
`edited`). For a doc no one has opened, read the events themselves:
`(await itx.cd("/docs/config/tasks/q4.md").readEvents(0, 500)).events`, the `docs/comment-*` ones.

## Comment

Append to the doc's context. A comment points at text by quoting it: the text as it is in the file
(markdown source), and up to 32 characters either side, which is how it finds the text again after
edits. Blank sides are fine; the quote then means the first place the text appears. Say which
agent you are in `via`: the page shows `jonas · Claude Code`.

```js
async (itx) => {
  const path = "tasks/q4.md";
  const text = await itx.repos.get("/repos/config").readFile(path);
  const exact = "ship by Friday";
  const at = text.indexOf(exact);
  if (at < 0) throw new Error("the text to comment on isn't there");
  const quote = {
    exact,
    prefix: text.slice(Math.max(0, at - 32), at),
    suffix: text.slice(at + exact.length, at + exact.length + 32),
  };
  return itx.cd(`/docs/config/${path}`).append({
    type: "docs/comment-added",
    payload: { thread: crypto.randomUUID(), quote, body: "Still true?", via: "Claude Code" },
  });
};
```

`quote: null` comments on the whole doc. The other events, each appended the same way:

| type                    | payload                          |                                            |
| ----------------------- | -------------------------------- | ------------------------------------------ |
| `docs/comment-replied`  | `{ thread, comment, body, via }` | `comment`: a new id, `crypto.randomUUID()` |
| `docs/comment-edited`   | `{ thread, comment, body }`      | your own comment only                      |
| `docs/comment-deleted`  | `{ thread, comment }`            | your own only; a thread goes with its last |
| `docs/comment-resolved` | `{ thread }`                     | anyone's thread                            |
| `docs/comment-reopened` | `{ thread }`                     |                                            |

A thread's first comment's id is the thread's.

## Manners

- Reply on a thread with what you did, then resolve it if you did what it asked. Leave other
  people's open questions open.
- Edit by commit, comment by event: never write comments into the file.
