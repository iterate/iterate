import { extractPublicConfigSchema } from "@iterate-com/shared/apps/config";
import { expect, test } from "vitest";
import { AppConfig } from "../../src/app.ts";

const PublicConfigSchema = extractPublicConfigSchema(AppConfig);
const agentsBaseUrl = process.env.AGENTS_BASE_URL?.trim();
const runRuntimeSmoke =
  process.env.AGENTS_E2E_RUNTIME_SMOKE === "1" && Boolean(agentsBaseUrl) && !process.env.CI;

const testFn = runRuntimeSmoke ? test : test.skip;

testFn(
  "homepage, public config, openapi docs, and sample procedure respond",
  { tags: ["deployed-live-worker", "live-internet"] },
  async () => {
    const homepage = await fetch(new URL("/", agentsBaseUrl), {
      signal: AbortSignal.timeout(8_000),
    });
    expect(homepage.ok).toBe(true);

    const homepageHtml = await homepage.text();
    expect(homepageHtml).toContain("hello world");
    expect(homepageHtml).toContain("Call sample procedure");

    const publicConfigResponse = await fetch(
      new URL("/api/__internal/public-config", agentsBaseUrl),
      { signal: AbortSignal.timeout(8_000) },
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "world" }),
      signal: AbortSignal.timeout(8_000),
    });
    expect(helloResponse.ok).toBe(true);
    expect(await helloResponse.json()).toEqual({ message: "hello world" });
  },
);
