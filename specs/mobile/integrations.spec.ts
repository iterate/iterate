// The mobile integration catalogue through the real phone-sized web build.
// A fresh project intentionally has no third-party credentials: the useful
// deterministic boundary is real signup → project drawer → real
// integrations.list()/getConnection() reads → every connect surface. Provider
// OAuth and Telegram token validation stop at external systems and do not get
// faked into a misleading green test.

import { expect } from "@playwright/test";
import { test } from "../test-support/test.ts";

test("opens the project integration catalogue from the mobile drawer", async ({
  page,
  helpers,
}) => {
  await using _fixture = await helpers.createMobileFixture("mobile-integrations");

  await page.getByLabel("Open project menu").filter({ visible: true }).click();
  await page.getByRole("button", { name: "/agents" }).waitFor();
  await page.getByRole("button", { name: "/repos" }).waitFor();
  await page.getByRole("button", { name: "/integrations" }).click();

  await page.getByText("Connectable integrations", { exact: true }).waitFor();
  await expect.poll(() => page.getByText("Not connected", { exact: true }).count()).toBe(4);
  await expect
    .poll(() => page.getByRole("button", { name: "Connect", exact: true }).count())
    .toBe(5);
  await page.getByText("Slack", { exact: true }).waitFor();
  await page.getByText("Google", { exact: true }).waitFor();
  await page.getByText("GitHub", { exact: true }).waitFor();
  await page.getByText("Telegram", { exact: true }).waitFor();
  await page.getByText("Account connections", { exact: true }).waitFor();

  await page.getByText("Built-in integrations", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByText("itx.integrations.parallel", { exact: true }).waitFor();
  await page.getByText("itx.mcp.exa", { exact: true }).waitFor();
  await page.getByText("itx.ai", { exact: true }).waitFor();
});
