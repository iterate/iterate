import { chromium } from "playwright";
import { describe, expect, test } from "vitest";
import { buildUrl } from "./test-helpers.ts";

describe("page debugging demo", () => {
  test("serves a browser client module with the expected public exports", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await page.goto(buildUrl({ path: "/page-debugging" }));
      const exports = await page.evaluate(() => {
        return new Promise<string[]>((resolve, reject) => {
          const testWindow = window as Window & {
            __pageDebuggingClientExports?: string[];
          };
          const script = document.createElement("script");
          script.type = "module";
          script.textContent = `
            import * as mod from "/page-debugging/client.mjs";
            window.__pageDebuggingClientExports = Object.keys(mod).sort();
            window.dispatchEvent(new Event("page-debugging-client-loaded"));
          `;
          window.addEventListener(
            "page-debugging-client-loaded",
            () => {
              resolve(testWindow.__pageDebuggingClientExports ?? []);
            },
            { once: true },
          );
          script.addEventListener("error", () => reject(new Error("Failed to load client module")));
          document.head.appendChild(script);
        });
      });
      expect(exports).toEqual(["Locator", "PageTools", "connectPageItx", "connectPageTools"]);
    } finally {
      await browser.close();
    }
  }, 20_000);

  test("keeps the demo session and connect endpoints on their expected methods", async () => {
    await expect(fetch(buildUrl({ path: "/page-debugging/session" }))).resolves.toMatchObject({
      status: 405,
    });
    await expect(fetch(buildUrl({ path: "/page-debugging/connect" }))).resolves.toMatchObject({
      status: 401,
    });
  });

  test("turns the hosted console snippet into a browser-backed PageTools capability", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await page.goto(buildUrl({ path: "/page-debugging" }));
      await page.waitForFunction(() =>
        document.querySelector<HTMLTextAreaElement>("#snippet")?.value.includes("connectPageTools"),
      );

      const snippet = await page.locator("#snippet").inputValue();
      expect(snippet).toContain("/page-debugging/client.mjs");
      expect(snippet).toContain("window.__itxPageDebugging");
      const initialSession = JSON.parse((await page.locator("#agentOutput").textContent()) ?? "{}");
      expect(initialSession.projectId).toMatch(/^prj_page_debug_/);

      await page.evaluate(async (code) => {
        await (0, eval)(code);
      }, snippet);

      await page.locator("#agentClick").click();
      await page.waitForFunction(() => document.querySelector("#counter")?.textContent === "1");
      expect(await page.locator("#counter").textContent()).toBe("1");

      await page.locator("#agentFill").click();
      await page.waitForFunction(
        () => document.querySelector<HTMLInputElement>("#message")?.value === "hello from ITX",
      );
      expect(await page.locator("#message").inputValue()).toBe("hello from ITX");

      await page.locator("#agentSnapshot").click();
      await page.waitForFunction(() =>
        document.querySelector("#agentOutput")?.textContent?.includes("Increment counter"),
      );
      expect(await page.locator("#agentOutput").textContent()).toContain("Increment counter");

      await page.locator("#generateSnippet").click();
      await page.waitForFunction((previousProjectId) => {
        const output = JSON.parse(document.querySelector("#agentOutput")?.textContent ?? "{}");
        return (
          output.projectId !== previousProjectId &&
          document.querySelector("#targetStatus")?.textContent?.includes("Snippet connected")
        );
      }, initialSession.projectId);

      await page.locator("#agentClick").click();
      await page.waitForFunction(() => document.querySelector("#counter")?.textContent === "2");
      expect(await page.locator("#counter").textContent()).toBe("2");
    } finally {
      await browser.close();
    }
  }, 45_000);
});
