// fetch-policy.e2e.test.ts — the deployment-admin secret write is outside ITX; egress sees only
// metadata, and an ordinary policy fact turns a direct secret request into a durable approval gate.

import { expect, test } from "vitest";
import { append, freshCtx, openItx, workerUrl } from "./support/client.ts";

const ADMIN = { authorization: "Bearer e2e-admin-token", "content-type": "application/json" };

test("admin writes encrypted direct secrets while ITX exposes receipts only, then policy gates egress", async () => {
  const context = freshCtx("fetch_policy");
  const denied = await fetch(workerUrl(`/secrets?context=${encodeURIComponent(context)}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "TOKEN",
      value: "never-in-a-stream",
      origin: "https://egress.invalid",
    }),
  });
  expect(denied.status).toBe(401);

  const stored = await fetch(workerUrl(`/secrets?context=${encodeURIComponent(context)}`), {
    method: "POST",
    headers: ADMIN,
    body: JSON.stringify({
      name: "TOKEN",
      value: "never-in-a-stream",
      origin: "https://egress.invalid",
    }),
  });
  expect(stored.status).toBe(200);
  expect(await stored.json()).toEqual({
    name: "TOKEN",
    origin: "https://egress.invalid",
    revision: 1,
  });

  const itx = openItx(context);
  expect(await itx.secrets.list()).toEqual([
    { name: "TOKEN", origin: "https://egress.invalid", revision: 1 },
  ]);
  expect(JSON.stringify(await itx.secrets.list())).not.toContain("never-in-a-stream");

  await append(itx, {
    type: "events.iterate.com/egress/policy-configured",
    payload: { approval: "required", expiresInMs: 60_000 },
  });
  const result = await itx.fetch(
    new Request("https://egress.invalid/", { headers: { authorization: "{{secret:TOKEN}}" } }),
  );
  expect(result.status).toBe(202);
  const gate = (await result.json()) as { code: string; requestId: string; fingerprint: string };
  expect(gate.code).toBe("APPROVAL_REQUIRED");
  expect(gate.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(gate.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(JSON.stringify(gate)).not.toContain("never-in-a-stream");
  expect(await itx.approvals.pending()).toEqual([
    expect.objectContaining({
      requestId: gate.requestId,
      origin: "https://egress.invalid",
      method: "GET",
      policyRevision: expect.any(Number),
      allow: null,
      used: false,
    }),
  ]);

  // A retry is bound to the policy captured in its fingerprint. Turning approval off cannot turn
  // that stale retry header into a new, unreviewed outbound request.
  await append(itx, {
    type: "events.iterate.com/egress/policy-configured",
    payload: { approval: "none" },
  });
  const staleRetry = await itx.fetch(
    new Request("https://egress.invalid/", {
      headers: {
        authorization: "{{secret:TOKEN}}",
        "x-iterate-approval": gate.requestId,
      },
    }),
  );
  expect(staleRetry.status).toBe(409);
  expect(await staleRetry.json()).toEqual({ code: "APPROVAL_MISMATCH" });
});

test("a new direct-secret token embedded in a URL fails before egress", async () => {
  const result = await openItx(freshCtx("fetch_policy_ref")).fetch(
    new Request("https://egress.invalid/?credential={{secret:TOKEN}}"),
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({ code: "SECRET_REFERENCE" });
});

test("a direct secret is never disclosed to a different origin", async () => {
  const context = freshCtx("fetch_policy_origin");
  await fetch(workerUrl(`/secrets?context=${encodeURIComponent(context)}`), {
    method: "POST",
    headers: ADMIN,
    body: JSON.stringify({
      name: "TOKEN",
      value: "never-in-a-stream",
      origin: "https://egress.invalid",
    }),
  });
  const result = await openItx(context).fetch(
    new Request("https://other.invalid/", { headers: { authorization: "{{secret:TOKEN}}" } }),
  );
  expect(result.status).toBe(403);
  expect(await result.json()).toEqual({ code: "SECRET_ORIGIN" });
});
