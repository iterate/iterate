import { describe, expect, test } from "vitest";

import { firmwareWebsocketBuildDirectories } from "../../scripts/test-firmware-websocket";

describe("ESP-IDF WebSocket compatibility runner", () => {
  test("the patched proof and stock red control can run concurrently", () => {
    /*
     * This reproduces a real harness incident: starting the green patched suite
     * beside `--prove-stock-fails` made both CMake processes rewrite the same
     * `component_properties.temp.cmake`, yielding parser errors instead of
     * evidence about either implementation. The control invocation itself
     * needs two trees because its patched baseline and stock counterfactual
     * intentionally compile different source graphs.
     *
     * Disjoint paths are the contract. Merely retrying or serializing the jobs
     * was rejected because the test rig must distinguish product regressions
     * from its own shared-state races.
     */
    const patchedProof = firmwareWebsocketBuildDirectories({});
    const stockControl = firmwareWebsocketBuildDirectories({
      proveStockFails: true,
    });

    expect(
      new Set([
        patchedProof.patchedBuildDirectory,
        stockControl.patchedBuildDirectory,
        stockControl.stockBuildDirectory,
      ]).size,
    ).toBe(3);
  });
});
