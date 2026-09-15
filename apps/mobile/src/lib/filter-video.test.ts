import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, URL } from "node:url";
import { expect, test } from "vitest";
import { saveFilteredVideo } from "./filter-video.ts";

test("closing the camera while its recording is saved discards the attachment and file", async () => {
  await using cache = await cameraCache();
  const writing = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  const cancel = new AbortController();
  const saving = saveFilteredVideo({
    video: { base64: btoa("captured video"), mimeType: "video/mp4", durationSeconds: 2 },
    capturedAt: 123,
    signal: cancel.signal,
    fileSystem: {
      cacheDirectory: cache.uri,
      async writeAsStringAsync(uri, base64) {
        await writeFile(new URL(uri), base64, "base64");
        writing.resolve();
        await finishWrite.promise;
      },
      deleteAsync: async (uri) => unlink(new URL(uri)),
    },
  });
  await writing.promise;
  cancel.abort();
  finishWrite.resolve();
  expect(await saving).toBeNull();
  expect(await readdir(cache.path)).toEqual([]);
});

test("a filtered recording becomes a flat cache file with its bytes and media type preserved", async () => {
  await using cache = await cameraCache();
  const attachment = await saveFilteredVideo({
    video: {
      base64: btoa("captured video"),
      mimeType: "video/webm;codecs=vp9",
      durationSeconds: 2,
    },
    capturedAt: 456,
    signal: new AbortController().signal,
    fileSystem: {
      cacheDirectory: cache.uri,
      writeAsStringAsync: async (uri, base64) => writeFile(new URL(uri), base64, "base64"),
      deleteAsync: async (uri) => unlink(new URL(uri)),
    },
  });
  expect(attachment).toMatchObject({
    kind: "video",
    filename: "filter-456.webm",
    contentType: "video/webm",
    durationSeconds: 2,
  });
  expect(await readdir(cache.path)).toEqual(["filter-456.webm"]);
  expect(await readFile(join(cache.path, "filter-456.webm"), "utf8")).toBe("captured video");
});

test("a native recording keeps its existing file and never converts the video to text", async () => {
  await using cache = await cameraCache();
  const uri = `${cache.uri}native.mp4`;
  await writeFile(new URL(uri), new Uint8Array([0, 255, 13, 128]));
  const attachment = await saveFilteredVideo({
    video: {
      uri,
      mimeType: "video/mp4",
      width: 720,
      height: 1280,
      durationSeconds: 3,
      droppedFrames: 0,
    },
    capturedAt: 789,
    signal: new AbortController().signal,
    fileSystem: {
      cacheDirectory: null,
      writeAsStringAsync: async () => {
        throw new Error("Native recording must not be copied through JavaScript");
      },
      deleteAsync: async (uri) => unlink(new URL(uri)),
    },
  });
  expect(attachment).toMatchObject({
    uri,
    kind: "video",
    width: 720,
    height: 1280,
    contentType: "video/mp4",
    durationSeconds: 3,
  });
  expect([...(await readFile(new URL(uri)))]).toEqual([0, 255, 13, 128]);
});

test("a native recording delivered after cancellation is removed", async () => {
  await using cache = await cameraCache();
  const uri = `${cache.uri}canceled.mp4`;
  await writeFile(new URL(uri), "captured video");
  const attachment = await saveFilteredVideo({
    video: {
      uri,
      mimeType: "video/mp4",
      width: 720,
      height: 1280,
      durationSeconds: 3,
      droppedFrames: 0,
    },
    capturedAt: 789,
    signal: AbortSignal.abort(),
    fileSystem: {
      cacheDirectory: cache.uri,
      writeAsStringAsync: async () => {
        throw new Error("A canceled recording must not be copied");
      },
      deleteAsync: async (uri) => unlink(new URL(uri)),
    },
  });
  expect(attachment).toBeNull();
  expect(await readdir(cache.path)).toEqual([]);
});

async function cameraCache() {
  const path = await mkdtemp(join(tmpdir(), "filter-video-"));
  return {
    path,
    uri: `${pathToFileURL(path).href}/`,
    [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }),
  };
}
