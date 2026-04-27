import { describe, expect, it, vi, beforeEach } from "vitest";
import { ORPCError } from "@orpc/server";
import { Hono } from "hono";

vi.mock("../auth/auth-context.ts", () => ({
  getProjectAccessFromAuthWorker: vi.fn(),
  isAuthWorkerAccessDeniedError: vi.fn((error: unknown) => {
    return error instanceof ORPCError && error.code === "FORBIDDEN";
  }),
}));

vi.mock("@iterate-com/sandbox/providers/machine-stub", () => ({
  createMachineStub: vi.fn(),
}));

vi.mock("../tag-logger.ts", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { machineProxyApp } from "./machine-proxy.ts";

describe("machine-proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 502 when the auth worker lookup fails", async () => {
    const { getProjectAccessFromAuthWorker } = await import("../auth/auth-context.ts");

    vi.mocked(getProjectAccessFromAuthWorker).mockRejectedValue(
      new ORPCError("INTERNAL_SERVER_ERROR", { message: "auth worker timeout" }),
    );

    const app = new Hono();
    app.use("*", async (c, next) => {
      (c as any).set("db", {
        query: {
          machine: {
            findFirst: vi.fn(),
          },
        },
      } as never);
      (c as any).set("session", {
        user: { id: "usr_123", authUserId: "auth_usr_123", role: "user" },
      } as never);
      await next();
    });
    app.route("/", machineProxyApp);

    const response = await app.request(
      "https://os.iterate.com/org/demo/proj/my-project/mach_123/proxy/3000/",
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Auth unavailable" });
  });
});
