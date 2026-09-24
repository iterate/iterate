import { describe, expect, test } from "vitest";
import { unwrapBrowserRunQuickAction } from "./browser.ts";

// The unwrap contract behind itx.browser.quickAction: callers get the
// action's RESULT, never the binding's Response envelope. The binding is an
// external service (local dev cannot dial it), so this pure function carries the
// contract.
describe("unwrapBrowserRunQuickAction", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

  test("returns the envelope's result for successful JSON actions", async () => {
    await expect(
      unwrapBrowserRunQuickAction("markdown", json({ success: true, result: "# Hello" })),
    ).resolves.toBe("# Hello");
    await expect(
      unwrapBrowserRunQuickAction(
        "links",
        json({ success: true, result: ["https://a", "https://b"] }),
      ),
    ).resolves.toEqual(["https://a", "https://b"]);
  });

  test("throws the envelope's error on failure", async () => {
    await expect(
      unwrapBrowserRunQuickAction("markdown", json({ success: false, error: "page timed out" })),
    ).rejects.toThrow(/Browser Run markdown failed: "page timed out"/);
  });

  test("returns binary media as bytes", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const result = await unwrapBrowserRunQuickAction(
      "screenshot",
      new Response(png, { headers: { "content-type": "image/png" } }),
    );
    expect(result).toBeInstanceOf(Uint8Array);
    expect([...(result as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("passes through JSON that is not the success/result envelope", async () => {
    await expect(unwrapBrowserRunQuickAction("json", json({ title: "raw" }))).resolves.toEqual({
      title: "raw",
    });
  });
});
