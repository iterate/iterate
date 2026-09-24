import { runInNewContext } from "node:vm";
import { URL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { expect, test, vi } from "vitest";

// oxlint-disable-next-line import-js/no-restricted-paths -- the fake `itx`'s append refuses what the platform's app wall refuses: a fake borrowing the real policy, never runtime code crossing the line
import { admitLoadedCodeRow } from "../../os/src/context/itx-expression-rewriting.ts";

// Whichever row runs first pays for bundling the worker with esbuild (`loadVoiceWorker()`), which
// used to run under the hook budget; every row gets that budget.
vi.setConfig({ testTimeout: 10_000 });

test.each([0, 1, 2, 3, 4])(
  "RGBA PNG row filter %i reaches the panel as 15000 black bytes",
  async (filter) => {
    const { worker, quickAction, setImage } = await harness(png(4, filter));
    const result = await worker.setImage({
      device: "waveshare_rlcd_4_2",
      image: { html: "hello" },
    });
    expect(result).toMatchObject({ shown: true, bytes: 15000 });
    expect(quickAction).toHaveBeenCalledWith(
      "screenshot",
      expect.objectContaining({
        viewport: { width: 400, height: 300, deviceScaleFactor: 1 },
      }),
    );
    const chunks = setImage.mock.calls.map(([chunk]) => chunk);
    expect(chunks.map((chunk) => chunk.offset)).toEqual([0, 4096, 8192, 12288]);
    expect(new Set(chunks.map((chunk) => chunk.uploadId))).toMatchObject({ size: 1 });
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data, "base64")))).toEqual(
      Buffer.alloc(15000, 255),
    );
  },
);

test("a null image uses the same setter without rendering", async () => {
  const { worker, quickAction, setImage } = await harness();
  expect(await worker.setImage({ device: "waveshare_rlcd_4_2", image: null })).toMatchObject({
    shown: false,
    bytes: 0,
  });
  expect(quickAction).not.toHaveBeenCalled();
  expect(setImage).toHaveBeenCalledExactlyOnceWith(null);
});

test("an incorrect device acknowledgment stops the upload", async () => {
  const { worker, setImage } = await harness();
  setImage.mockResolvedValueOnce(0);
  await expect(
    worker.setImage({ device: "waveshare_rlcd_4_2", image: { html: "hello" } }),
  ).rejects.toThrow("expected 4096");
  expect(setImage).toHaveBeenCalledTimes(1);
});

test.each(["waveshare-rlcd-4-2", "zectrix-note4", "havpe"])(
  "%s receives only its own screen context",
  async (device) => {
    const { worker, append, create, disable } = await harness();
    await worker.setupVoiceAgent({
      streamPath: `/agents/voice/v23/${device}/test`,
      activation: "test",
      screen: device !== "havpe",
    });
    expect(create).toHaveBeenCalledExactlyOnceWith(`/agents/voice/v23/${device}/test`);
    expect(disable).toHaveBeenCalledExactlyOnceWith("agent");
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(disable.mock.invocationCallOrder[0]!);
    expect(disable.mock.invocationCallOrder[0]).toBeLessThan(append.mock.invocationCallOrder[0]!);
    const events = append.mock.calls[0]!;
    const contextType = "events.iterate.com/agent/context-added";
    const subscription = events.find((event) => event.payload?.name === "voice-delegate");
    expect(subscription).toBeDefined();
    expect(events.some((event) => event.type === contextType)).toBe(device !== "havpe");
    if (device !== "havpe") {
      expect(events.find((event) => event.type === contextType).payload).toMatchObject({
        content: readFileSync(new URL("./screen-context.md", import.meta.url), "utf8").replaceAll(
          "{{DEVICE}}",
          device.replaceAll("-", "_"),
        ),
      });
    }
    expect(subscription.payload.consumes).toContain(contextType);
  },
);

// Regression: a photo URL in the September 21 voice stream returned HTTP 404.
// Chromium still produced a valid PNG containing the broken-image icon.
test.each([true, false])(
  "image decode success=%s controls whether pixels reach the device",
  async (loaded) => {
    const { worker, quickAction, setImage } = await harness();
    quickAction.mockImplementationOnce(async (...args: any[]) => {
      const options = args[1];
      const attrs = new Map<string, string>();
      const document = {
        images: [{ decode: () => (loaded ? Promise.resolve() : Promise.reject(new Error("404"))) }],
        fonts: { ready: Promise.resolve() },
        documentElement: {
          removeAttribute: (key: string) => attrs.delete(key),
          setAttribute: (key: string, value: string) => attrs.set(key, value),
        },
      };
      // Run the actual browser guard, including its rejected-decode path.
      await runInNewContext(options.addScriptTag[0].content, { document, Promise });
      expect(options.waitForSelector).toMatchObject({
        selector: '[data-iterate-screen-assets="ready"]',
        timeout: 5000,
      });
      if (attrs.get("data-iterate-screen-assets") !== "ready")
        throw new Error("asset readiness timeout");
      return new Uint8Array(png(3, 0));
    });
    const render = worker.setImage({
      device: "waveshare_rlcd_4_2",
      image: { html: '<img src="https://example.com/missing.jpg">' },
    });
    if (loaded) {
      await expect(render).resolves.toMatchObject({ shown: true });
      expect(setImage).toHaveBeenCalledTimes(4);
    } else {
      await expect(render).rejects.toThrow("asset readiness timeout");
      expect(setImage).not.toHaveBeenCalled();
    }
  },
);

test("NOTE4 grayscale uses the same transfer and sends 60000 bytes", async () => {
  const { worker, setImage } = await harness(png(3, 0), { formats: ["mono1", "gray4"] });
  expect(
    await worker.setImage({ device: "zectrix_note4", image: { html: "grey", format: "gray4" } }),
  ).toMatchObject({ shown: true, bytes: 60000, format: "gray4" });
  expect(setImage.mock.calls.every(([chunk]) => chunk.format === "gray4")).toBe(true);
});

test("an unsupported format fails before rendering or transfer", async () => {
  const { worker, quickAction, setImage } = await harness();
  await expect(
    worker.setImage({ device: "waveshare_rlcd_4_2", image: { html: "x", format: "rgb565" } }),
  ).rejects.toThrow("does not support");
  expect(quickAction).not.toHaveBeenCalled();
  expect(setImage).not.toHaveBeenCalled();
});

test("an accepted e-paper upload waits for refresh completion", async () => {
  const { worker, status } = await harness();
  status.mockImplementationOnce(async () => ({ ...(await status()), state: "pending" }));
  expect(await worker.setImage({ device: "zectrix_note4", image: { html: "x" } })).toMatchObject({
    shown: true,
  });
  expect(status.mock.calls.length).toBeGreaterThan(1);
});

test.each(["failed", "idle"])("a %s refresh never reports shown", async (state) => {
  const { worker, status } = await harness();
  status.mockImplementationOnce(async () => ({ ...(await status()), state }));
  await expect(worker.setImage({ device: "zectrix_note4", image: { html: "x" } })).rejects.toThrow(
    `refresh ${state}`,
  );
});

test("an abandoned refresh times out", async () => {
  const { worker, status } = await harness(png(3, 0), { refreshTimeoutMs: 1 });
  status.mockImplementationOnce(async () => {
    const result = await status();
    status.mockResolvedValue({ ...result, state: "pending" });
    return { ...result, state: "pending" };
  });
  await expect(worker.setImage({ device: "zectrix_note4", image: { html: "x" } })).rejects.toThrow(
    "timed out",
  );
});

let voiceWorker: Promise<any> | undefined;

/**
 * Deployed facets receive processor.js from the runtime. Supply just the
 * ConfigWorker environment and the SDK's `z` here and exercise the actual
 * bundled worker, built once per file on first use.
 */
function loadVoiceWorker(): Promise<any> {
  const recordPipelinedSteps = join(
    dirname(createRequire(import.meta.url).resolve("iterate/sdk")),
    "record-pipelined-steps.ts",
  );
  voiceWorker ||= (async () => {
    const bundle = await build({
      entryPoints: [new URL("./worker.ts", import.meta.url).pathname],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      loader: { ".md": "text" },
      plugins: [
        {
          name: "processor-runtime",
          setup(builder) {
            builder.onResolve({ filter: /^\.\/processor\.js$/ }, () => ({
              path: "processor",
              namespace: "test-runtime",
            }));
            // The SDK's real `withItx` (node-safe), so the rows run the worker's reach through
            // the same recording proxy and release as a deployed config worker.
            builder.onLoad({ filter: /.*/, namespace: "test-runtime" }, () => ({
              contents: [
                `import { withItx } from ${JSON.stringify(recordPipelinedSteps)};`,
                "export class ConfigWorker { constructor(env) { this.env = env; } withItx(call) { return withItx(this.env.ITX, call); } }",
                'export { z } from "zod";',
              ].join("\n"),
              resolveDir: new URL(".", import.meta.url).pathname,
            }));
          },
        },
      ],
    });
    const { default: VoiceWorker } = await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`
    );
    return VoiceWorker;
  })();
  return voiceWorker;
}

function png(channels: 3 | 4, filter: number) {
  const width = 400;
  const height = 300;
  const rows = Buffer.alloc(height * (width * channels + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * channels + 1);
    rows[row] = filter;
    // A constant black RGB/opaque RGBA image. PNG filter predictors are zero
    // except alpha: after its first pixel, the selected predictor is 255.
    if (channels === 4) {
      for (let x = 0; x < width; x++) {
        const left = x ? 255 : 0;
        const up = y ? 255 : 0;
        const predictor =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? up
                : filter === 3
                  ? Math.floor((left + up) / 2)
                  : left || up;
        rows[row + 1 + x * channels + 3] = (255 - predictor) & 255;
      }
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    result.write(type, 4, "ascii");
    result.set(data, 8);
    result.writeUInt32BE(crc32(result.subarray(4, data.length + 8)), data.length + 8);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function harness(image = png(3, 0), infoOverride = {}) {
  const VoiceWorker = await loadVoiceWorker();
  const info = {
    width: 400,
    height: 300,
    formats: ["mono1"],
    preferredFormat: "mono1",
    maxChunkBytes: 4096,
    refreshTimeoutMs: 1000,
    partialRefresh: false,
    ...infoOverride,
  };
  let uploadId = 0;
  const quickAction = vi.fn(async () => new Uint8Array(image));
  const setImage = vi.fn(async (chunk: any) => {
    if (chunk === null) return true;
    uploadId = chunk.uploadId;
    return chunk.offset + Buffer.from(chunk.data, "base64").length;
  });
  const status = vi.fn(async () => ({ uploadId, state: "shown" }));
  const screen = { setImage, status, info: vi.fn(async () => info) };
  const append = vi.fn(async (...events: any[]) => {
    for (const event of events) admitLoadedCodeRow(event, "/agents/voice/test");
    return [];
  });
  const disable = vi.fn(async () => undefined);
  const itx = {
    agents: { create: vi.fn(async () => ({})) },
    browser: { quickAction },
    clients: { waveshare_rlcd_4_2: { screen }, zectrix_note4: { screen }, tiny: { screen } },
    cd: vi.fn(() => ({ append, processors: { disable } })),
  };
  return {
    worker: new VoiceWorker({ ITX: { get: () => itx } }),
    quickAction,
    setImage,
    status,
    append,
    create: itx.agents.create,
    disable,
  };
}
