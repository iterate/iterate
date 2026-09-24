// src/project/custom-hostnames.test.ts — which hostnames a project may add (a table), and the
// Cloudflare for SaaS calls behind one, against a fake API: find-or-create, the DNS records its owner
// is shown, delete.
import { expect, test } from "vitest";
import type { AppConfig } from "../app-config.ts";
import { cloudflareCustomHostnameProvider, customHostnameProblem } from "./custom-hostnames.ts";

const reserved = ["iterate.com", "iterate.app", "garple.com"];
const rows: [hostname: string, problem: string | null][] = [
  ["www.example.com", null],
  ["example.com", null],
  ["shop.example.co.uk", null],
  [
    "localhost",
    "'localhost' is not a hostname (letters, digits and hyphens, at least two labels, like www.example.com).",
  ],
  [
    "*.example.com",
    "'*.example.com' is not a hostname (letters, digits and hyphens, at least two labels, like www.example.com).",
  ],
  [
    "WWW.example.com",
    "'WWW.example.com' is not a hostname (letters, digits and hyphens, at least two labels, like www.example.com).",
  ],
  ["iterate.com", "'iterate.com' is under iterate.com, which this deployment serves itself."],
  [
    "agents.iterate.com",
    "'agents.iterate.com' is under iterate.com, which this deployment serves itself.",
  ],
  [
    "x--shop.iterate.app",
    "'x--shop.iterate.app' is under iterate.app, which this deployment serves itself.",
  ],
  ["www.garple.com", "'www.garple.com' is under garple.com, which this deployment serves itself."],
  ["notiterate.com", null],
  ["xn--bcher-kva.example", null],
  [
    "-shop.example.com",
    "'-shop.example.com' is not a hostname (letters, digits and hyphens, at least two labels, like www.example.com).",
  ],
];
for (const [hostname, problem] of rows)
  test(`customHostnameProblem: ${hostname}`, () =>
    expect(customHostnameProblem(hostname, reserved)).toBe(problem));

test("cloudflareCustomHostnameProvider: none without a token", () => {
  expect(
    cloudflareCustomHostnameProvider({ ...config("token-1"), customHostnames: undefined }),
  ).toBeNull();
  expect(cloudflareCustomHostnameProvider(config(""))).toBeNull();
});

test("cloudflareCustomHostnameProvider: provision finds or creates with an HTTP DV certificate, and reports the CNAME to add; remove deletes what exists", async () => {
  const hostnames: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const bodies: unknown[] = [];
  const fetcher = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    requests.push(`${init?.method || "GET"} ${url.pathname}${url.search}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-1");
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (url.pathname.endsWith("/zones")) return ok([{ id: "zone-1" }]);
    if (init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)));
      const created = {
        id: "ch-1",
        ...(JSON.parse(String(init.body)) as object),
        status: "pending",
        ssl: { status: "pending_validation", validation_errors: [{ message: "no CNAME yet" }] },
      };
      hostnames.push(created);
      return ok(created);
    }
    if (init?.method === "DELETE") {
      hostnames.length = 0;
      return ok({ id: "ch-1" });
    }
    return ok(hostnames);
  }) as typeof fetch;
  const provider = cloudflareCustomHostnameProvider(config("token-1"), fetcher)!;
  const expected = {
    status: "pending",
    sslStatus: "pending_validation",
    records: [{ type: "CNAME", name: "www.shop.test", value: "cname.iterate.app" }],
    errors: ["no CNAME yet"],
  };
  expect(await provider.provision("www.shop.test")).toEqual(expected);
  expect(bodies).toEqual([
    {
      hostname: "www.shop.test",
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
    },
  ]);
  expect(await provider.provision("www.shop.test")).toEqual(expected);
  await provider.remove("www.shop.test");
  await provider.remove("www.shop.test");
  expect(requests).toEqual([
    "GET /client/v4/zones?name=iterate.app",
    "GET /client/v4/zones/zone-1/custom_hostnames?hostname=www.shop.test",
    "POST /client/v4/zones/zone-1/custom_hostnames",
    "GET /client/v4/zones/zone-1/custom_hostnames?hostname=www.shop.test",
    "GET /client/v4/zones/zone-1/custom_hostnames?hostname=www.shop.test",
    "DELETE /client/v4/zones/zone-1/custom_hostnames/ch-1",
    "GET /client/v4/zones/zone-1/custom_hostnames?hostname=www.shop.test",
  ]);
});

function config(token: string): Pick<AppConfig, "customHostnames" | "cloudflareApiToken"> {
  return {
    customHostnames: { zone: "iterate.app", reservedZones: [] },
    cloudflareApiToken: { exposeSecret: () => token } as never,
  };
}
