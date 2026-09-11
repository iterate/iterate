// A small Docs-in-userspace proof: Yjs is the document CRDT, while v4 supplies only the durable
// event stream, processor facet/live state, immutable repo revision, checking, building, and loading.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import * as Y from "yjs";
import { expect, test } from "vitest";
import { connectLiveState } from "../src/client/live-state-client.ts";
import { parse } from "../src/context/expression.ts";
import { append, expressionUrl, freshCtx, openItx, until } from "./support/client.ts";

type DocsLive = { documents: Record<string, { update: string; text: string }> };

const docsProcessor = (
  await transform(
    await readFile(
      fileURLToPath(new URL("../examples/docs/processor.ts", import.meta.url).href),
      "utf8",
    ),
    {
      loader: "ts",
      format: "esm",
      target: "es2022",
    },
  )
).code;

const yjsModule = async (): Promise<string> => {
  const result = await build({
    entryPoints: ["yjs"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
  });
  return result.outputFiles[0]!.text;
};

const processorSource = { "cap.js": docsProcessor, "yjs.js": await yjsModule() };

async function enableDocs(itx: any): Promise<void> {
  await itx.enableProcessor("docs", {
    source: processorSource,
    className: "DocsDurableObject",
    consumes: ["docs/update"],
  });
  // Establish the facet before browser sessions race their edits.
  await itx.invoke("itx.facets.get('docs').snapshot()");
}

const base64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return btoa(text);
};

const updateFor = (text: string): string => {
  const document = new Y.Doc();
  document.getText("content").insert(0, text);
  return base64(Y.encodeStateAsUpdate(document));
};

const mergedText = (updates: readonly string[]): string => {
  const document = new Y.Doc();
  for (const update of updates)
    Y.applyUpdate(
      document,
      Uint8Array.from(atob(update), (c) => c.charCodeAt(0)),
    );
  return document.getText("content").toString();
};

test("Docs is a userspace Yjs processor: concurrent edits converge, replay, then repo check/build/load", async () => {
  const projectId = freshCtx("docs");
  const alice = openItx(projectId);
  const bob = openItx(projectId);
  await enableDocs(alice);

  const aliceUpdate = updateFor("Alice ");
  const bobUpdate = updateFor("Bob");
  const [aliceEvents, bobEvents] = await Promise.all([
    append(alice, {
      type: "docs/update",
      idempotencyKey: "alice:1",
      payload: { path: "/tasks.md", update: aliceUpdate },
    }),
    append(bob, {
      type: "docs/update",
      idempotencyKey: "bob:1",
      payload: { path: "/tasks.md", update: bobUpdate },
    }),
  ]);
  const through = Math.max(aliceEvents[0].offset, bobEvents[0].offset);
  await alice.invoke(`itx.facets.get('docs').waitUntilProcessed({ offset: ${through} })`);

  const expected = mergedText([aliceUpdate, bobUpdate]);
  const first = await alice.invoke("itx.facets.get('docs').snapshot()");
  expect(first.state.documents["/tasks.md"].text).toBe(expected);
  expect(first.state.documents["/tasks.md"].update).toEqual(expect.any(String));
  expect(first.state.documents["/tasks.md"]).not.toHaveProperty("updates");
  const live = await alice.invoke("itx.facets.get('docs').liveSnapshot()");
  expect(live.state.documents["/tasks.md"].text).toBe(expected);

  // Deleting the hosted facet then enabling the same ordinary processor forces cold replay from the
  // durable log. No Docs-specific restore protocol exists outside the event stream.
  await alice.disableProcessor("docs");
  await alice.enableProcessor("docs", {
    source: processorSource,
    className: "DocsDurableObject",
    consumes: ["docs/update"],
  });
  const replayed = await alice.invoke("itx.facets.get('docs').snapshot()");
  expect(replayed.state.documents["/tasks.md"].text).toBe(expected);

  // A subsequent Docs edit becomes the exact source content the activated app publishes.
  const editedUpdate = updateFor("!");
  const [edited] = await append(alice, {
    type: "docs/update",
    idempotencyKey: "docs-source:1",
    payload: { path: "/tasks.md", update: editedUpdate },
  });
  await alice.invoke(`itx.facets.get('docs').waitUntilProcessed({ offset: ${edited.offset} })`);
  const materialized = await alice.invoke("itx.facets.get('docs').snapshot()");
  const publishedText = materialized.state.documents["/tasks.md"].text;
  expect(publishedText).toBe(mergedText([aliceUpdate, bobUpdate, editedUpdate]));

  const appSource = `import { WorkerEntrypoint } from "cloudflare:workers";
import { document } from "./tasks";
export default class DocsApp extends WorkerEntrypoint {
  fetch() {
    return new Response(document, { headers: { "content-type": "text/markdown" } });
  }
}`;
  const revision = await alice.repos.get("/apps/docs").commit({
    files: {
      "src/main.ts": appSource,
      "src/tasks.ts": `export const document = ${JSON.stringify(publishedText)};`,
    },
    parent: null,
    message: "publish concurrent Docs lens",
  });
  const source = {
    source: { repo: "/apps/docs", revision: revision.revision },
    options: { entryPoint: "src/main.ts" },
  };
  expect(await alice.check(source)).toEqual({ status: "checked", diagnostics: [] });
  const built = await alice.build(source);
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error(built.diagnostics.join("\n"));
  const target = `itx.workers.load(${JSON.stringify(built.code)}, { cacheKey: ${JSON.stringify(built.key)} })`;
  expect(parse(target)).toBeTruthy();
  const activation = await append(
    alice,
    {
      type: "events.iterate.com/docs/activated",
      idempotencyKey: "docs-activation:1",
      payload: {
        repo: "/apps/docs",
        revision: revision.revision,
        buildKey: built.key,
        documentPath: "/tasks.md",
      },
    },
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      idempotencyKey: "docs-rewrite:1",
      payload: { match: "itx.docs", target },
    },
  );
  expect(activation.map((event) => event.offset)).toEqual([
    activation[0].offset,
    activation[0].offset + 1,
  ]);

  // A fresh capnweb client and the public HTTP expression door both find the durable rule. This is
  // deliberately not a temporary `workers.load(...).fetch()` handle held by the publishing client.
  await openItx(projectId).whoami();
  const activated = await fetch(expressionUrl(projectId, "itx.docs"));
  expect(activated.status).toBe(200);
  expect(await activated.text()).toBe(publishedText);
});

test("Docs live state reaches a client subscription after a document update", async () => {
  const itx = openItx(freshCtx("docs-live"));
  await enableDocs(itx);
  const liveConnection = await connectLiveState<DocsLive>(itx, {
    key: "docs",
    name: "docs-live-observer",
    door: () => itx.invoke("itx.facets.get('docs').liveSnapshot()"),
  });

  const update = updateFor("Live document");
  const [event] = await append(itx, {
    type: "docs/update",
    idempotencyKey: "live:1",
    payload: { path: "/live.md", update },
  });
  await itx.invoke(`itx.facets.get('docs').waitUntilProcessed({ offset: ${event.offset} })`);
  await until(
    "Docs live subscription receives the materialized document",
    () => liveConnection.store.get()?.documents["/live.md"]?.text === "Live document",
  );
  expect(liveConnection.store.get()).toEqual(
    (await itx.invoke("itx.facets.get('docs').liveSnapshot()")).state,
  );
  await liveConnection.dispose();
});
