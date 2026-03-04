import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.ts";

const sqlite = new Database(":memory:");
sqlite.exec(`
  CREATE TABLE events (
    id text PRIMARY KEY NOT NULL,
    type text NOT NULL,
    external_id text,
    payload text,
    created_at integer DEFAULT (unixepoch())
  );
`);

const testDb = drizzle(sqlite, { schema });

vi.mock("../db/index.ts", () => ({
  db: testDb,
}));

const { posthogRouter } = await import("./posthog.ts");

describe("posthog router", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    sqlite.exec("DELETE FROM events;");
    fetchSpy.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("routes webhook to deterministic alert path and includes subscribe command", async () => {
    const response = await posthogRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deliveryId: "ph-1",
        payload: {
          alert: {
            id: "alert_abc",
            name: "Error spike",
            severity: "critical",
            url: "https://eu.posthog.com/project/1/alerts/abc",
          },
          body: "Exception rate exceeded threshold",
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/agents/posthog/alert/alert-abc",
      expect.objectContaining({ method: "POST" }),
    );

    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
      events: Array<{ message: string }>;
    };
    expect(requestBody.events[0]?.message).toContain("@error-pulse");
    expect(requestBody.events[0]?.message).toContain("subscribe-slack-thread");
  });

  it("deduplicates repeated delivery ids", async () => {
    const payload = {
      deliveryId: "ph-dup-1",
      payload: { alert: { id: "alert_dup" } },
    };

    const first = await posthogRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const second = await posthogRouter.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(second.json()).resolves.toMatchObject({ duplicate: true });
  });
});
