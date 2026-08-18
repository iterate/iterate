import assert from "node:assert/strict";
import test from "node:test";

import { PREVIEW_AND_DEV_ACCOUNT_ID, PRD_ACCOUNT_ID } from "../../envs.ts";
import { resolveEdgeGateTarget } from "./target.ts";

test("resolves the production account-level target from envs.ts", () => {
  assert.deepEqual(resolveEdgeGateTarget({ envName: "prd", cloudflareAccountId: PRD_ACCOUNT_ID }), {
    kind: "production",
    envName: "prd",
    accountId: PRD_ACCOUNT_ID,
    zoneNames: ["iterate.app", "iterate.com"],
  });
});

test("resolves a preview zone-level target from envs.ts", () => {
  assert.deepEqual(
    resolveEdgeGateTarget({
      envName: "preview_19",
      cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    }),
    {
      kind: "preview",
      envName: "preview_19",
      accountId: PREVIEW_AND_DEV_ACCOUNT_ID,
      zoneName: "iterate-preview-19.app",
    },
  );
});

test("refuses missing, unknown, and wrong-account targets", () => {
  assert.throws(
    () => resolveEdgeGateTarget({ envName: undefined, cloudflareAccountId: PRD_ACCOUNT_ID }),
    /EDGE_GATE_ENV is required/,
  );
  assert.throws(
    () => resolveEdgeGateTarget({ envName: "preview_99", cloudflareAccountId: PRD_ACCOUNT_ID }),
    /Unknown deployed edge-gate environment/,
  );
  assert.throws(
    () =>
      resolveEdgeGateTarget({
        envName: "preview_19",
        cloudflareAccountId: PRD_ACCOUNT_ID,
      }),
    /but Doppler selected/,
  );
});
