import { extractPublicConfigSchema } from "@iterate-com/shared/apps/config";
import { describe, expect, test } from "vitest";
import { AppConfig } from "../../src/app.ts";

const PublicConfigSchema = extractPublicConfigSchema(AppConfig);
const agentsBaseUrl = process.env.AGENTS_BASE_URL?.trim();
/** Opt-in: production/staging agents URL must respond (Cloudflare 522 if origin is down). */
const runRuntimeSmoke =
  process.env.AGENTS_E2E_RUNTIME_SMOKE === "1" && Boolean(agentsBaseUrl) && !process.env.CI;
const describeRuntimeSmoke = runRuntimeSmoke ? describe : describe.skip;

describeRuntimeSmoke("agents runtime smoke", () => {
  test("homepage, public config, openapi docs, and sample procedure respond", async () => {
    const homepage = await fetch(new URL("/", agentsBaseUrl), {
      signal: AbortSignal.timeout(8_000),
    });
    expect(homepage.ok).toBe(true);

    const homepageHtml = await homepage.text();
    expect(homepageHtml).toContain("hello world");
    expect(homepageHtml).toContain("Call sample procedure");

    const publicConfigResponse = await fetch(
      new URL("/api/__internal/public-config", agentsBaseUrl),
      {
        signal: AbortSignal.timeout(8_000),
      },
    );
    expect(publicConfigResponse.ok).toBe(true);
    const publicConfig = PublicConfigSchema.parse(await publicConfigResponse.json());
    expect(publicConfig.posthog?.apiKey ?? "").toEqual(expect.any(String));

    const openApiResponse = await fetch(new URL("/api/openapi.json", agentsBaseUrl), {
      signal: AbortSignal.timeout(8_000),
    });
    expect(openApiResponse.ok).toBe(true);
    const openApi = (await openApiResponse.json()) as { paths?: Record<string, unknown> };
    expect(openApi.paths ?? {}).toHaveProperty("/hello");

    const helloResponse = await fetch(new URL("/api/hello", agentsBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "world" }),
      signal: AbortSignal.timeout(8_000),
    });
    expect(helloResponse.ok).toBe(true);
    expect(await helloResponse.json()).toEqual({ message: "hello world" });
  });
});
