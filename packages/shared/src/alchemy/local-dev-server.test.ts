import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareLocalDevServer,
  readLocalDevServerInfo,
  releaseLocalDevServerInfo,
} from "./local-dev-server.ts";

describe("prepareLocalDevServer", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("keeps the chosen port stable after a clean shutdown", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "iterate-local-dev-"));
    tempDirs.push(appDir);

    const first = await prepareLocalDevServer({ ALCHEMY_LOCAL: "true" }, { appDir });
    expect(first).not.toBeNull();

    releaseLocalDevServerInfo(appDir, first!.pid);

    expect(readLocalDevServerInfo(appDir)).toMatchObject({
      port: first!.port,
      baseUrl: first!.baseUrl,
      stoppedAt: expect.any(String),
    });
    expect(readLocalDevServerInfo(appDir, { requireLive: true })).toBeNull();

    const second = await prepareLocalDevServer({ ALCHEMY_LOCAL: "true" }, { appDir });
    expect(second?.port).toBe(first!.port);
  });
});
