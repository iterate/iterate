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

  it("sets APP_CONFIG_BASE_URL to the discovered local URL when no app base URL exists", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "iterate-local-dev-"));
    tempDirs.push(appDir);
    const env: Record<string, string | undefined> = { ALCHEMY_LOCAL: "true" };

    const info = await prepareLocalDevServer(env, { appDir });

    expect(env).toMatchObject({
      APP_CONFIG_BASE_URL: info!.baseUrl,
      HOST: "127.0.0.1",
      PORT: String(info!.port),
    });
  });

  it("uses the configured public base URL", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "iterate-local-dev-"));
    tempDirs.push(appDir);
    const env: Record<string, string | undefined> = {
      ALCHEMY_LOCAL: "true",
      APP_CONFIG: JSON.stringify({ baseUrl: "https://misha.tunnels.iterate.com" }),
    };

    const info = await prepareLocalDevServer(env, { appDir });

    expect(env).toMatchObject({
      APP_CONFIG: JSON.stringify({ baseUrl: "https://misha.tunnels.iterate.com" }),
      APP_CONFIG_BASE_URL: "https://misha.tunnels.iterate.com",
      HOST: "127.0.0.1",
      PORT: String(info!.port),
    });
    expect(readLocalDevServerInfo(appDir)).toMatchObject({
      baseUrl: info!.baseUrl,
      port: info!.port,
    });
  });

  it("uses a captun tunnel name for the public base URL while preserving local discovery", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "iterate-local-dev-"));
    tempDirs.push(appDir);
    const env: Record<string, string | undefined> = {
      ALCHEMY_LOCAL: "true",
      CAPTUN_TUNNEL_NAME: "misha",
    };

    const info = await prepareLocalDevServer(env, { appDir });

    expect(env).toMatchObject({
      APP_CONFIG_BASE_URL: "https://misha.tunnels.iterate.com",
      HOST: "127.0.0.1",
      PORT: String(info!.port),
    });
    expect(readLocalDevServerInfo(appDir)).toMatchObject({
      baseUrl: info!.baseUrl,
      port: info!.port,
    });
    expect(info!.baseUrl).toBe(`http://localhost:${info!.port}`);
  });
});
