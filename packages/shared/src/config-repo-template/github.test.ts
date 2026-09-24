import { expect, test, vi } from "vitest";
import {
  buildPack,
  concat,
  encodeCommit,
  hashObject,
  pktLine,
  treeObjectsOf,
} from "../git-wire.ts";
import {
  downloadPublicGithubTemplate,
  pinPublicGithubTemplate,
  RetryableRepoCreationError,
} from "./github.ts";

const textEncoder = new TextEncoder();

test("pins a branch without downloading its tree and leaves exact commits alone", async () => {
  const ref = "a".repeat(40);
  const reference = {
    owner: "iterate",
    repo: "iterate",
    ref: "main",
    path: "configs/with-agents",
  };
  const githubFetch = vi
    .fn()
    .mockResolvedValue(
      new Response(concat([pktLine(`${ref} refs/heads/main`), textEncoder.encode("0000")])),
    );
  const pinned = await pinPublicGithubTemplate(reference, githubFetch);
  expect(pinned).toEqual({ ...reference, ref });
  expect(githubFetch).toHaveBeenCalledTimes(1);
  expect(decodeRequestBody(githubFetch.mock.calls[0]?.[1]?.body)).toContain("command=ls-refs");
  await expect(pinPublicGithubTemplate(pinned, githubFetch)).resolves.toEqual(pinned);
  expect(githubFetch).toHaveBeenCalledTimes(1);
});

test("copies an exact commit's public folder in two anonymous Git requests", async () => {
  const fixture = await createFixture([
    { content: "worker", name: "worker.ts" },
    { content: "agents\n", name: "AGENTS.md" },
  ]);
  const githubFetch = vi
    .fn()
    .mockResolvedValueOnce(gitFetchResponse(fixture.graphPack))
    .mockResolvedValueOnce(gitFetchResponse(fixture.blobPack));

  await expect(
    downloadPublicGithubTemplate(
      {
        owner: "iterate",
        path: "configs/with-voice",
        ref: fixture.commitOid,
        repo: "iterate",
      },
      githubFetch,
    ),
  ).resolves.toEqual([
    { content: "agents\n", path: "AGENTS.md" },
    { content: "worker", path: "worker.ts" },
  ]);

  expect(githubFetch).toHaveBeenCalledTimes(2);
  expect(githubFetch.mock.calls[0]?.[0]).toBe(
    "https://github.com/iterate/iterate.git/git-upload-pack",
  );
  expect(githubFetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
  expect(decodeRequestBody(githubFetch.mock.calls[0]?.[1]?.body)).toContain("filter blob:none");
});

test("resolves a GitHub pull ref before fetching its objects", async () => {
  const fixture = await createFixture([{ content: "worker", name: "worker.ts" }]);
  const githubFetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        concat([pktLine(`${fixture.commitOid} refs/pull/2503/head`), textEncoder.encode("0000")]),
      ),
    )
    .mockResolvedValueOnce(gitFetchResponse(fixture.graphPack))
    .mockResolvedValueOnce(gitFetchResponse(fixture.blobPack));

  await expect(
    downloadPublicGithubTemplate(
      {
        owner: "iterate",
        path: "configs/with-voice",
        ref: "pull/2503/head",
        repo: "iterate",
      },
      githubFetch,
    ),
  ).resolves.toEqual([{ content: "worker", path: "worker.ts" }]);
  expect(githubFetch).toHaveBeenCalledTimes(3);
  expect(decodeRequestBody(githubFetch.mock.calls[0]?.[1]?.body)).toContain(
    "ref-prefix refs/pull/2503/head",
  );
});

test("rejects folders which are absent from the pinned commit", async () => {
  const fixture = await createFixture([{ content: "worker", name: "worker.ts" }]);
  const githubFetch = vi.fn().mockResolvedValue(gitFetchResponse(fixture.graphPack));

  await expect(
    downloadPublicGithubTemplate(
      {
        owner: "iterate",
        path: "configs/missing",
        ref: fixture.commitOid,
        repo: "iterate",
      },
      githubFetch,
    ),
  ).rejects.toThrow("was not found");
});

test("rejects symbolic links before downloading file contents", async () => {
  const fixture = await createFixture([
    { content: "../secret", mode: "120000", name: "linked-file" },
  ]);
  const githubFetch = vi.fn().mockResolvedValue(gitFetchResponse(fixture.graphPack));

  await expect(
    downloadPublicGithubTemplate(
      {
        owner: "iterate",
        path: "configs/with-voice",
        ref: fixture.commitOid,
        repo: "iterate",
      },
      githubFetch,
    ),
  ).rejects.toThrow("cannot contain submodules or symbolic links");
  expect(githubFetch).toHaveBeenCalledTimes(1);
});

test("rejects non-text files because the bootstrap file structure stores strings", async () => {
  const fixture = await createFixture([
    { content: new Uint8Array([0xff, 0xfe]), name: "image.png" },
  ]);
  const githubFetch = vi
    .fn()
    .mockResolvedValueOnce(gitFetchResponse(fixture.graphPack))
    .mockResolvedValueOnce(gitFetchResponse(fixture.blobPack));

  await expect(
    downloadPublicGithubTemplate(
      {
        owner: "iterate",
        path: "configs/with-voice",
        ref: fixture.commitOid,
        repo: "iterate",
      },
      githubFetch,
    ),
  ).rejects.toThrow("is not UTF-8 text");
});

test("rejects a file whose inflated body exceeds the hard byte limit", async () => {
  const fixture = await createFixture([
    { content: new Uint8Array(2 * 1024 * 1024 + 1), name: "worker.ts" },
  ]);
  const githubFetch = vi
    .fn()
    .mockResolvedValueOnce(gitFetchResponse(fixture.graphPack))
    .mockResolvedValueOnce(gitFetchResponse(fixture.blobPack));

  await expect(
    downloadPublicGithubTemplate(
      {
        owner: "iterate",
        path: "configs/with-voice",
        ref: fixture.commitOid,
        repo: "iterate",
      },
      githubFetch,
    ),
  ).rejects.toThrow("pack object exceeds 2097152 bytes");
});

test("classifies GitHub throttling as retryable", async () => {
  const githubFetch = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));

  const error = await downloadPublicGithubTemplate(
    { owner: "iterate", repo: "rate-limited" },
    githubFetch,
  ).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(RetryableRepoCreationError);
});

test("classifies an interrupted response body as retryable", async () => {
  const githubFetch = vi.fn().mockResolvedValue(
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new TypeError("connection closed"));
        },
      }),
    ),
  );

  const error = await downloadPublicGithubTemplate(
    { owner: "iterate", repo: "interrupted" },
    githubFetch,
  ).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(RetryableRepoCreationError);
});

async function createFixture(
  files: Array<{
    content: string | Uint8Array;
    mode?: "100644" | "100755" | "120000";
    name: string;
  }>,
): Promise<{ blobPack: Uint8Array; commitOid: string; graphPack: Uint8Array }> {
  const blobs = await Promise.all(
    files.map(async (file) => {
      const payload =
        typeof file.content === "string" ? textEncoder.encode(file.content) : file.content;
      return { file, oid: await hashObject("blob", payload), payload };
    }),
  );
  const { rootOid, trees } = await treeObjectsOf(
    new Map(
      blobs.map(({ file, oid }) => [
        `configs/with-voice/${file.name}`,
        { mode: file.mode || "100644", oid },
      ]),
    ),
  );
  const commit = encodeCommit({
    author: { date: new Date(0), email: "test@iterate.com", name: "Test" },
    message: "fixture",
    parents: [],
    tree: rootOid,
  });
  const commitOid = await hashObject("commit", commit);
  return {
    blobPack: await buildPack(blobs.map(({ payload }) => ({ payload, type: "blob" }))),
    commitOid,
    graphPack: await buildPack([
      { payload: commit, type: "commit" },
      ...trees.map((tree) => ({ payload: tree.payload, type: "tree" as const })),
    ]),
  };
}

function gitFetchResponse(pack: Uint8Array): Response {
  const chunks = [pktLine("packfile")];
  for (let offset = 0; offset < pack.byteLength; offset += 60_000) {
    const payload = pack.subarray(offset, offset + 60_000);
    const header = textEncoder.encode((payload.byteLength + 5).toString(16).padStart(4, "0"));
    chunks.push(concat([header, Uint8Array.of(1), payload]));
  }
  chunks.push(textEncoder.encode("0000"));
  return new Response(concat(chunks));
}

function decodeRequestBody(body: RequestInit["body"]): string {
  if (!(body instanceof Uint8Array)) throw new Error("expected a Uint8Array request body");
  return new TextDecoder().decode(body);
}
