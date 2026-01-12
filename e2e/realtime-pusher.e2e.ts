import { expect } from "@playwright/test";
import { test } from "./test-helpers.ts";

test.describe("realtime pusher", () => {
  test("mutation broadcasts invalidation via WebSocket", async ({ page }) => {
    const realtimeMessages: string[] = [];

    page.on("websocket", (ws) => {
      if (ws.url().includes("/api/ws/realtime")) {
        console.log("[TEST] Realtime WebSocket opened:", ws.url());
        ws.on("framereceived", (frame) => {
          console.log("[TEST] Realtime WS frame:", frame.payload?.toString());
          realtimeMessages.push(frame.payload?.toString() || "");
        });
      }
    });

    await page.goto("/login");

    await expect
      .poll(() => realtimeMessages)
      .toEqual(expect.arrayContaining([expect.stringContaining("CONNECTED")]));

    const triggerResult = () =>
      page.evaluate(async () => {
        const res = await fetch("/api/trpc/testing.triggerInvalidation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        return { ok: res.ok, status: res.status, text: await res.text() };
      });
    await expect.poll(() => triggerResult()).toMatchObject({ ok: true });
    console.log("[TEST] Mutation result:", await triggerResult());

    await expect
      .poll(() => realtimeMessages)
      .toEqual(expect.arrayContaining([expect.stringContaining("INVALIDATE_ALL")]));
  });

  test("two clients both receive invalidation broadcast", async ({ browser, baseURL }) => {
    const context1 = await browser.newContext({ baseURL });
    const context2 = await browser.newContext({ baseURL });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const page2Messages: string[] = [];

    page2.on("websocket", (ws) => {
      if (ws.url().includes("/api/ws/realtime")) {
        ws.on("framereceived", (frame) => {
          page2Messages.push(frame.payload?.toString() || "");
        });
      }
    });

    await Promise.all([page1.goto("/login"), page2.goto("/login")]);

    await expect
      .poll(() => page2Messages)
      .toEqual(expect.arrayContaining([expect.stringContaining("CONNECTED")]));

    await page1.evaluate(async () => {
      await fetch("/api/trpc/testing.triggerInvalidation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    });

    await expect
      .poll(() => page2Messages)
      .toEqual(expect.arrayContaining([expect.stringContaining("INVALIDATE_ALL")]));

    await context1.close();
    await context2.close();
  });
});
