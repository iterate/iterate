import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";

test("worker answers /version", async () => {
  const res = await SELF.fetch("https://test.local/version");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("live-");
});
