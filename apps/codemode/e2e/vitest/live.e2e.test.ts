import { describe, expect, it } from "vitest";

describe("live codemode", () => {
  it("serves the new run page", async () => {
    const baseUrl = process.env.CODEMODE_BASE_URL?.trim().replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error(
        "CODEMODE_BASE_URL is required. Example: CODEMODE_BASE_URL=https://codemode-stg.iterate.com pnpm test:e2e",
      );
    }

    const response = await fetch(`${baseUrl}/runs-v2-new`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain("Codemode");
    expect(body).toContain("Run codemode");
    expect(body).toContain("Reset starter");
  });
});
