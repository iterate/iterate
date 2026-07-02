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

  test("turns a snippet pasted into another page into a screenshot-capable PageTools capability", async () => {
    const browser = await chromium.launch({ headless: true });
    const demoPage = await browser.newPage();
    const targetPage = await browser.newPage();

    try {
      await demoPage.goto(buildUrl({ path: "/page-debugging" }));
      await demoPage.waitForFunction(() =>
        document.querySelector<HTMLTextAreaElement>("#snippet")?.value.includes("connectPageTools"),
      );

      const snippet = await demoPage.locator("#snippet").inputValue();
      expect(snippet).toContain("/page-debugging/client.mjs");
      expect(snippet).toContain("window.__itxPageDebugging");
      const initialSession = JSON.parse(
        (await demoPage.locator("#agentOutput").textContent()) ?? "{}",
      );
      expect(initialSession.projectId).toMatch(/^prj_page_debug_/);

      await targetPage.goto(buildUrl({ path: "/page-debugging" }));
      await targetPage.setContent(`
        <!doctype html>
        <html>
          <head><title>External Target Page</title></head>
          <body>
            <main style="font-family: system-ui; padding: 24px">
              <h1>External Target Page</h1>
              <button id="increment" type="button">Increment counter</button>
              <span id="counter" data-testid="counter">0</span>
              <label>Message <input id="message" aria-label="Message" placeholder="agent will fill this" /></label>
              <script>
                document.querySelector("#increment").addEventListener("click", () => {
                  const counter = document.querySelector("#counter");
                  counter.textContent = String(Number(counter.textContent || "0") + 1);
                });
              </script>
            </main>
          </body>
        </html>
      `);
      await targetPage.evaluate(async (code) => {
        await (0, eval)(code);
      }, snippet);
      const iterateWidgetButton = targetPage.getByLabel("Open ITERATE sharing menu");
      await expectText(iterateWidgetButton, "ITERATE");
      expect(await iterateWidgetButton.locator("svg[viewBox='0 0 500 500']").count()).toBe(1);
      await iterateWidgetButton.click();
      await expectText(targetPage.locator("#__itx_page_debugging_widget"), "Sharing with ITERATE");
      await expectText(targetPage.locator("#__itx_page_debugging_widget"), "Share a screenshot");
      await expectText(targetPage.locator("#__itx_page_debugging_widget"), "Stop sharing");

      // Agent controls are script buttons: pick one (by index), then Run.
      // 0=Snapshot, 1=Screenshot, 2=Click counter, 3=Fill message.
      const runAgentScript = async (index: number) => {
        await demoPage.locator("#agentExamples button").nth(index).click();
        await demoPage.locator("#agentRun").click();
      };

      await runAgentScript(2);
      await targetPage.waitForFunction(
        () => document.querySelector("#counter")?.textContent === "1",
      );
      expect(await targetPage.locator("#counter").textContent()).toBe("1");
      await demoPage.waitForFunction(() =>
        document.querySelector("#agentOutput")?.textContent?.includes('"counter": "1"'),
      );
      expect(await demoPage.locator("#agentOutput").textContent()).toContain('"counter": "1"');

      await runAgentScript(3);
      await targetPage.waitForFunction(
        () => document.querySelector<HTMLInputElement>("#message")?.value === "hello from ITX",
      );
      expect(await targetPage.locator("#message").inputValue()).toBe("hello from ITX");
      await demoPage.waitForFunction(() =>
        document
          .querySelector("#agentOutput")
          ?.textContent?.includes('"message": "hello from ITX"'),
      );
      expect(await demoPage.locator("#agentOutput").textContent()).toContain(
        '"message": "hello from ITX"',
      );

      await runAgentScript(0);
      await demoPage.waitForFunction(() =>
        document.querySelector("#agentOutput")?.textContent?.includes("Increment counter"),
      );
      expect(await demoPage.locator("#agentOutput").textContent()).toContain("Increment counter");

      await runAgentScript(1);
      await demoPage.waitForFunction(() =>
        document
          .querySelector<HTMLImageElement>("#screenshotPreview")
          ?.src.startsWith("data:image/jpeg;base64,"),
      );
      expect(await demoPage.locator("#screenshotMeta").textContent()).toContain("via render");
      expect(await demoPage.locator("#agentOutput").textContent()).toContain('"mode": "render"');

      await demoPage.locator("#runHere").click();
      await demoPage.waitForFunction(() =>
        document.querySelector("#targetStatus")?.textContent?.includes("Snippet connected"),
      );

      await demoPage.locator("#generateSnippet").click();
      await demoPage.waitForFunction((previousProjectId) => {
        const output = JSON.parse(document.querySelector("#agentOutput")?.textContent ?? "{}");
        return output.projectId !== previousProjectId;
      }, initialSession.projectId);
      await demoPage.locator("#runHere").click();
      await demoPage.waitForFunction(() =>
        document.querySelector("#targetStatus")?.textContent?.includes("Snippet connected"),
      );

      await runAgentScript(2);
      await demoPage.waitForFunction(() => document.querySelector("#counter")?.textContent === "1");
      expect(await demoPage.locator("#counter").textContent()).toBe("1");

      await targetPage.getByRole("button", { name: "Stop sharing" }).click();
      await targetPage.waitForFunction(
        () => !document.querySelector("#__itx_page_debugging_widget"),
      );
    } finally {
      await browser.close();
    }
  }, 45_000);
});

async function expectText(locator: { textContent(): Promise<string | null> }, expected: string) {
  expect(await locator.textContent()).toContain(expected);
}
