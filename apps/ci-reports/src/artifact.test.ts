import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { configure } from "@zip.js/zip.js/lib/zip-core-native.js";
import { strToU8, zipSync } from "fflate";
import { expect, test } from "vitest";
import { serveDepotArtifact } from "./artifact.ts";

// Misha's tests of the iterate/config viewer (apps/depot/artifact.test.ts), with a path per artifact.

test("a CI trace opens its trace.html at the artifact root", async () => {
  await using depot = await depotServer();
  const response = await serveDepotArtifact(new Request(`${reportUrl}/`), {
    token: "secret",
    fetch: depot.fetch,
  });
  expect(response).toMatchObject({ status: 200 });
  expect(await response.text()).toBe(html);
});

// scripts/ci/tracing/cli.ts names it `public-ci-trace-<workflow>-<execution>`; Depot's ids are opaque.
test("a CI trace opens its trace.html whatever its execution id looks like", async () => {
  await using depot = await depotServer();
  depot.data.artifact.name = "public-ci-trace-preview-0190c1f2-7a8b-7c3d-9e4f-5a6b7c8d9e0f";
  const response = await serveDepotArtifact(new Request(`${reportUrl}/`), {
    token: "secret",
    fetch: depot.fetch,
  });
  expect(await response.text()).toBe(html);
});

test("the artifact path without its slash redirects to the directory its relative links need", async () => {
  await using depot = await depotServer();
  const response = await serveDepotArtifact(
    new Request(`https://reports.example/${artifactId}?q=1`),
    { token: "secret", fetch: depot.fetch },
  );
  expect(response).toMatchObject({ status: 302 });
  expect(response.headers.get("location")).toBe(`${reportUrl}/?q=1`);
  expect(depot).toMatchObject({ requests: [] });
});

test("slow artifact readers do not block other requests", { timeout: 5000 }, async () => {
  // Workers has no navigator.hardwareConcurrency, so zip.js defaults to two slots.
  configure({ maxWorkers: 2 });
  await using depot = await depotServer({ "asset.bin": randomBytes(2 * 1024 * 1024) });
  depot.data.artifact.name = "public-report";
  const responses = [];
  try {
    for (let i = 0; i < 8; i++) {
      responses.push(
        await serveDepotArtifact(new Request(`${reportUrl}/asset.bin`), {
          token: "secret",
          fetch: depot.fetch,
        }),
      );
    }
    let bytes = 0;
    await responses.at(-1)!.body!.pipeTo(
      new WritableStream({
        write(chunk) {
          bytes += chunk.byteLength;
        },
      }),
      { signal: AbortSignal.timeout(1000) },
    );
    expect(bytes).toBe(2 * 1024 * 1024);
  } finally {
    await Promise.all(
      responses
        .filter((response) => !response.body!.locked)
        .map((response) => response.body!.cancel().catch(() => {})),
    );
  }
});

test(
  "an upstream failure during file extraction errors the response instead of leaving it open",
  { timeout: 1000 },
  async () => {
    await using depot = await depotServer();
    depot.data.failLocalHeader = true;
    const response = await serveDepotArtifact(new Request(`${reportUrl}/trace.html`), {
      token: "secret",
      fetch: depot.fetch,
    });
    await expect(response.text()).rejects.toThrow(/requested byte range/);
  },
);

test("reading one file in a large report only downloads ZIP metadata and that file", async () => {
  await using depot = await depotServer({
    "index.html": strToU8("small report"),
    "large.zip": randomBytes(2 * 1024 * 1024),
  });
  depot.data.artifact.name = "public-report";
  const response = await serveDepotArtifact(new Request(`${reportUrl}/index.html`), {
    token: "secret",
    fetch: depot.fetch,
  });
  expect(response).toMatchObject({ status: 200 });
  expect(await response.text()).toBe("small report");
  const reads = depot.requests.filter((request) => request.path === "/archive.zip");
  expect(reads.length).toBeGreaterThan(0);
  expect(
    reads.filter((read) => !read.range),
    "archive reads must use byte ranges",
  ).toEqual([]);
  const bytesRead = reads.reduce((sum, read) => {
    const [start, end] = read.range!.slice(6).split("-").map(Number);
    return sum + end - start + 1;
  }, 0);
  expect(bytesRead).toBeLessThan(100_000);
  const large = await serveDepotArtifact(new Request(`${reportUrl}/large.zip`), {
    token: "secret",
    fetch: depot.fetch,
  });
  expect(await large.arrayBuffer()).toMatchObject({ byteLength: 2 * 1024 * 1024 });
  expect(
    depot.requests.filter((request) => request.path === "/archive.zip").length,
    "large entries use bounded MiB chunks, not hundreds of tiny round trips",
  ).toBeLessThan(20);
});

test("an entry larger than the 8 MiB single-read cap streams whole in chunked reads", async () => {
  const video = randomBytes(12 * 1024 * 1024);
  await using depot = await depotServer({ "video.webm": video });
  depot.data.artifact.name = "public-report";
  const response = await serveDepotArtifact(new Request(`${reportUrl}/video.webm`), {
    token: "secret",
    fetch: depot.fetch,
  });
  expect(response).toMatchObject({ status: 200 });
  expect(Buffer.from(await response.arrayBuffer()).equals(video)).toBe(true);
});

test("nested reports, binary attachments, HEAD and explicit downloads retain file semantics", async () => {
  const binary = new Uint8Array([137, 80, 78, 71, 0, 255, 128]);
  await using depot = await depotServer({
    "nested/index.html": strToU8('<img src="shot.png">'),
    "nested/shot.png": binary,
  });
  depot.data.artifact.name = "public-report";
  const options = { token: "secret", fetch: depot.fetch };
  const directory = await serveDepotArtifact(
    new Request(`${reportUrl}/nested?theme=dark`),
    options,
  );
  expect(directory.headers.get("location")).toBe(`${reportUrl}/nested/index.html?theme=dark`);
  const page = await serveDepotArtifact(new Request(directory.headers.get("location")!), options);
  expect(page.headers.get("content-disposition")).toMatch(/^inline;/);
  expect(page.headers.get("content-security-policy")).toMatch(/allow-same-origin/);
  expect(page.headers.get("content-security-policy")).toMatch(/frame-src [^;]*data:/);
  const image = await serveDepotArtifact(new Request(`${reportUrl}/nested/shot.png`), options);
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(binary);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(image.headers.get("access-control-allow-origin")).toBe("*");
  const head = await serveDepotArtifact(
    new Request(`${reportUrl}/nested/shot.png`, { method: "HEAD" }),
    options,
  );
  expect(await head.text()).toBe("");
  expect(head.headers.get("content-length")).toBe(String(binary.length));
  const download = await serveDepotArtifact(
    new Request(`${reportUrl}/nested/shot.png?download`),
    options,
  );
  expect(download.headers.get("content-disposition")).toMatch(/^attachment;.*shot.png/);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(binary);
});

test("an artifact with no root index redirects to its only file or lists every file with safe relative links", async () => {
  const filename = "nested/hello <world> #1.txt";
  await using single = await depotServer({ [filename]: strToU8("hello") });
  single.data.artifact.name = "public-notes";
  const one = await serveDepotArtifact(new Request(`${reportUrl}/`), {
    token: "secret",
    fetch: single.fetch,
  });
  expect(one).toMatchObject({ status: 302 });
  expect(one.headers.get("location")).toBe(`${reportUrl}/nested/hello%20%3Cworld%3E%20%231.txt`);
  await using several = await depotServer({
    [filename]: strToU8("hello"),
    "second.txt": strToU8("two"),
  });
  several.data.artifact.name = "public-notes";
  const root = await serveDepotArtifact(new Request(`${reportUrl}/?theme=dark`), {
    token: "secret",
    fetch: several.fetch,
  });
  expect(root).toMatchObject({ status: 200 });
  const body = await root.text();
  expect(body).toMatch(/href="nested\/hello%20%3Cworld%3E%20%231.txt"/);
  expect(body).toMatch(/hello &lt;world&gt; #1.txt/);
  expect(body).toMatch(/href="second.txt"/);
  const file = await serveDepotArtifact(
    new Request(new URL("nested/hello%20%3Cworld%3E%20%231.txt", `${reportUrl}/`)),
    { token: "secret", fetch: several.fetch },
  );
  expect(await file.text()).toBe("hello");
});

test("a Playwright report opens its root index, and its relative assets resolve inside the artifact", async () => {
  await using depot = await depotServer({
    "index.html": strToU8('<script src="app.js"></script>'),
    "app.js": strToU8("document.title = 'Report'"),
  });
  depot.data.artifact.name = "public-playwright-report";
  const page = await serveDepotArtifact(new Request(`${reportUrl}/?theme=dark`), {
    token: "secret",
    fetch: depot.fetch,
  });
  expect(page).toMatchObject({ status: 200 });
  expect(await page.text()).toMatch(/app.js/);
  // the page may load and fetch only from its own artifact's path
  expect(page.headers.get("content-security-policy")).toContain(
    `connect-src ${reportUrl}/ blob: data:;`,
  );
  const script = await serveDepotArtifact(new Request(new URL("app.js", `${reportUrl}/`).href), {
    token: "secret",
    fetch: depot.fetch,
  });
  expect(script).toMatchObject({ status: 200 });
  expect(script.headers.get("content-type")).toMatch(/javascript/);
  expect(await script.text()).toMatch(/Report/);
});

test("a public trace URL serves HTML and JSON from the Depot ZIP without exposing credentials", async () => {
  await using depot = await depotServer();
  const response = await serveDepotArtifact(new Request(`${reportUrl}/`), {
    token: "private-depot-token",
    fetch: depot.fetch,
  });
  expect(response).toMatchObject({ status: 200 });
  expect(response.headers.get("content-type")).toMatch(/text\/html/);
  expect(await response.text()).toBe(html);
  expect(response.headers.get("content-security-policy")).toMatch(/sandbox allow-scripts/);
  const json = await serveDepotArtifact(new Request(`${reportUrl}/trace.json`), {
    token: "private-depot-token",
    fetch: depot.fetch,
  });
  expect(await json.json()).toEqual({ resourceSpans: [] });
  // the token goes to Depot's API only, never to the signed storage URL
  const storage = depot.requests.filter((request) => request.path === "/archive.zip");
  const api = depot.requests.filter((request) => request.path !== "/archive.zip");
  expect(storage.map((request) => request.authorization)).toEqual(storage.map(() => undefined));
  expect(api.map((request) => request.authorization)).toEqual(
    api.map(() => "Bearer private-depot-token"),
  );
});

test.for([
  { workflow: { repo: "iterate/private" } },
  { artifact: { name: "preview-os-test-artifacts" } },
  { artifact: { name: "ci-trace-source-execution" } },
])("%o is not public: nothing is read from its archive", async (mismatch) => {
  await using depot = await depotServer();
  Object.assign(depot.data.workflow, mismatch.workflow);
  Object.assign(depot.data.artifact, mismatch.artifact);
  const response = await serveDepotArtifact(new Request(`${reportUrl}/`), {
    token: "secret",
    fetch: depot.fetch,
  });
  expect(response).toMatchObject({ status: 404 });
  expect(depot.requests.filter((request) => request.path === "/archive.zip")).toEqual([]);
});

test("a file the artifact does not contain is not found", async () => {
  await using depot = await depotServer();
  const response = await serveDepotArtifact(new Request(`${reportUrl}/raw.log`), {
    token: "secret",
    fetch: depot.fetch,
  });
  expect(response).toMatchObject({ status: 404 });
});

test("encoded traversal and malformed paths are refused, and unsafe ZIP entries are never linked", async () => {
  await using depot = await depotServer({
    "index.txt": strToU8("safe"),
    "../secret.txt": strToU8("unsafe"),
    "x/../../secret.txt": strToU8("unsafe"),
  });
  depot.data.artifact.name = "public-files";
  for (const path of ["bad%ZZ", "folder%2F..%2Fsecret.txt", "%5Csecret.txt"]) {
    const response = await serveDepotArtifact(new Request(`${reportUrl}/${path}`), {
      token: "secret",
      fetch: depot.fetch,
    });
    expect(response).toMatchObject({ status: 400 });
  }
  expect(depot).toMatchObject({ requests: [] });
  const root = await serveDepotArtifact(new Request(`${reportUrl}/`), {
    token: "secret",
    fetch: depot.fetch,
  });
  expect(root).toMatchObject({ status: 422 });
});

const artifactId = "01a0aba9-78e9-7048-8d1a-bc491121fe6b";
const reportUrl = `https://reports.example/${artifactId}`;
const html =
  '<!doctype html><script id="data" type="application/json">{"resourceSpans":[]}</script>';

/** Depot's API and its artifact storage, answering for one ZIP of `files`: by default a CI trace. */
async function depotServer(
  files: Record<string, Uint8Array> = {
    "trace.html": strToU8(html),
    "trace.json": strToU8('{"resourceSpans":[]}'),
  },
) {
  const requests: { path: string; authorization: string | undefined; range: string | undefined }[] =
    [];
  const archive = zipSync(files);
  const data = {
    failLocalHeader: false,
    artifact: {
      artifactId,
      workflowId: "preview",
      name: "public-ci-trace-preview-execution",
      sizeBytes: archive.length,
    },
    workflow: { repo: "iterate/iterate" },
  };
  const server = createServer((req, res) => {
    requests.push({
      path: req.url!,
      authorization: req.headers.authorization,
      range: req.headers.range,
    });
    if (req.url === "/depot.ci.v1.CIService/GetArtifactDownloadURL")
      res.end(
        JSON.stringify({ artifact: data.artifact, url: "https://storage.depot.dev/archive.zip" }),
      );
    else if (req.url === "/depot.ci.v1.CIService/GetWorkflow")
      res.end(JSON.stringify(data.workflow));
    else if (req.url === "/archive.zip") {
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      if (range && data.failLocalHeader && range[1] === "0" && range[2] === "29") {
        res.writeHead(503);
        res.end("storage unavailable");
        return;
      }
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), archive.length - 1);
        res.writeHead(206, {
          "content-range": `bytes ${start}-${end}/${archive.length}`,
          "content-length": String(end - start + 1),
        });
        res.end(archive.subarray(start, end + 1));
      } else res.end(archive);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return {
    data,
    requests,
    fetch: ((input: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}${new URL(input).pathname}`, init)) as typeof fetch,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
