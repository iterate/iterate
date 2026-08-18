import { describe, expect, it } from "vitest";

import { envs } from "../../envs.ts";
import type { ScannerPathPolicyEntry } from "../../infra/cloudflare-edge-gate/policy.ts";
import { CloudflareApiError } from "../lib/env-context.ts";
import {
  compileScannerGateRule,
  reconcileEdgeGate,
  type EdgeGateClient,
  type EdgeGateTarget,
  resolveEdgeGateTarget,
} from "./reconcile.ts";

const phasePath = "/rulesets/phases/http_request_firewall_custom/entrypoint";
const expression = 'lower(http.request.uri.path) in {"/.env" "/.git/config" "/.git/head"}';
const description = "Block reviewed source and secret disclosure probes before Workers";
const preview: EdgeGateTarget = {
  envName: "preview_12",
  accountId: "account",
  zones: [
    { name: "iterate-preview-12.app", smokeHostname: "edge-gate-smoke.iterate-preview-12.app" },
  ],
};
const production: EdgeGateTarget = {
  envName: "prd",
  accountId: "account",
  zones: [
    { name: "iterate.app", smokeHostname: "edge-gate-smoke.iterate.app" },
    { name: "iterate.com", smokeHostname: "iterate.com" },
  ],
};

describe("policy compiler", () => {
  it("sorts reviewed exact paths", () => {
    expect(compileScannerGateRule().expression).toBe(expression);
  });

  it.each([
    ["uppercase", [entry("/WP-ADMIN")]],
    ["well-known", [entry("/.well-known/acme-challenge")]],
    ["duplicate", [entry("/.env"), entry("/.env")]],
    ["empty", []],
    ["size limit", [entry(`/${"a".repeat(4_100)}`)]],
  ])("rejects %s policy mistakes", (_name, entries) => {
    expect(() => compileScannerGateRule(entries)).toThrow();
  });
});

it("derives production and preview zones from envs.ts", () => {
  expect(resolveEdgeGateTarget("prd", envs.prd).zones).toEqual(production.zones);
  expect(resolveEdgeGateTarget("preview_12", envs.preview_12).zones).toEqual(preview.zones);
  expect(() => resolveEdgeGateTarget("dev", envs.prd)).toThrow(/not a production or preview/);
});

it("preserves unrelated rules and accepts their action parameters", async () => {
  const { client, done } = scripted([
    ...present("iterate-preview-12.app", "preview-id", [
      blockRule(),
      { id: "other", action: "skip", action_parameters: { ruleset: "current" } },
    ]),
  ]);
  await expect(reconcileEdgeGate("plan", preview, client)).resolves.toEqual([]);
  done();
});

it("adopts the preview rule without changing its immutable reference", async () => {
  const legacy = { ...blockRule(), ref: "block-id", expression: "false" };
  const { client, done } = scripted([
    ...present("iterate-preview-12.app", "preview-id", [legacy]),
    step("PATCH", "/zones/preview-id/rulesets/entrypoint-id/rules/block-id", {
      body: withoutRef(blockRule()),
    }),
    ...present("iterate-preview-12.app", "preview-id", [{ ...blockRule(), ref: "block-id" }]),
  ]);
  await expect(reconcileEdgeGate("apply", preview, client)).resolves.toEqual([
    { action: "update", resource: "iterate-preview-12.app edge-gate rule" },
  ]);
  done();
});

it("creates both production zone rules and proves zero drift", async () => {
  const { client, done } = scripted([
    ...absent("iterate.app", "app-id"),
    ...absent("iterate.com", "com-id"),
    ...present("iterate.app", "app-id", [blockRule()]),
    ...present("iterate.com", "com-id", [blockRule()]),
  ]);
  await expect(reconcileEdgeGate("apply", production, client)).resolves.toEqual([
    { action: "create", resource: "iterate.app phase entrypoint" },
    { action: "create", resource: "iterate.com phase entrypoint" },
  ]);
  done();
});

it("fails closed when rule ownership is ambiguous", async () => {
  const { client } = scripted([
    ...present("iterate-preview-12.app", "preview-id", [
      blockRule(),
      { ...blockRule(), id: "duplicate" },
    ]),
  ]);
  await expect(reconcileEdgeGate("plan", preview, client)).rejects.toThrow(/duplicate/);
});

interface Step {
  method: string;
  path: string;
  body?: unknown;
  response?: unknown;
  error?: Error;
}

function scripted(source: Step[]) {
  const steps = [...source];
  const client: EdgeGateClient = {
    cfV4: async <T>(path: string, init?: RequestInit) => {
      const expected = steps.shift();
      expect(expected, `Unexpected ${init?.method ?? "GET"} ${path}`).toBeDefined();
      expect({ method: init?.method ?? "GET", path }).toEqual({
        method: expected?.method,
        path: expected?.path,
      });
      if (expected?.body) expect(JSON.parse(String(init?.body))).toEqual(expected.body);
      if (expected?.error) throw expected.error;
      // The scripted fixture supplies the generic response requested by the code under test.
      return structuredClone(expected?.response) as T;
    },
  };
  return { client, done: () => expect(steps).toEqual([]) };
}

function absent(name: string, id: string): Step[] {
  const path = `/zones/${id}${phasePath}`;
  return [
    zone(name, id),
    { method: "GET", path, error: new CloudflareApiError("GET", path, 404, []) },
    step("POST", `/zones/${id}/rulesets`, {
      body: {
        name: "iterate-scanner-gate",
        kind: "zone",
        phase: "http_request_firewall_custom",
        description: "Iterate edge gate",
        rules: [withoutId(blockRule())],
      },
    }),
  ];
}

function present(name: string, id: string, rules: unknown[]): Step[] {
  return [
    zone(name, id),
    step("GET", `/zones/${id}${phasePath}`, { response: { id: "entrypoint-id", rules } }),
  ];
}

function zone(name: string, id: string): Step {
  return step("GET", `/zones?account.id=account&name=${encodeURIComponent(name)}&per_page=50`, {
    response: [{ id, name }],
  });
}

function step(method: string, path: string, options: Omit<Step, "method" | "path"> = {}): Step {
  return { method, path, ...options };
}

function blockRule() {
  return {
    id: "block-id",
    ref: "iterate_scanner_gate_block",
    action: "block",
    description,
    enabled: true,
    expression,
  };
}

function entry(path: string): ScannerPathPolicyEntry {
  return { path, reason: "test", evidence: { observedOn: "2026-08-17", productionInvocations: 1 } };
}

function withoutId<T extends { id: string }>(value: T) {
  const { id: _id, ...rest } = value;
  return rest;
}

function withoutRef(value: ReturnType<typeof blockRule>) {
  const { id: _id, ref: _ref, ...rest } = value;
  return rest;
}
