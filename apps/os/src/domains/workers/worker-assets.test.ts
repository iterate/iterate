import { describe, expect, it } from "vitest";
import {
  isWorkerClientAssetRequest,
  workerAssetResponse,
  workerClientAssetPath,
} from "./worker-assets.ts";

describe("worker browser assets", () => {
  it("maps worker-bundler client entries to their output path", () => {
    expect(workerClientAssetPath({ clientEntryPoint: "client.tsx" })).toBe("/client.js");
    expect(workerClientAssetPath(undefined)).toBeNull();
  });

  it("recognizes only GET and HEAD requests for the configured client bundle", () => {
    const options = { clientEntryPoint: "client.tsx" } as const;
    expect(isWorkerClientAssetRequest(new Request("https://app.test/client.js"), options)).toBe(
      true,
    );
    expect(
      isWorkerClientAssetRequest(
        new Request("https://app.test/client.js", { method: "POST" }),
        options,
      ),
    ).toBe(false);
    expect(isWorkerClientAssetRequest(new Request("https://app.test/"), options)).toBe(false);
  });

  it("serves exact text assets without caching or MIME sniffing", async () => {
    const response = workerAssetResponse(new Request("https://app.test/client.js"), {
      "/client.js": "console.log('hello');",
    });
    expect(response).not.toBeNull();
    expect(response?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response?.headers.get("cache-control")).toBe("no-cache");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response?.text()).toBe("console.log('hello');");
  });

  it("returns a bodyless HEAD response and ignores misses", async () => {
    const assets = { "/client.js": "built" };
    const head = workerAssetResponse(
      new Request("https://app.test/client.js", { method: "HEAD" }),
      assets,
    );
    expect(await head?.text()).toBe("");
    expect(workerAssetResponse(new Request("https://app.test/missing.js"), assets)).toBeNull();
  });
});
