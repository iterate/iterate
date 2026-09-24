// src/project/custom-hostnames.test.ts — which hostnames a project may add (a table), and the
// Cloudflare for SaaS calls behind one, against a fake API: find-or-create, the DNS records its owner
// is shown, delete.
import { expect, test } from "vitest";
import type { AppConfig } from "../app-config.ts";
import {
  cloudflareCustomHostnameProvider,
  customHostnameProblem,
  customHostnameRecords,
} from "./custom-hostnames.ts";

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

test("customHostnameRecords: the hostname and every name under it to the fallback origin, and _acme-challenge delegated to Cloudflare", () => {
  expect(customHostnameRecords("iterate.somedomain.com", SAAS)).toEqual([
    { name: "iterate.somedomain.com", value: "cname.iterate.app" },
    { name: "*.iterate.somedomain.com", value: "cname.iterate.app" },
    {
      name: "_acme-challenge.iterate.somedomain.com",
      value: "iterate.somedomain.com.dcv-uuid.dcv.cloudflare.com",
    },
  ]);
});

test("cloudflareCustomHostnameProvider: provision finds or creates a wildcard custom hostname validated over TXT; remove deletes what exists", async () => {
  const hostnames: { id: string; hostname: string; status: string }[] = [];
  const requests: string[] = [];
  const fetcher = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    requests.push(`${init?.method || "GET"} ${url.pathname.split("/zone-1/")[1]}${url.search}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-1");
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({
        hostname: "iterate.shop.test",
        ssl: { method: "txt", type: "dv", wildcard: true, settings: { min_tls_version: "1.2" } },
      });
      hostnames.push({ id: "ch-1", hostname: "iterate.shop.test", status: "pending" });
      return ok(hostnames[0]);
    }
    if (init?.method === "DELETE") return ok({ id: hostnames.pop()!.id });
    return ok(hostnames);
  }) as typeof fetch;
  const provider = cloudflareCustomHostnameProvider(config("token-1"), fetcher)!;
  const expected = {
    status: "pending",
    sslStatus: "unknown",
    records: customHostnameRecords("iterate.shop.test", SAAS),
  };
  expect(await provider.provision("iterate.shop.test")).toEqual(expected);
  expect(await provider.provision("iterate.shop.test")).toEqual(expected);
  await provider.remove("iterate.shop.test");
  await provider.remove("iterate.shop.test");
  expect(requests).toEqual([
    "GET custom_hostnames?hostname=iterate.shop.test",
    "POST custom_hostnames",
    "GET custom_hostnames?hostname=iterate.shop.test",
    "GET custom_hostnames?hostname=iterate.shop.test",
    "DELETE custom_hostnames/ch-1",
    "GET custom_hostnames?hostname=iterate.shop.test",
  ]);
});

const SAAS = {
  zone: "iterate.app",
  zoneId: "zone-1",
  dcvDelegationUuid: "dcv-uuid",
  reservedZones: [],
};

function config(token: string): Pick<AppConfig, "customHostnames" | "cloudflareApiToken"> {
  return { customHostnames: SAAS, cloudflareApiToken: { exposeSecret: () => token } as never };
}
