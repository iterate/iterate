import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { listenOnFetchSafePort } from "../../../packages/shared/src/test-support/fetch-safe-port.ts";
import { createAssetStore, syncAssetManifest } from "./filter-asset-store.ts";

test("upload before saving the manifest; a second run needs neither images nor an AI key", async () => {
  await using fixture = await assetFixture();
  const manifestPath = join(fixture.directory, "images.json");
  const bytes = Buffer.from("generated dog image");
  let generations = 0;
  const input = {
    manifestPath,
    recipes: [
      {
        id: "dog",
        slug: "cartoon-dog",
        extension: "jpeg",
        generate: async () => {
          generations++;
          return { bytes };
        },
      },
    ],
    store: fixture.store,
    slug: undefined,
    force: false,
  };

  await syncAssetManifest(input);
  const manifest = await readFile(manifestPath, "utf8");
  const { dog } = JSON.parse(manifest);
  expect(dog).toMatch(
    /^https:\/\/mobile\.iterate\.com\/filter-assets\/cartoon-dog-[a-f0-9]{64}\.jpeg$/,
  );
  expect(await (await fetch(fixture.url + new URL(dog).pathname)).text()).toBe(bytes.toString());

  await syncAssetManifest(input);
  expect(generations).toBe(1);
  expect(await readFile(manifestPath, "utf8")).toBe(manifest);
});

test("--force --slug replaces only that image and its anchors, retaining the old URL", async () => {
  await using fixture = await assetFixture();
  const manifestPath = join(fixture.directory, "animals.json");
  const oldUrl = await fixture.store.upload("animal-cat", "png", Buffer.from("old cat"));
  const oldAnchors = {
    leftEye: { x: 0.3, y: 0.4 },
    rightEye: { x: 0.7, y: 0.4 },
    mouth: { x: 0.5, y: 0.7 },
    eyeWidth: 0.1,
    mouthWidth: 0.2,
  };
  const newAnchors = { ...oldAnchors, mouth: { x: 0.5, y: 0.8 } };
  await writeFile(
    manifestPath,
    JSON.stringify({ cat: { url: oldUrl, anchors: oldAnchors }, dog: oldUrl }),
  );
  await syncAssetManifest({
    manifestPath,
    store: fixture.store,
    slug: "animal-cat",
    force: true,
    recipes: [
      {
        id: "cat",
        slug: "animal-cat",
        extension: "png",
        generate: async () => ({ bytes: Buffer.from("new cat"), anchors: newAnchors }),
      },
      {
        id: "dog",
        slug: "animal-dog",
        extension: "png",
        generate: async () => {
          throw new Error("Unselected image must not generate");
        },
      },
    ],
  });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(manifest).toMatchObject({ dog: oldUrl, cat: { anchors: newAnchors } });
  expect(manifest.cat.url).not.toBe(oldUrl);
  expect(await (await fetch(fixture.url + new URL(oldUrl).pathname)).text()).toBe("old cat");
});

test.each(["check", "upload"])("a failed %s leaves the manifest intact", async (failure) => {
  await using fixture = await assetFixture();
  const manifestPath = join(fixture.directory, "images.json");
  const oldUrl = await fixture.store.upload("cartoon-dog", "jpeg", Buffer.from("approved dog"));
  const manifest = JSON.stringify({ dog: oldUrl });
  await writeFile(manifestPath, manifest);
  fixture.fail(failure);
  let generations = 0;
  await expect(
    syncAssetManifest({
      manifestPath,
      store: fixture.store,
      slug: undefined,
      force: failure === "upload",
      recipes: [
        {
          id: "dog",
          slug: "cartoon-dog",
          extension: "jpeg",
          generate: async () => {
            generations++;
            return { bytes: Buffer.from("new dog") };
          },
        },
      ],
    }),
  ).rejects.toThrow(/Asset (check|upload) failed \(503\)/);
  expect(await readFile(manifestPath, "utf8")).toBe(manifest);
  expect(generations).toBe(failure === "upload" ? 1 : 0);
});

test("a missing uploaded object regenerates; a misspelled slug fails before generation", async () => {
  await using fixture = await assetFixture();
  const manifestPath = join(fixture.directory, "images.json");
  const missingUrl = `https://mobile.iterate.com/filter-assets/cartoon-dog-${"a".repeat(64)}.jpeg`;
  await writeFile(manifestPath, JSON.stringify({ dog: missingUrl }));
  let generations = 0;
  const input = {
    manifestPath,
    store: fixture.store,
    slug: "cartoon-dgo",
    force: false,
    recipes: [
      {
        id: "dog",
        slug: "cartoon-dog",
        extension: "jpeg",
        generate: async () => {
          generations++;
          return { bytes: Buffer.from("replacement dog") };
        },
      },
    ],
  };
  await expect(syncAssetManifest(input)).rejects.toThrow("Unknown asset slug");
  expect(generations).toBe(0);
  await syncAssetManifest({ ...input, slug: "cartoon-dog" });
  const { dog } = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(dog).not.toBe(missingUrl);
  expect(await (await fetch(fixture.url + new URL(dog).pathname)).text()).toBe("replacement dog");
});

async function assetFixture() {
  const directory = await mkdtemp(join(tmpdir(), "filter-assets-test-"));
  const objects = new Map<string, Buffer>();
  let failure = "";
  const server = createServer(async (request, response) => {
    const key = request.url || "/";
    if (failure === (request.method === "PUT" ? "upload" : "check")) {
      response.writeHead(503);
      response.end("Unavailable");
      return;
    }
    if (request.method === "PUT") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
      response.end();
      return;
    }
    const bytes = objects.get(key);
    response.writeHead(bytes ? 200 : 404);
    response.end(bytes);
  });
  const port = await listenOnFetchSafePort(server);
  const url = `http://127.0.0.1:${port}`;
  return {
    directory,
    url,
    fail(value: string) {
      failure = value;
    },
    store: createAssetStore({ objectsUrl: url, token: "test-token" }),
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}
