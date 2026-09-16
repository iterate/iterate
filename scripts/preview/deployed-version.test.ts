import { expect, test } from "vitest";
import { servesRecordedWorkerVersion } from "./deployed-version.ts";

test("the current deployment must send all traffic to the recorded version", () => {
  const recorded = { version_id: "recorded", percentage: 100 };
  const replaced = { version_id: "replacement", percentage: 100 };
  const old = { created_on: "2026-09-16T22:00:00Z", versions: [recorded] };
  const current = { created_on: "2026-09-16T23:00:00Z", versions: [replaced] };
  expect(servesRecordedWorkerVersion({ deployments: [current, old] }, "recorded")).toBe(false);
  expect(servesRecordedWorkerVersion({ deployments: [current, old] }, "replacement")).toBe(true);
  expect(servesRecordedWorkerVersion({ deployments: [] }, "recorded")).toBe(false);
});

test("a mixed deployment cannot certify either revision", () => {
  const deployments = [
    {
      created_on: "2026-09-16T23:00:00Z",
      versions: [
        { version_id: "recorded", percentage: 50 },
        { version_id: "replacement", percentage: 50 },
      ],
    },
  ];
  expect(servesRecordedWorkerVersion({ deployments }, "recorded")).toBe(false);
});

test("an unexpected Cloudflare response is an error, not missing evidence", () => {
  expect(() => servesRecordedWorkerVersion({ deployments: [{}] }, "recorded")).toThrow();
});
