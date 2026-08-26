import { expect, it } from "vitest";
import {
  clampAgentStreamLimit,
  classifySubscriptionHealth,
  DEFAULT_AGENT_STREAM_LIMIT,
  selectSubscriptionHealthStreamPaths,
} from "./subscription-health.ts";

it("tiers halted over lagging over historical lastError, omitting healthy rows", () => {
  expect(
    classifySubscriptionHealth(
      entry({ status: "halted", lag: 12, lastError: "userspace reaction threw" }),
    ),
  ).toMatchObject({ tier: "halted", lag: 12 });

  // Backing off = delivery not currently flowing, even before a halt.
  expect(
    classifySubscriptionHealth(
      entry({ nextAttemptAt: 1_753_000_000_000, attempt: 3, lastError: "HTTP 500" }),
    ),
  ).toMatchObject({ tier: "lagging", attempt: 3 });

  // A standing lastError with delivery flowing again: returned for the quiet
  // informational line, never a badge.
  expect(
    classifySubscriptionHealth(
      entry({ lastError: "skipped offset 41", lastErrorAt: "2026-08-22T00:00:00.000Z" }),
    ),
  ).toMatchObject({ tier: "informational", lastErrorAt: "2026-08-22T00:00:00.000Z" });

  expect(classifySubscriptionHealth(entry({}))).toBeNull();
});

it("scans the well-known platform streams plus the most recently active agents", () => {
  const streamsIndex = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [
      `/agents/agent-${index}`,
      { lastActivityAt: new Date(Date.UTC(2026, 7, 1 + index)).toISOString() },
    ]),
  );
  const paths = selectSubscriptionHealthStreamPaths({
    streamsIndex: { ...streamsIndex, "/guestbook": { lastActivityAt: "2026-08-25" } },
    catalogPaths: ["/agents/from-catalog-only"],
    agentStreamLimit: DEFAULT_AGENT_STREAM_LIMIT,
  });

  expect(paths.slice(0, 4)).toEqual([
    "/",
    "/repos/config",
    "/scheduler/primary",
    "/integrations/email",
  ]);
  const agentPaths = paths.slice(4);
  expect(agentPaths).toHaveLength(DEFAULT_AGENT_STREAM_LIMIT);
  // Most recent first; the 10 oldest (and the catalog-only path with no
  // recorded activity) fall outside the bound.
  expect(agentPaths[0]).toBe("/agents/agent-29");
  expect(agentPaths).not.toContain("/agents/agent-0");
  expect(agentPaths).not.toContain("/agents/from-catalog-only");
  // Non-agent, non-well-known streams are not scanned.
  expect(paths).not.toContain("/guestbook");
});

it("includes catalog-only agent streams when the bound has room", () => {
  const paths = selectSubscriptionHealthStreamPaths({
    streamsIndex: { "/agents/active": { lastActivityAt: "2026-08-25T00:00:00.000Z" } },
    catalogPaths: ["/agents/pre-index"],
    agentStreamLimit: DEFAULT_AGENT_STREAM_LIMIT,
  });
  expect(paths).toContain("/agents/active");
  expect(paths).toContain("/agents/pre-index");
});

it("lets a caller pick the agent fan-out, inside a hard cap", () => {
  expect(clampAgentStreamLimit(undefined)).toBe(DEFAULT_AGENT_STREAM_LIMIT);
  expect(clampAgentStreamLimit(3)).toBe(3);
  // 0 = platform streams only; negatives and fractions normalize.
  expect(clampAgentStreamLimit(0)).toBe(0);
  expect(clampAgentStreamLimit(-5)).toBe(0);
  expect(clampAgentStreamLimit(7.9)).toBe(7);
  // Every scanned stream is a Durable Object dial — no caller unbounds it.
  expect(clampAgentStreamLimit(10_000)).toBe(100);
  expect(clampAgentStreamLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_AGENT_STREAM_LIMIT);

  const paths = selectSubscriptionHealthStreamPaths({
    streamsIndex: {
      "/agents/a": { lastActivityAt: "2026-08-25T02:00:00.000Z" },
      "/agents/b": { lastActivityAt: "2026-08-25T01:00:00.000Z" },
    },
    catalogPaths: [],
    agentStreamLimit: 1,
  });
  expect(paths).toContain("/agents/a");
  expect(paths).not.toContain("/agents/b");
});

function entry(overrides: {
  status?: "active" | "halted";
  lag?: number;
  attempt?: number;
  nextAttemptAt?: number | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
}) {
  return {
    name: "project-worker",
    action: "itx-call",
    configuredAtOffset: 3,
    status: "active" as const,
    lag: 0,
    confirmedOffset: 40,
    attempt: 0,
    nextAttemptAt: null,
    lastError: null,
    lastErrorAt: null,
    ...overrides,
  };
}
