import { expect, test } from "vitest";
import {
  buildApprovalMessage,
  evaluateDecision,
  verifyApprovalSignature,
} from "../../../os/src/domains/projects/egress-approvals.ts";
import { generateApproverKey, keyIdFor, signApprovalMessage } from "./approver-core.ts";

test("a phone-generated key signs a message the OS's real verifier accepts", async () => {
  const key = generateApproverKey();
  const message = buildApprovalMessage({
    projectId: "prj_test",
    approvalRequestEventOffset: 42,
    requests: [
      {
        method: "POST",
        url: "https://api.stripe.com/v1/transfers",
        headers: {},
        body: null,
        secretPaths: ["/secrets/stripe/prod"],
      },
    ],
    verdicts: ["approve"],
  });
  const signature = signApprovalMessage(key.privateKey, message);

  await expect(
    verifyApprovalSignature({ publicKey: key.publicKey, signature, message }),
  ).resolves.toBe(true);
});

test("evaluateDecision accepts a phone key's signed approval and rejects an unenrolled one", async () => {
  const key = generateApproverKey();
  const message = new TextEncoder().encode("approval.v2 fixture message");
  const signature = signApprovalMessage(key.privateKey, message);
  const enrolled = [
    {
      keyId: key.keyId,
      publicKey: key.publicKey,
      label: "phone",
      addedAt: "2026-01-01T00:00:00Z",
      revokedAt: null,
    },
  ];

  await expect(
    evaluateDecision({
      decision: { keyId: key.keyId, signature, verdicts: ["approve"] },
      keys: enrolled,
      message,
    }),
  ).resolves.toEqual({ accepted: true });

  const otherKey = generateApproverKey();
  await expect(
    evaluateDecision({
      decision: { keyId: otherKey.keyId, signature, verdicts: ["approve"] },
      keys: enrolled,
      message,
    }),
  ).resolves.toMatchObject({ accepted: false });
});

test("keyIdFor matches the fingerprint scheme egress-approvals.ts expects: 16 hex chars", () => {
  const key = generateApproverKey();
  expect(key.keyId).toBe(keyIdFor(key.publicKey));
  expect(key.keyId).toMatch(/^[0-9a-f]{16}$/);
});

test("the public key is an uncompressed P-256 point (65 bytes, starts 0x04)", () => {
  const key = generateApproverKey();
  const bytes = Uint8Array.from(atob(key.publicKey), (char) => char.charCodeAt(0));
  expect(bytes).toHaveLength(65);
  expect(bytes[0]).toBe(0x04);
});
