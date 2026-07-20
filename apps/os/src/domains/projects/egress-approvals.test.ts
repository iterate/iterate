import { createPrivateKey, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import {
  buildApprovalMessage,
  bytesToBase64,
  canonicalJson,
  derSignatureToRaw,
  EgressRule,
  evaluateGrant,
  matchEgressRule,
  verifyApprovalSignature,
  type HumanApprovalKey,
} from "./egress-approvals.ts";

const rule = (overrides: Partial<EgressRule> & Pick<EgressRule, "ruleKey">): EgressRule => ({
  description: "",
  match: {},
  verdict: "hold",
  approvalTimeoutMs: 600_000,
  ...overrides,
});

describe("matchEgressRule", () => {
  const request = (overrides: Partial<Parameters<typeof matchEgressRule>[1]> = {}) => ({
    method: "POST",
    url: "https://api.stripe.com/v1/transfers",
    secretPaths: [],
    ...overrides,
  });

  test("matches host exactly and via *. wildcard, case-insensitively", () => {
    const exact = rule({ ruleKey: "exact", match: { hosts: ["API.stripe.com"] } });
    const wildcard = rule({ ruleKey: "wild", match: { hosts: ["*.stripe.com"] } });
    expect(matchEgressRule([exact], request())?.ruleKey).toBe("exact");
    expect(matchEgressRule([wildcard], request())?.ruleKey).toBe("wild");
    // The wildcard needs a subdomain: bare stripe.com is not *.stripe.com.
    expect(matchEgressRule([wildcard], request({ url: "https://stripe.com/x" }))).toBeUndefined();
    expect(matchEgressRule([exact], request({ url: "https://evil.com/x" }))).toBeUndefined();
    // Suffix tricks don't count as subdomains.
    expect(
      matchEgressRule([wildcard], request({ url: "https://notstripe.com/x" })),
    ).toBeUndefined();
  });

  test("matches methods case-insensitively and pathPrefix literally", () => {
    const posts = rule({ ruleKey: "posts", match: { methods: ["post", "DELETE"] } });
    expect(matchEgressRule([posts], request())?.ruleKey).toBe("posts");
    expect(matchEgressRule([posts], request({ method: "GET" }))).toBeUndefined();

    const path = rule({ ruleKey: "path", match: { pathPrefix: "/v1/transfers" } });
    expect(matchEgressRule([path], request())?.ruleKey).toBe("path");
    expect(
      matchEgressRule([path], request({ url: "https://api.stripe.com/v1/charges" })),
    ).toBeUndefined();
  });

  test("matches on referenced secret paths regardless of destination", () => {
    const secret = rule({ ruleKey: "secret", match: { secretPaths: ["/secrets/stripe/prod"] } });
    expect(
      matchEgressRule(
        [secret],
        request({ url: "https://anywhere.example", secretPaths: ["/secrets/stripe/prod"] }),
      )?.ruleKey,
    ).toBe("secret");
    expect(matchEgressRule([secret], request())).toBeUndefined();
  });

  test("first match wins over the ordered list; matchers are conjunctive", () => {
    const both = rule({
      ruleKey: "both",
      match: { hosts: ["api.stripe.com"], methods: ["POST"] },
      verdict: "deny",
    });
    const fallback = rule({ ruleKey: "fallback", match: { hosts: ["api.stripe.com"] } });
    expect(matchEgressRule([both, fallback], request())?.ruleKey).toBe("both");
    expect(matchEgressRule([both, fallback], request({ method: "GET" }))?.ruleKey).toBe("fallback");
    // A rule with an empty match object matches everything.
    expect(matchEgressRule([rule({ ruleKey: "all" })], request())?.ruleKey).toBe("all");
  });

  test("a rule that omits approvalTimeoutMs folds to a finite default, never NaN", () => {
    // The egress door computes `deadline = Date.now() + rule.approvalTimeoutMs`.
    // A rule reaches project state only through the reduce (which parses the
    // event payload with `z.array(EgressRule)`) or checkpoint hydration (which
    // re-parses the whole fold through the contract's stateSchema — the same
    // `z.array(EgressRule)`). Both apply `.default(600_000)`, so a missing
    // timeout is always filled. Were it ever left undefined the deadline would
    // be NaN: the held fetch would hang forever and the post-deadline sweep
    // would page resolution events without end.
    const timeoutless = {
      ruleKey: "stripe-writes",
      verdict: "hold" as const,
      match: { hosts: ["api.stripe.com"] },
    };

    // Reduce gate: the per-rule parse the event payloadSchema runs.
    expect(z.array(EgressRule).parse([timeoutless])[0].approvalTimeoutMs).toBe(600_000);

    // Checkpoint-hydration gate: the state schema re-parses the fold on load.
    const state = ProjectProcessorContract.stateSchema.parse({ egressRules: [timeoutless] });
    expect(state.egressRules[0].approvalTimeoutMs).toBe(600_000);
    expect(Number.isFinite(Date.now() + state.egressRules[0].approvalTimeoutMs)).toBe(true);
  });

  test("an unparseable URL never throws, and only disables host/path matchers", () => {
    const bad = request({ url: "not a url", secretPaths: ["/secrets/stripe/prod"] });
    expect(() => matchEgressRule([rule({ ruleKey: "all" })], bad)).not.toThrow();
    // Host / pathPrefix rules can't match a URL we can't parse.
    expect(
      matchEgressRule([rule({ ruleKey: "h", match: { hosts: ["api.stripe.com"] } })], bad),
    ).toBeUndefined();
    expect(
      matchEgressRule([rule({ ruleKey: "p", match: { pathPrefix: "/v1" } })], bad),
    ).toBeUndefined();
    // But method / secretPath rules still apply — a bad-URL request that spends
    // a held secret is still caught, not waived.
    expect(
      matchEgressRule(
        [rule({ ruleKey: "s", match: { secretPaths: ["/secrets/stripe/prod"] } })],
        bad,
      )?.ruleKey,
    ).toBe("s");
    expect(
      matchEgressRule([rule({ ruleKey: "m", match: { methods: ["POST"] } })], bad)?.ruleKey,
    ).toBe("m");
  });
});

describe("canonical approval message", () => {
  test("canonicalJson is key-order independent, recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: [{ y: 2, z: 1 }] }, b: 1 }),
    );
  });

  const requested = {
    method: "POST",
    url: "https://api.stripe.com/v1/transfers",
    headers: { authorization: 'Bearer getSecret("/secrets/stripe/prod")' },
    bodySha256: "9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430ba0aa",
    secretPaths: ["/secrets/stripe/prod"],
  };

  test("is deterministic and binds every covered field", () => {
    const message = (overrides: Partial<Parameters<typeof buildApprovalMessage>[0]> = {}) =>
      new TextDecoder().decode(
        buildApprovalMessage({
          projectId: "prj_1",
          approvalRequestEventOffset: 42,
          requested,
          decision: "granted",
          ...overrides,
        }),
      );
    expect(message()).toBe(message());
    expect(message({ decision: "rejected" })).not.toBe(message());
    expect(message({ approvalRequestEventOffset: 43 })).not.toBe(message());
    expect(message({ projectId: "prj_2" })).not.toBe(message());
    expect(message({ requested: { ...requested, url: "https://evil.example" } })).not.toBe(
      message(),
    );
  });
});

describe("verifyApprovalSignature", () => {
  async function keypair() {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const publicKey = bytesToBase64(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    );
    const sign = async (message: Uint8Array) =>
      bytesToBase64(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            pair.privateKey,
            message as BufferSource,
          ),
        ),
      );
    return { pair, publicKey, sign };
  }

  const message = buildApprovalMessage({
    projectId: "prj_1",
    approvalRequestEventOffset: 7,
    requested: {
      method: "DELETE",
      url: "https://api.example.com/prod-db",
      headers: {},
      bodySha256: null,
      secretPaths: [],
    },
    decision: "granted",
  });

  test("accepts a valid signature and refuses tampering, wrong keys, and garbage", async () => {
    const alice = await keypair();
    const mallory = await keypair();
    const signature = await alice.sign(message);

    await expect(
      verifyApprovalSignature({ publicKey: alice.publicKey, signature, message }),
    ).resolves.toBe(true);

    const tampered = buildApprovalMessage({
      projectId: "prj_1",
      approvalRequestEventOffset: 8,
      requested: {
        method: "DELETE",
        url: "https://api.example.com/prod-db",
        headers: {},
        bodySha256: null,
        secretPaths: [],
      },
      decision: "granted",
    });
    await expect(
      verifyApprovalSignature({ publicKey: alice.publicKey, signature, message: tampered }),
    ).resolves.toBe(false);
    await expect(
      verifyApprovalSignature({ publicKey: mallory.publicKey, signature, message }),
    ).resolves.toBe(false);
    await expect(
      verifyApprovalSignature({ publicKey: alice.publicKey, signature: "not-base64!!", message }),
    ).resolves.toBe(false);
    await expect(verifyApprovalSignature({ publicKey: "AAAA", signature, message })).resolves.toBe(
      false,
    );
  });

  test("evaluateGrant: plain grants pass only until a key is enrolled; revoked keys don't count", async () => {
    const alice = await keypair();
    const enrolled: HumanApprovalKey = {
      keyId: "alice",
      publicKey: alice.publicKey,
      label: "",
      addedAt: "2026-01-01T00:00:00.000Z",
      revokedAt: null,
    };
    const signature = await alice.sign(message);

    // Phase 1 — nothing enrolled: a plain grant is accepted.
    await expect(evaluateGrant({ grant: {}, keys: [], message })).resolves.toEqual({
      accepted: true,
    });
    // Only revoked keys = nothing enrolled.
    await expect(
      evaluateGrant({
        grant: {},
        keys: [{ ...enrolled, revokedAt: "2026-01-02T00:00:00.000Z" }],
        message,
      }),
    ).resolves.toEqual({ accepted: true });

    // Phase 2 — a key is enrolled: unsigned/unknown/bad grants are refused...
    await expect(evaluateGrant({ grant: {}, keys: [enrolled], message })).resolves.toMatchObject({
      accepted: false,
    });
    await expect(
      evaluateGrant({ grant: { keyId: "mallory", signature }, keys: [enrolled], message }),
    ).resolves.toMatchObject({ accepted: false });
    await expect(
      evaluateGrant({ grant: { keyId: "alice" }, keys: [enrolled], message }),
    ).resolves.toMatchObject({ accepted: false });
    // ...a revoked key's own valid signature is refused...
    await expect(
      evaluateGrant({
        grant: { keyId: "alice", signature },
        keys: [{ ...enrolled, revokedAt: "2026-01-02T00:00:00.000Z" }],
        message,
      }),
    ).resolves.toEqual({ accepted: true }); // revoked-only ⇒ back to phase 1
    // ...and a valid signature from the enrolled key releases.
    await expect(
      evaluateGrant({ grant: { keyId: "alice", signature }, keys: [enrolled], message }),
    ).resolves.toEqual({ accepted: true });
  });

  test("verifies a DER signature (the Secure Enclave shape) after derSignatureToRaw", async () => {
    // Mirror the enclave pipeline with node:crypto, which emits DER natively.
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicKeyRaw = new Uint8Array(
      // SPKI for P-256 is a fixed 26-byte header followed by the 65-byte point.
      publicKey.export({ format: "der", type: "spki" }).subarray(-65),
    );
    const signer = createSign("SHA256");
    signer.update(message);
    const der = new Uint8Array(
      signer.sign({ key: createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })) }),
    );

    await expect(
      verifyApprovalSignature({
        publicKey: bytesToBase64(publicKeyRaw),
        signature: bytesToBase64(derSignatureToRaw(der)),
        message,
      }),
    ).resolves.toBe(true);
  });
});
