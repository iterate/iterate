// e2e/files.e2e.test.ts — `itx.r2` is the R2 binding, verbatim, on the resource owner's slice of ONE
// bucket (keys under `<owner>/`; an object answered as its fields, a body as its bytes; `list` is one
// page with its cursor); `itx.files` (library.ts) is project file storage on top: a path, its bytes
// and content type — `get(path).put/bytes/head/delete/url`, `list(prefix)`. A signed URL
// (`context/file-urls.ts`) is served on the project host `files--<project>.<base>` straight from the
// bucket: a download, with Range, or an upload. Locally R2 is wrangler's own and the host hangs under
// `localhost` (support/project-host.ts dials it); nothing is faked.
import { expect, test } from "vitest";
import { freshCtx, openItx, rejection } from "./support/client.ts";
import {
  fetchProjectHost,
  freshDnsSafeProjectId,
  registerProject,
} from "./support/project-host.ts";

const bytesOf = (text: string) => new TextEncoder().encode(text);
const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("files: put as bytes, base64 or a data: URL; bytes/head/list/delete; the same objects one layer down in itx.r2, the binding verbatim", async () => {
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

  // One layer down: the binding's own verbs and shapes, the key being the path without its slash.
  const head = await itx.r2.head("img/dot.png");
  expect(head).toMatchObject({
    key: "img/dot.png",
    size: 3,
    httpMetadata: { contentType: "image/png" },
    customMetadata: {},
    etag: expect.any(String),
    httpEtag: expect.stringMatching(/^".+"$/),
    version: expect.any(String),
    uploaded: expect.any(String),
    storageClass: expect.any(String),
  });
  const page = await itx.r2.list({ prefix: "notes/", limit: 1 });
  expect(page.objects.map((o: { key: string }) => o.key)).toEqual(["notes/b64.txt"]);
  expect(page.truncated).toBe(true);
  const rest = await itx.r2.list({ prefix: "notes/", cursor: page.cursor });
  expect(rest.objects.map((o: { key: string }) => o.key)).toEqual(["notes/hello.txt"]);
  expect(rest.truncated).toBe(false);
  expect((await itx.r2.list({ delimiter: "/" })).delimitedPrefixes.sort()).toEqual([
    "img/",
    "notes/",
  ]);
  const got = await itx.r2.get("notes/hello.txt", { range: { offset: 1, length: 3 } });
  expect(textOf(got.data)).toBe("ell");
  expect(got.range).toEqual({ offset: 1, length: 3 });
  const stored = await itx.r2.put("raw/a.bin", bytesOf("raw"), {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { origin: "test" },
  });
  expect(stored).toMatchObject({ key: "raw/a.bin", size: 3, customMetadata: { origin: "test" } });

  // Last write wins; delete takes one key or many, and leaves nothing.
  await itx.files.get("/notes/hello.txt").put({ contentType: "text/plain", data: bytesOf("bye") });
  expect(textOf(await itx.files.get("/notes/hello.txt").bytes())).toBe("bye");
  await itx.files.get("/notes/hello.txt").delete();
  expect(await itx.files.get("/notes/hello.txt").head()).toBeNull();
  await itx.r2.delete(["notes/b64.txt", "raw/a.bin"]);
  expect((await itx.files.list()).map((f: { path: string }) => f.path)).toEqual(["/img/dot.png"]);
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

/** The host and path+query of a signed URL, as fetchProjectHost takes them. */
const hostAndPath = (url: string): [string, string] => {
  const u = new URL(url);
  return [u.host, `${u.pathname}${u.search}`];
};

test("a signed URL downloads the file from the project host — content type, etag, Range — and a signed PUT uploads one; a bad, expired or wrong-method token is refused", async () => {
  const projectId = freshDnsSafeProjectId("files-url");
  await registerProject(projectId);
  const itx = openItx(projectId);
  await itx.files
    .get("/docs/readme.md")
    .put({ contentType: "text/markdown", data: bytesOf("# hello world") });

  const download = await itx.files.get("/docs/readme.md").url();
  expect(download.url).toMatch(
    new RegExp(`^https?://files--${projectId}\\.[^/]+/docs/readme\\.md\\?token=`),
  );
  expect(Date.parse(download.expiresAt)).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
  const [host, path] = hostAndPath(download.url);
  const got = await fetchProjectHost(host, path);
  expect(got.status).toBe(200);
  expect(got.text).toBe("# hello world");
  expect(got.headers["content-type"]).toBe("text/markdown");
  expect(got.headers["etag"]).toMatch(/^".+"$/);
  expect(got.headers["accept-ranges"]).toBe("bytes");
  const ranged = await fetchProjectHost(host, path, { range: "bytes=2-6" });
  expect(ranged.status).toBe(206);
  expect(ranged.text).toBe("hello");
  expect(ranged.headers["content-range"]).toBe("bytes 2-6/13");
  expect((await fetchProjectHost(host, path, {}, { method: "HEAD" })).status).toBe(200);

  // An upload: the signed PUT stores the body under the path with the request's content type.
  const upload = await itx.files
    .get("/uploads/note.txt")
    .url({ method: "PUT", expiresInSeconds: 60 });
  const [uhost, upath] = hostAndPath(upload.url);
  const put = await fetchProjectHost(
    uhost,
    upath,
    { "content-type": "text/plain" },
    { method: "PUT", body: "uploaded" },
  );
  expect(put.status).toBe(200);
  expect(JSON.parse(put.text)).toEqual({
    path: "/uploads/note.txt",
    contentType: "text/plain",
    size: 8,
  });
  expect(textOf(await itx.files.get("/uploads/note.txt").bytes())).toBe("uploaded");

  // A TTL that is not a whole number still mints a URL that works (the claim's exp is floored).
  const fractional = await itx.files.get("/docs/readme.md").url({ expiresInSeconds: 90.5 });
  expect((await fetchProjectHost(...hostAndPath(fractional.url))).status).toBe(200);

  // Refusals: a GET token used to PUT, a PUT token used to GET, a tampered token, a missing one.
  expect((await fetchProjectHost(host, path, {}, { method: "PUT", body: "x" })).status).toBe(403);
  expect((await fetchProjectHost(uhost, upath)).status).toBe(403);
  expect((await fetchProjectHost(host, `${path}x`)).status).toBe(403);
  expect((await fetchProjectHost(host, "/docs/readme.md")).status).toBe(400);
  // A token for a path that holds nothing: 404, not a refusal.
  const empty = await itx.files.get("/docs/missing.md").url();
  const [ehost, epath] = hostAndPath(empty.url);
  expect((await fetchProjectHost(ehost, epath)).status).toBe(404);
  // Another project's host with this project's token: the claim names the wrong project.
  const other = freshDnsSafeProjectId("files-url-other");
  await registerProject(other);
  expect((await fetchProjectHost(host.replace(projectId, other), path)).status).toBe(403);
});
