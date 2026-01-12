import { Daytona } from "@daytonaio/sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolveLatestSnapshot } from "../backend/integrations/daytona/snapshot-resolver.ts";

const RUN_DAYTONA_TESTS = process.env.RUN_DAYTONA_TESTS === "true";
const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY;
const DAYTONA_ORGANIZATION_ID = process.env.DAYTONA_ORGANIZATION_ID;
const DAYTONA_API_URL = process.env.DAYTONA_API_URL;
const DAYTONA_TARGET = process.env.DAYTONA_TARGET;
const DAYTONA_SNAPSHOT_PREFIX = process.env.DAYTONA_SNAPSHOT_PREFIX;

type PreviewTarget = {
  url: string;
  token: string;
};

describe.runIf(RUN_DAYTONA_TESTS)("Daytona sandbox integration", () => {
  let sandboxId: string | null = null;
  let preview: PreviewTarget | null = null;
  let daytona: Daytona | null = null;

  beforeAll(async () => {
    if (!DAYTONA_API_KEY) {
      throw new Error("DAYTONA_API_KEY is required when RUN_DAYTONA_TESTS=true");
    }
    if (!DAYTONA_SNAPSHOT_PREFIX) {
      throw new Error("DAYTONA_SNAPSHOT_PREFIX is required when RUN_DAYTONA_TESTS=true");
    }

    const snapshotName = await resolveLatestSnapshot(DAYTONA_SNAPSHOT_PREFIX, {
      apiKey: DAYTONA_API_KEY,
      baseUrl: DAYTONA_API_URL,
      organizationId: DAYTONA_ORGANIZATION_ID,
    });

    daytona = new Daytona({
      apiKey: DAYTONA_API_KEY,
      organizationId: DAYTONA_ORGANIZATION_ID,
      apiUrl: DAYTONA_API_URL,
      target: DAYTONA_TARGET,
    });

    const sandbox = await daytona.create({
      name: `os2-daytona-test-${Date.now()}`,
      snapshot: snapshotName,
      public: true,
      autoStopInterval: 0,
      autoDeleteInterval: 0,
    });

    sandboxId = sandbox.id;
    await sandbox.start(300);
    preview = await sandbox.getPreviewLink(3000);
  }, 300_000);

  afterAll(async () => {
    if (!daytona || !sandboxId) return;
    try {
      const sandbox = await daytona.get(sandboxId);
      if (sandbox.state === "started") {
        await sandbox.stop(120);
      }
      await sandbox.delete();
    } catch (error) {
      console.error("Failed to clean up Daytona sandbox", error);
    }
  }, 180_000);

  test("iterate-server health check responds OK via preview URL", async () => {
    if (!preview) {
      throw new Error("Preview URL not initialized");
    }

    await expect
      .poll(
        async () => {
          const headers: Record<string, string> = {
            "X-Daytona-Skip-Preview-Warning": "true",
          };
          if (preview.token) {
            headers["X-Daytona-Preview-Token"] = preview.token;
          }

          const response = await fetch(`${preview.url}/api/health`, { headers });
          if (!response.ok) return false;
          const text = await response.text();
          return text.includes("ok") || text.includes("healthy");
        },
        { timeout: 120_000, interval: 3000 },
      )
      .toBe(true);
  }, 130_000);
});
