import { expect, test } from "vitest";
import {
  reusableSubstitutionSnapshot,
  SUBSTITUTION_SNAPSHOT_MAX_AGE_MS,
} from "./substitution-snapshot-reuse.ts";

const state = { updatedOffset: 7 };
const READ_AT = 5_000_000;

const rows: Array<{
  name: string;
  held: boolean;
  ageMs: number;
  revision: Parameters<typeof reusableSubstitutionSnapshot>[0]["revision"];
  becomes: "held" | "read-again";
}> = [
  {
    name: "nothing held yet",
    held: false,
    ageMs: 0,
    revision: { kind: "any-revision" },
    becomes: "read-again",
  },
  {
    name: "fresh copy serves any revision",
    held: true,
    ageMs: 10,
    revision: { kind: "any-revision" },
    becomes: "held",
  },
  {
    name: "copy at the age bound still serves",
    held: true,
    ageMs: SUBSTITUTION_SNAPSHOT_MAX_AGE_MS,
    revision: { kind: "any-revision" },
    becomes: "held",
  },
  {
    name: "copy past the age bound is read again",
    held: true,
    ageMs: SUBSTITUTION_SNAPSHOT_MAX_AGE_MS + 1,
    revision: { kind: "any-revision" },
    becomes: "read-again",
  },
  {
    name: "exact revision matching the copy serves",
    held: true,
    ageMs: 10,
    revision: { kind: "exact-revision", updatedOffset: 7 },
    becomes: "held",
  },
  {
    name: "exact revision the copy predates is read again",
    held: true,
    ageMs: 10,
    revision: { kind: "exact-revision", updatedOffset: 9 },
    becomes: "read-again",
  },
];

for (const row of rows) {
  test(row.name, () => {
    const result = reusableSubstitutionSnapshot({
      held: row.held ? { state, readAtMs: READ_AT } : undefined,
      nowMs: READ_AT + row.ageMs,
      revision: row.revision,
    });
    expect(result === null ? "read-again" : "held").toBe(row.becomes);
    if (row.becomes === "held") expect(result).toBe(state);
  });
}
