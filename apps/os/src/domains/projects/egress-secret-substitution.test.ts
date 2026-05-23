import { describe, expect, it, vi } from "vitest";
import {
  parseSecretReferences,
  substituteProjectEgressSecretHeaders,
} from "./egress-secret-substitution.ts";

describe("parseSecretReferences", () => {
  it("parses simple single-quoted and double-quoted getSecret references", () => {
    expect(
      parseSecretReferences({
        header: "x-test",
        value: `Bearer getSecret({ key: "openai" }) and getSecret({ key: 'slack.access_token' })`,
      }),
    ).toEqual({
      ok: true,
      references: [
        { key: "openai", source: `getSecret({ key: "openai" })` },
        { key: "slack.access_token", source: `getSecret({ key: 'slack.access_token' })` },
      ],
    });
  });

  it("parses JSON5 getSecret arguments", () => {
    expect(
      parseSecretReferences({
        header: "x-test",
        value: `Bearer getSecret("openai") and getSecret({ key: 'slack.access_token', reason: 'e2e' })`,
      }),
    ).toEqual({
      ok: true,
      references: [
        { key: "openai", source: `getSecret("openai")` },
        {
          key: "slack.access_token",
          source: `getSecret({ key: 'slack.access_token', reason: 'e2e' })`,
        },
      ],
    });
  });

  it("parses quoted keys that contain parentheses", () => {
    expect(
      parseSecretReferences({
        header: "x-test",
        value: `Bearer getSecret({ key: "foo)bar" }) and getSecret('baz)qux')`,
      }),
    ).toEqual({
      ok: true,
      references: [
        { key: "foo)bar", source: `getSecret({ key: "foo)bar" })` },
        { key: "baz)qux", source: `getSecret('baz)qux')` },
      ],
    });
  });

  it("fails when a getSecret reference is ambiguous", () => {
    expect(
      parseSecretReferences({
        header: "x-test",
        value: `getSecret({ key: process.env.OPENAI_API_KEY })`,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        header: "x-test",
        message: `Project egress secret substitution failed: Could not parse Secret reference getSecret({ key: process.env.OPENAI_API_KEY }) in header "x-test".`,
      },
    });
  });
});

describe("substituteProjectEgressSecretHeaders", () => {
  it("substitutes real secret material when no Project Egress Intercept Tunnel is active", async () => {
    const getSecret = vi.fn(async () => ({ material: "real-secret-value" }));
    const result = await substituteProjectEgressSecretHeaders({
      headers: new Headers({
        "x-api-key": `prefix getSecret({ key: "openai" }) suffix`,
      }),
      projectEgressInterceptActive: false,
      secrets: {
        getSecretOrNull: getSecret,
        getSecretSummaryByKeyOrNull: vi.fn(),
      },
    });

    expect(result).toMatchObject({ ok: true, substituted: true });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.headers.get("x-api-key")).toBe("prefix real-secret-value suffix");
    expect(getSecret).toHaveBeenCalledWith({ key: "openai" });
  });

  it("substitutes secret material containing dollar replacement tokens literally", async () => {
    const material = "real-$&-$'-$$-secret";
    const result = await substituteProjectEgressSecretHeaders({
      headers: new Headers({
        "x-api-key": `prefix getSecret({ key: "openai" }) suffix`,
      }),
      projectEgressInterceptActive: false,
      secrets: {
        getSecretOrNull: vi.fn(async () => ({ material })),
        getSecretSummaryByKeyOrNull: vi.fn(),
      },
    });

    expect(result).toMatchObject({ ok: true, substituted: true });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.headers.get("x-api-key")).toBe(`prefix ${material} suffix`);
  });

  it("substitutes descriptive withheld text when a Project Egress Intercept Tunnel is active", async () => {
    const getSecret = vi.fn();
    const getSecretSummaryByKeyOrNull = vi.fn(async () => ({ id: "sec_test" }));
    const result = await substituteProjectEgressSecretHeaders({
      headers: new Headers({
        "x-api-key": `getSecret({ key: "openai" })`,
      }),
      projectEgressInterceptActive: true,
      secrets: {
        getSecretOrNull: getSecret,
        getSecretSummaryByKeyOrNull,
      },
    });

    expect(result).toMatchObject({ ok: true, substituted: true });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.headers.get("x-api-key")).toBe(
      `Secret value withheld because this Project Egress Intercept Tunnel is active. Requested "getSecret({ key: \\"openai\\" })"`,
    );
    expect(getSecret).not.toHaveBeenCalled();
    expect(getSecretSummaryByKeyOrNull).toHaveBeenCalledWith({ key: "openai" });
  });

  it("fails descriptively when a referenced secret is missing", async () => {
    await expect(
      substituteProjectEgressSecretHeaders({
        headers: new Headers({
          "x-api-key": `getSecret({ key: "missing" })`,
        }),
        projectEgressInterceptActive: false,
        secrets: {
          getSecretOrNull: vi.fn(async () => null),
          getSecretSummaryByKeyOrNull: vi.fn(),
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        header: "x-api-key",
        message: `Project egress secret substitution failed: Secret not found for key "missing".`,
        secretKey: "missing",
      },
    });
  });
});
