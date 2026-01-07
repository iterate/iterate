import { test, expect } from "@playwright/test";

test.describe("realtime pusher", () => {
  test("mutation broadcasts invalidation via WebSocket", async ({ page, baseURL }) => {
    const realtimeMessages: string[] = [];

    page.on("websocket", (ws) => {
      // Only track messages from our realtime WebSocket
      if (ws.url().includes("/api/ws/realtime")) {
        console.log("[TEST] Realtime WebSocket opened:", ws.url());
        ws.on("framereceived", (frame) => {
          console.log("[TEST] Realtime WS frame:", frame.payload?.toString());
          realtimeMessages.push(frame.payload?.toString() || "");
        });
      }
    });

    await page.goto(`${baseURL}/login`);

    // Wait for WebSocket to connect
    await page.waitForTimeout(3000);

    console.log("[TEST] Messages so far:", realtimeMessages);
    // Check we got CONNECTED message (our DO sends uppercase CONNECTED)
    expect(realtimeMessages.some((msg) => msg.includes("CONNECTED"))).toBe(true);

    // Trigger a mutation
    const triggerResult = await page.evaluate(async () => {
      const res = await fetch("/api/trpc/testing.triggerInvalidation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      return { ok: res.ok, status: res.status };
    });
    console.log("[TEST] Mutation result:", triggerResult);
    expect(triggerResult.ok).toBe(true);

    // Wait for broadcast
    await page.waitForTimeout(2000);

    console.log("[TEST] All messages:", realtimeMessages);
    expect(realtimeMessages.some((msg) => msg.includes("INVALIDATE_ALL"))).toBe(true);
  });

  test("two clients both receive invalidation broadcast", async ({ browser, baseURL }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

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

    await Promise.all([page1.goto(`${baseURL}/login`), page2.goto(`${baseURL}/login`)]);

    // Wait for WebSocket connections
    await page1.waitForTimeout(3000);
    await page2.waitForTimeout(1000);

    console.log("[TEST] Page2 messages after connect:", page2Messages);
    expect(page2Messages.some((msg) => msg.includes("CONNECTED"))).toBe(true);

    // Trigger mutation from page1
    await page1.evaluate(async () => {
      await fetch("/api/trpc/testing.triggerInvalidation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    });

    await page2.waitForTimeout(2000);

    console.log("[TEST] Page2 all messages:", page2Messages);
    expect(page2Messages.some((msg) => msg.includes("INVALIDATE_ALL"))).toBe(true);

    await context1.close();
    await context2.close();
  });
});
