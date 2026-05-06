import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

type Hop = {
  index: number;
  kind: "route" | "entrypoint" | "durable-object" | "leaf";
  source: string;
  remaining: number;
};

type PublicResult = {
  request: {
    path: string;
    requestedRemaining?: number;
    headers: Record<string, string>;
  };
  response:
    | {
        ok: true;
        hops: Hop[];
      }
    | {
        ok: false;
        hops: Hop[];
        error: {
          name: string;
          message: string;
          stackFirstLine?: string;
        };
      };
};

describe("ctx.exports and Durable Object depth repro", () => {
  test("passes a shallow route -> WorkerEntrypoint -> Durable Object -> WorkerEntrypoint call", async () => {
    const response = await SELF.fetch("https://repro.local/shallow", {
      headers: {
        "x-repro-case": "shallow",
      },
    });
    const body = (await response.json()) as PublicResult;

    expect(response.status).toBe(200);
    expect(response.headers.get("x-repro-result")).toBe("ok");
    expect(body.request.headers["x-repro-case"]).toBe("shallow");
    expect(body.response).toEqual({
      ok: true,
      hops: [
        { index: 0, kind: "route", source: "fetch", remaining: 0 },
        { index: 1, kind: "entrypoint", source: "route-shallow", remaining: 0 },
        { index: 2, kind: "durable-object", source: "do-shallow", remaining: 0 },
        { index: 3, kind: "leaf", source: "do-shallow", remaining: 0 },
      ],
    });
  });

  test("passes a bounded route -> WorkerEntrypoint -> Durable Object recursion", async () => {
    const response = await SELF.fetch("https://repro.local/recurse?remaining=2", {
      headers: {
        "x-repro-case": "bounded",
      },
    });
    const body = (await response.json()) as PublicResult;

    expect(response.status).toBe(200);
    expect(response.headers.get("x-repro-result")).toBe("ok");
    expect(body.response.ok).toBe(true);
    expect(body.response.hops).toHaveLength(7);
    expect(body.response.hops.map((hop) => hop.kind)).toEqual([
      "route",
      "entrypoint",
      "durable-object",
      "entrypoint",
      "durable-object",
      "entrypoint",
      "durable-object",
    ]);
  });

  test("intentionally repeats enough to expose whether workerd reports a loop/depth limit", async () => {
    const requestedRemaining = 128;
    const response = await SELF.fetch(
      `https://repro.local/recurse?remaining=${requestedRemaining}`,
      {
        headers: {
          "x-repro-case": "limit",
        },
      },
    );
    const body = (await response.json()) as PublicResult;

    expect(response.status).toBe(200);
    expect(body.request.headers["x-repro-case"]).toBe("limit");

    if (body.response.ok) {
      expect(response.headers.get("x-repro-result")).toBe("ok");
      expect(body.response.hops).toHaveLength(1 + requestedRemaining * 2 + 2);
    } else {
      expect(response.headers.get("x-repro-result")).toBe("error");
      expect(body.response.error.name).toBe("Error");
      expect(body.response.error.message).toMatch(
        /Cannot perform I\/O on behalf of a different request|Subrequest depth|recursive/i,
      );
    }
  });
});
