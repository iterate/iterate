import { describe, expect, it, vi } from "vitest";
import {
  parseSecretReferences,
  ProjectEgressSecretSubstitutionError,
  substituteProjectEgressSecretHeaders,
} from "./egress-secret-substitution.ts";

describe("parseSecretReferences", () => {
  it("parses simple single-quoted and double-quoted getSecret references", () => {
    expect(
      parseSecretReferences({
        header: "x-test",
        value: `Bearer getSecret({ key: "openai" }) and getSecret({ key: 'slack.access_token' })`,
      }),
    ).toEqual([
      { key: "openai", source: `getSecret({ key: "openai" })` },
      { key: "slack.access_token", source: `getSecret({ key: 'slack.access_token' })` },
    ]);
  });

  it("fails when a getSecret reference is ambiguous", () => {
    expect(() =>
      parseSecretReferences({
        header: "x-test",
        value: `getSecret({ key: process.env.OPENAI_API_KEY })`,
      }),
    ).toThrow(ProjectEgressSecretSubstitutionError);
  });
});

describe("substituteProjectEgressSecretHeaders", () => {
  it("substitutes real secret material when no external proxy URL is configured", async () => {
    const getSecret = vi.fn(async () => ({ material: "real-secret-value" }));
    const result = await substituteProjectEgressSecretHeaders({
      externalEgressProxyUrl: null,
      headers: new Headers({
        "x-api-key": `prefix getSecret({ key: "openai" }) suffix`,
      }),
      secrets: {
        getSecretOrNull: getSecret,
        getSecretSummaryByKeyOrNull: vi.fn(),
      },
    });

    expect(result.substituted).toBe(true);
    expect(result.headers.get("x-api-key")).toBe("prefix real-secret-value suffix");
    expect(getSecret).toHaveBeenCalledWith({ key: "openai" });
  });

  it("substitutes secret material containing dollar replacement tokens literally", async () => {
    const material = "real-$&-$'-$$-secret";
    const result = await substituteProjectEgressSecretHeaders({
      externalEgressProxyUrl: null,
      headers: new Headers({
        "x-api-key": `prefix getSecret({ key: "openai" }) suffix`,
      }),
      secrets: {
        getSecretOrNull: vi.fn(async () => ({ material })),
        getSecretSummaryByKeyOrNull: vi.fn(),
      },
    });

    expect(result.headers.get("x-api-key")).toBe(`prefix ${material} suffix`);
  });

  it("substitutes descriptive withheld text when an external proxy URL is configured", async () => {
    const getSecret = vi.fn();
    const getSecretSummaryByKeyOrNull = vi.fn(async () => ({ id: "sec_test" }));
    const result = await substituteProjectEgressSecretHeaders({
      externalEgressProxyUrl: "https://proxy.example.com",
      headers: new Headers({
        "x-api-key": `getSecret({ key: "openai" })`,
      }),
      secrets: {
        getSecretOrNull: getSecret,
        getSecretSummaryByKeyOrNull,
      },
    });

    expect(result.headers.get("x-api-key")).toBe(
      `Secret value withheld because this project uses externalEgressProxyUrl. Requested getSecret({ key: "openai" })`,
    );
    expect(getSecret).not.toHaveBeenCalled();
    expect(getSecretSummaryByKeyOrNull).toHaveBeenCalledWith({ key: "openai" });
  });

  it("fails descriptively when a referenced secret is missing", async () => {
    await expect(
      substituteProjectEgressSecretHeaders({
        externalEgressProxyUrl: null,
        headers: new Headers({
          "x-api-key": `getSecret({ key: "missing" })`,
        }),
        secrets: {
          getSecretOrNull: vi.fn(async () => null),
          getSecretSummaryByKeyOrNull: vi.fn(),
        },
      }),
    ).rejects.toMatchObject({
      header: "x-api-key",
      message: `Project egress secret substitution failed: Secret not found for key "missing".`,
      secretKey: "missing",
    });
  });
});
