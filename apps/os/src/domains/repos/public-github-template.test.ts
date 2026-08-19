import { describe, expect, it, vi } from "vitest";
import {
  buildPack,
  encodeCommit,
  encodeTree,
  hashObject,
  pktLine,
  type TreeEntry,
} from "./git-wire.ts";
import { downloadPublicGithubTemplate } from "./public-github-template.ts";
import { RetryableRepoCreationError } from "./utils.ts";

const textEncoder = new TextEncoder();

describe("downloadPublicGithubTemplate", () => {
  it("copies an exact commit's public folder in two anonymous Git requests", async () => {
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

  it("resolves a GitHub pull ref before fetching its objects", async () => {
    const fixture = await createFixture([{ content: "worker", name: "worker.ts" }]);
    const githubFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          concatBytes([
            pktLine(`${fixture.commitOid} refs/pull/2503/head`),
            textEncoder.encode("0000"),
          ]) as BodyInit,
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

  it("rejects folders which are absent from the pinned commit", async () => {
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

  it("rejects symbolic links before downloading file contents", async () => {
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

  it("rejects non-text files because the bootstrap file structure stores strings", async () => {
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

  it("rejects a file whose inflated body exceeds the hard byte limit", async () => {
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

  it("classifies GitHub throttling as retryable", async () => {
    const githubFetch = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));

    const error = await downloadPublicGithubTemplate(
      { owner: "iterate", repo: "rate-limited" },
      githubFetch,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RetryableRepoCreationError);
  });

  it("classifies an interrupted response body as retryable", async () => {
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
  const templateTree = encodeTree(
    blobs.map(
      ({ file, oid }): TreeEntry => ({ mode: file.mode ?? "100644", name: file.name, oid }),
    ),
  );
  const templateTreeOid = await hashObject("tree", templateTree);
  const configsTree = encodeTree([{ mode: "40000", name: "with-voice", oid: templateTreeOid }]);
  const configsTreeOid = await hashObject("tree", configsTree);
  const rootTree = encodeTree([{ mode: "40000", name: "configs", oid: configsTreeOid }]);
  const rootTreeOid = await hashObject("tree", rootTree);
  const commit = encodeCommit({
    author: { date: new Date(0), email: "test@iterate.com", name: "Test" },
    message: "fixture",
    parents: [],
    tree: rootTreeOid,
  });
  const commitOid = await hashObject("commit", commit);
  return {
    blobPack: await buildPack(blobs.map(({ payload }) => ({ payload, type: "blob" }))),
    commitOid,
    graphPack: await buildPack([
      { payload: commit, type: "commit" },
      { payload: rootTree, type: "tree" },
      { payload: configsTree, type: "tree" },
      { payload: templateTree, type: "tree" },
    ]),
  };
}

function gitFetchResponse(pack: Uint8Array): Response {
  const chunks = [pktLine("packfile")];
  for (let offset = 0; offset < pack.byteLength; offset += 60_000) {
    const payload = pack.subarray(offset, offset + 60_000);
    const header = textEncoder.encode((payload.byteLength + 5).toString(16).padStart(4, "0"));
    chunks.push(concatBytes([header, Uint8Array.of(1), payload]));
  }
  chunks.push(textEncoder.encode("0000"));
  return new Response(concatBytes(chunks) as BodyInit);
}

function decodeRequestBody(body: BodyInit | null | undefined): string {
  if (!(body instanceof Uint8Array)) throw new Error("expected a Uint8Array request body");
  return new TextDecoder().decode(body);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
