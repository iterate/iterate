import { test, expect } from "@playwright/test";

test.describe("terminal", () => {
  test("PTY WebSocket connects and receives shell output", async ({ page, baseURL }) => {
    const wsMessages: string[] = [];
    let wsConnected = false;

    page.on("websocket", (ws) => {
      if (ws.url().includes("/ws/pty")) {
        wsConnected = true;
        ws.on("framereceived", (frame) => {
          const payload = frame.payload?.toString();
          if (payload) wsMessages.push(payload);
        });
      }
    });

    await page.goto(`${baseURL}/pty`);
    await expect(page.locator("#status")).toHaveText("Connected", { timeout: 5000 });
    expect(wsConnected).toBe(true);

    // Wait for shell output - some shells may take a moment to initialize
    await expect.poll(() => wsMessages.length, { timeout: 5000 }).toBeGreaterThan(0);
  });
});
