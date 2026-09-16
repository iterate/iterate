// e2e/files.e2e.test.ts — `itx.r2` is the resource owner's slice of ONE R2 bucket (keys under
// `<owner>/`, the bucket's own verbs answered as plain data); `itx.files` (library.ts) is project file
// storage on top: a path, its bytes and content type — `get(path).put/bytes/head/delete`, `list(prefix)`.
// Locally R2 is wrangler's own (.wrangler/state); nothing is faked.
import { expect, test } from "vitest";
import { freshCtx, openItx, rejection } from "./support/client.ts";

const bytesOf = (text: string) => new TextEncoder().encode(text);
const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("files: put as bytes, base64 or a data: URL; bytes/head/list/delete; a path is its key in itx.r2", async () => {
  const itx = openItx(freshCtx("files"));
  expect(await itx.files.list()).toEqual([]);
  expect(await itx.files.get("/notes/hello.txt").head()).toBeNull();
  expect((await rejection(itx.files.get("/notes/hello.txt").bytes())).message).toMatch(
    /nothing at/,
  );

  expect(
    await itx.files
      .get("/notes/hello.txt")
      .put({ contentType: "text/plain", data: bytesOf("hello") }),
  ).toEqual({ path: "/notes/hello.txt", contentType: "text/plain", size: 5 });
  expect(textOf(await itx.files.get("/notes/hello.txt").bytes())).toBe("hello");
  // A string is base64; a data: URL brings its own content type.
  await itx.files
    .get("/notes/b64.txt")
    .put({ contentType: "text/plain", data: btoa("sixty-four") });
  expect(textOf(await itx.files.get("/notes/b64.txt").bytes())).toBe("sixty-four");
  expect(await itx.files.get("/img/dot.png").put({ data: "data:image/png;base64,QUJD" })).toEqual({
    path: "/img/dot.png",
    contentType: "image/png",
    size: 3,
  });
  expect(await itx.files.get("/img/dot.png").head()).toEqual({
    path: "/img/dot.png",
    contentType: "image/png",
    size: 3,
  });
  expect((await itx.files.list("/notes")).map((f: { path: string }) => f.path).sort()).toEqual([
    "/notes/b64.txt",
    "/notes/hello.txt",
  ]);
  expect((await itx.files.list()).length).toBe(3);
  // The same objects, one layer down: the key is the path without its leading slash.
  expect((await itx.r2.list("notes/")).objects.map((o: { key: string }) => o.key).sort()).toEqual([
    "notes/b64.txt",
    "notes/hello.txt",
  ]);
  expect(await itx.r2.head("img/dot.png")).toMatchObject({
    key: "img/dot.png",
    size: 3,
    contentType: "image/png",
  });
  // Last write wins; delete leaves nothing.
  await itx.files.get("/notes/hello.txt").put({ contentType: "text/plain", data: bytesOf("bye") });
  expect(textOf(await itx.files.get("/notes/hello.txt").bytes())).toBe("bye");
  expect(await itx.files.get("/notes/hello.txt").delete()).toEqual({ ok: true });
  expect(await itx.files.get("/notes/hello.txt").head()).toBeNull();
  expect((await itx.files.list()).length).toBe(2);
});

test("files are the project's own: another project's slice of the bucket is empty", async () => {
  const a = openItx(freshCtx("files-a"));
  const b = openItx(freshCtx("files-b"));
  await a.files.get("/secret.txt").put({ contentType: "text/plain", data: bytesOf("mine") });
  expect(await b.files.list()).toEqual([]);
  expect(await b.files.get("/secret.txt").head()).toBeNull();
  expect((await b.r2.list()).objects).toEqual([]);
  expect(textOf(await a.files.get("/secret.txt").bytes())).toBe("mine");
});

test("a script reaches the files too — put from inside a run, read from outside", async () => {
  const itx = openItx(freshCtx("files-run"));
  expect(
    await itx.run(
      'async (itx) => { await itx.files.get("/from-script.txt").put({ contentType: "text/plain", data: btoa("ran") }); return (await itx.files.list()).map((f) => f.path); }',
    ),
  ).toEqual(["/from-script.txt"]);
  expect(textOf(await itx.files.get("/from-script.txt").bytes())).toBe("ran");
});
