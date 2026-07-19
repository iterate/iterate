import { describe, expect, it } from "vitest";
import { streamDeploymentReadinessResponse } from "./deployment-readiness.ts";

describe("streams deployment readiness", () => {
  it("stays unready while a Durable Object incarnation is resetting", async () => {
    const response = await streamDeploymentReadinessResponse({
      version: "new-version",
      readDurableObjectVersions: async () => {
        throw Object.assign(new Error("Durable Object reset because its code was updated."), {
          durableObjectReset: true,
        });
      },
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("x-iterate-worker-version")).toBe("new-version");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      version: "new-version",
      durableObjectVersions: null,
      settlingReason: "durable-object-lifecycle",
    });
  });

  it("does not hide an application failure behind deployment readiness", async () => {
    const applicationError = new Error("invalid stream state");

    await expect(
      streamDeploymentReadinessResponse({
        version: "new-version",
        readDurableObjectVersions: async () => {
          throw applicationError;
        },
      }),
    ).rejects.toBe(applicationError);
  });

  it("stays unready while any probe serves the previous deployment", async () => {
    const response = await streamDeploymentReadinessResponse({
      version: "new-version",
      readDurableObjectVersions: async () => ["new-version", "old-version"],
    });

    expect(response.status).toBe(503);
  });

  it("becomes ready only when every probe serves the edge deployment", async () => {
    const response = await streamDeploymentReadinessResponse({
      version: "new-version",
      readDurableObjectVersions: async () => ["new-version", "new-version"],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-iterate-worker-version")).toBe("new-version");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      version: "new-version",
      durableObjectVersions: ["new-version", "new-version"],
    });
  });
});
