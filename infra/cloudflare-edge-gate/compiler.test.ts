import assert from "node:assert/strict";
import test from "node:test";

import { compileProductionDeploymentExpression, compileScannerGateRule } from "./compiler.ts";
import { scannerPathPolicy, type ScannerPathPolicyEntry } from "./policy.ts";

const validEntry: ScannerPathPolicyEntry = {
  path: "/probe",
  reason: "Test-only exact probe path.",
  evidence: {
    observedOn: "2026-08-17",
    productionInvocations: 1,
  },
};

test("compiles the reviewed policy into one stable exact-path block rule", () => {
  assert.deepEqual(compileScannerGateRule(scannerPathPolicy), {
    action: "block",
    description: "Block reviewed source and secret disclosure probes before Workers",
    enabled: true,
    expression: 'lower(http.request.uri.path) in {"/.env" "/.git/config" "/.git/head"}',
  });
});

test("rejects an empty policy", () => {
  assert.throws(() => compileScannerGateRule([]), /at least one exact path/);
});

test("rejects broad or non-normalized paths", () => {
  assert.throws(
    () => compileScannerGateRule([{ ...validEntry, path: "/WP-LOGIN.php" }]),
    /exact, lowercase URI path/,
  );
  assert.throws(
    () => compileScannerGateRule([{ ...validEntry, path: "/.well-known/acme-challenge" }]),
    /could break domain validation/,
  );
});

test("rejects duplicate paths and missing evidence", () => {
  assert.throws(() => compileScannerGateRule([validEntry, validEntry]), /Duplicate scanner path/);
  assert.throws(
    () =>
      compileScannerGateRule([
        {
          ...validEntry,
          evidence: { ...validEntry.evidence, productionInvocations: 0 },
        },
      ]),
    /positive observed count/,
  );
});

test("compiles a stable Enterprise production deployment expression", () => {
  assert.equal(
    compileProductionDeploymentExpression(["iterate.com", "iterate.app"]),
    '(cf.zone.plan eq "ENT" and cf.zone.name in {"iterate.app" "iterate.com"})',
  );
});

test("rejects empty, duplicate, or invalid production zone sets", () => {
  assert.throws(() => compileProductionDeploymentExpression([]), /at least one zone/);
  assert.throws(
    () => compileProductionDeploymentExpression(["iterate.app", "iterate.app"]),
    /duplicate zone name/,
  );
  assert.throws(
    () => compileProductionDeploymentExpression(['iterate.app"']),
    /Invalid production scanner-gate zone/,
  );
});
