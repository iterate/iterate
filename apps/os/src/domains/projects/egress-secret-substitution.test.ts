import { describe, expect, it, vi } from "vitest";
import {
  parseSecretReferences,
  substituteProjectEgressSecretHeaders,
} from "./egress-secret-substitution.ts";

describe("parseSecretReferences", () => {
  it("parses simple single-quoted and double-quoted getSecret references", () => {
    const [error, references] = parseSecretReferences({
      header: "x-test",
      value: `Bearer getSecret({ key: "openai" }) and getSecret({ key: 'slack.access_token' })`,
    });

    expect(error).toBeNull();
    expect(references).toEqual([
      { key: "openai", source: `getSecret({ key: "openai" })` },
      { key: "slack.access_token", source: `getSecret({ key: 'slack.access_token' })` },
    ]);
  });

  it("parses JSON5 getSecret arguments", () => {
    const [error, references] = parseSecretReferences({
      header: "x-test",
      value: `Bearer getSecret("openai") and getSecret({ key: 'slack.access_token', reason: 'e2e' })`,
    });

    expect(error).toBeNull();
    expect(references).toEqual([
      { key: "openai", source: `getSecret("openai")` },
      {
        key: "slack.access_token",
        source: `getSecret({ key: 'slack.access_token', reason: 'e2e' })`,
      },
    ]);
  });

  it("parses quoted keys that contain parentheses", () => {
    const [error, references] = parseSecretReferences({
      header: "x-test",
      value: `Bearer getSecret({ key: "foo)bar" }) and getSecret('baz)qux')`,
    });

    expect(error).toBeNull();
    expect(references).toEqual([
      { key: "foo)bar", source: `getSecret({ key: "foo)bar" })` },
      { key: "baz)qux", source: `getSecret('baz)qux')` },
    ]);
  });

  it("fails when a getSecret reference is ambiguous", async () => {
    const [error, references] = parseSecretReferences({
      header: "x-test",
      value: `getSecret({ key: process.env.OPENAI_API_KEY })`,
    });

    expect(references).toEqual([]);
    expect(error).not.toBeNull();
    if (!error) throw new Error("Expected parseSecretReferences to return an error response.");
    expect(error.status).toBe(400);
    await expect(error.json()).resolves.toMatchObject({
      error: "project_egress_secret_substitution_failed",
      header: "x-test",
      message: `Project egress secret substitution failed: Could not parse Secret reference getSecret({ key: process.env.OPENAI_API_KEY }) in header "x-test".`,
    });
  });
});

describe("substituteProjectEgressSecretHeaders", () => {
  it("substitutes real secret material when no Project Egress Intercept Tunnel is active", async () => {
    const getSecret = vi.fn(async () => ({ material: "real-secret-value" }));
    const [error, headers] = await substituteProjectEgressSecretHeaders({
      headers: new Headers({
        "x-api-key": `prefix getSecret({ key: "openai" }) suffix`,
      }),
      secrets: {
        getSecretOrNull: getSecret,
        getSecretSummaryByKeyOrNull: vi.fn(),
      },
    });

    expect(error).toBeNull();
    expect(headers).toEqual({ "x-api-key": "prefix real-secret-value suffix" });
    expect(getSecret).toHaveBeenCalledWith({ key: "openai" });
  });

  it("substitutes secret material containing dollar replacement tokens literally", async () => {
    const material = "real-$&-$'-$$-secret";
    const [error, headers] = await substituteProjectEgressSecretHeaders({
      headers: new Headers({
        "x-api-key": `prefix getSecret({ key: "openai" }) suffix`,
      }),
      secrets: {
        getSecretOrNull: vi.fn(async () => ({ material })),
        getSecretSummaryByKeyOrNull: vi.fn(),
      },
    });

    expect(error).toBeNull();
    expect(headers).toEqual({ "x-api-key": `prefix ${material} suffix` });
  });

  it("returns successful substitutions alongside a later missing-secret response", async () => {
    const [error, headers] = await substituteProjectEgressSecretHeaders({
      headers: new Headers({
        "x-api-key": `getSecret({ key: "openai" })`,
        "x-missing": `getSecret({ key: "missing" })`,
      }),
      secrets: {
        getSecretOrNull: vi.fn(async (input) =>
          input.key === "openai" ? { material: "real-secret-value" } : null,
        ),
        getSecretSummaryByKeyOrNull: vi.fn(),
      },
    });

    expect(error).not.toBeNull();
    if (!error) throw new Error("Expected missing secret to return an error response.");
    expect(error.status).toBe(400);
    expect(headers).toEqual({ "x-api-key": "real-secret-value" });
    await expect(error.json()).resolves.toMatchObject({
      error: "project_egress_secret_substitution_failed",
      header: "x-missing",
      message: `Project egress secret substitution failed: Secret not found for key "missing".`,
      secretKey: "missing",
    });
  });

  it("fails descriptively when a referenced secret is missing", async () => {
    const [error, headers] = await substituteProjectEgressSecretHeaders({
      headers: new Headers({
        "x-api-key": `getSecret({ key: "missing" })`,
      }),
      secrets: {
        getSecretOrNull: vi.fn(async () => null),
        getSecretSummaryByKeyOrNull: vi.fn(),
      },
    });

    expect(error).not.toBeNull();
    if (!error) throw new Error("Expected missing secret to return an error response.");
    expect(error.status).toBe(400);
    expect(headers).toEqual({});
    await expect(error.json()).resolves.toMatchObject({
      error: "project_egress_secret_substitution_failed",
      header: "x-api-key",
      message: `Project egress secret substitution failed: Secret not found for key "missing".`,
      secretKey: "missing",
    });
  });
});
