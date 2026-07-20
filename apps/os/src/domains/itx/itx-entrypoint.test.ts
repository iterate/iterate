import { describe, expect, test, vi } from "vitest";
import { WORKER_FETCH_DISPATCH_HEADER } from "../workers/worker-fetch-dispatch.ts";

vi.mock("../../rpc-targets.ts", () => ({
  deploymentItxForInternal: vi.fn(),
  itxForScope: vi.fn(),
}));
vi.mock("../workers/worker-runner.ts", () => ({ DynamicWorkerRunner: class {} }));
vi.mock("./utils.ts", () => ({ scopeFromItxEntrypointProps: vi.fn() }));

const { ItxEntrypoint } = await import("./itx-entrypoint.ts");

describe("ItxEntrypoint worker fetch boundary", () => {
  test.each([
    "not json",
    JSON.stringify({
      ref: {
        files: { "worker.ts": "export default {}" },
        options: { entryPoint: "worker.ts" },
        path: "/",
        type: "stateless",
      },
    }),
  ])("classifies an invalid or retired worker ref as a 400", async (header) => {
    const request = new Request("https://example.com/", {
      headers: { [WORKER_FETCH_DISPATCH_HEADER]: header },
    });

    const response = await ItxEntrypoint.prototype.fetch.call(
      {} as InstanceType<typeof ItxEntrypoint>,
      request,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("expected the current DynamicWorkerRef shape");
  });
});
