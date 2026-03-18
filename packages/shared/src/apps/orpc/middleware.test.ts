import { call, ORPCError, os } from "@orpc/server";
import { describe, expect, it } from "vitest";
import type { AppInitialContext, AppManifest } from "../../define-app.ts";
import { requireHeader, withRequestLogger } from "./middleware.ts";

interface TestEnv {
  PIRATE_SECRET: string;
}

type TestAppContext = AppInitialContext<TestEnv>;

function makeManifest(): AppManifest {
  return {
    packageName: "@iterate-com/example-app",
    version: "1.2.3",
    slug: "example-app",
    description: "Example app manifest",
  };
}

function makeContext(headers?: Headers): TestAppContext {
  return {
    manifest: makeManifest(),
    req: {
      headers: headers ?? new Headers(),
      url: "https://example.test/api/ping",
    },
    env: {
      PIRATE_SECRET: "blackbeard",
    },
  };
}

describe("shared app orpc middleware", () => {
  it("injects a required header into execution context", async () => {
    const procedure = os
      .$context<TestAppContext>()
      .use(
        requireHeader({
          header: "x-api-key",
          as: "apiKey",
          missingCode: "UNAUTHORIZED",
        }),
      )
      .handler(async ({ context }) => ({
        apiKey: context.headerValues.apiKey,
        slug: context.manifest.slug,
      }));

    await expect(
      call(procedure, undefined, {
        context: makeContext(new Headers({ "x-api-key": "shanty" })),
      }),
    ).resolves.toEqual({ apiKey: "shanty", slug: "example-app" });
  });

  it("rejects when a required header is missing", async () => {
    const procedure = os
      .$context<TestAppContext>()
      .use(
        requireHeader({
          header: "x-api-key",
          as: "apiKey",
          missingCode: "UNAUTHORIZED",
        }),
      )
      .handler(async ({ context }) => ({
        apiKey: context.headerValues.apiKey,
      }));

    await expect(call(procedure, undefined, { context: makeContext() })).rejects.toMatchObject<
      Partial<ORPCError>
    >({
      code: "UNAUTHORIZED",
      message: "Missing required header: x-api-key",
    });
  });

  it("merges multiple required headers into one execution-context namespace", async () => {
    const procedure = os
      .$context<TestAppContext>()
      .use(
        requireHeader({
          header: "x-api-key",
          as: "apiKey",
        }),
      )
      .use(
        requireHeader({
          header: "x-org-id",
          as: "orgId",
        }),
      )
      .handler(async ({ context }) => ({
        apiKey: context.headerValues.apiKey,
        orgId: context.headerValues.orgId,
      }));

    await expect(
      call(procedure, undefined, {
        context: makeContext(new Headers({ "x-api-key": "shanty", "x-org-id": "org_123" })),
      }),
    ).resolves.toEqual({
      apiKey: "shanty",
      orgId: "org_123",
    });
  });

  it("injects a request id and logger without a full app runtime", async () => {
    const procedure = os
      .$context<TestAppContext>()
      .use(withRequestLogger())
      .handler(async ({ context }) => ({
        requestId: context.requestId,
        hasLogger: typeof context.logger.info === "function",
        slug: context.manifest.slug,
      }));

    await expect(
      call(procedure, undefined, {
        context: makeContext(new Headers({ "x-request-id": "req_123" })),
      }),
    ).resolves.toEqual({
      requestId: "req_123",
      hasLogger: true,
      slug: "example-app",
    });
  });
});
