// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { AgentActivityRounds } from "./agent-activity-rounds.tsx";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { stringifyScriptResult, truncateScriptResult } from "~/lib/script-result-render.ts";

test("a result the agent saw in full keeps the raw view as the default", async () => {
  // The untransformed render embeds the exact stringified result — built
  // here through the same shared stringifyScriptResult the server render and
  // the component's containment check both use, proving the round-trip.
  const result = { ok: true };
  const agentRender =
    "Your script returned:\n```json\n" +
    stringifyScriptResult(result) +
    "\n```\n" +
    "This result is available to your next script as `results[0].data` (the preamble `results` array, newest first).";
  await using mounted = await renderRounds(
    databaseWithRenderEvent("agent-output:53", agentRender),
    codeStep({ result }),
  );
  const { host } = mounted;
  await clickResultTab(host);

  // SourceCodeBlock is a lazy client-only chunk, so assert the raw container
  // rather than the highlighted YAML text (it never paints in jsdom).
  expect(host.querySelector('[data-testid="script-result-raw"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="script-result-agent-view"]')).toBeNull();
  // The agent's view is still one toggle away.
  const toggle = host.querySelector<HTMLButtonElement>('[data-testid="script-result-view-toggle"]');
  expect(toggle?.textContent).toBe("Show agent view");
  await act(async () => toggle!.click());
  const agentView = host.querySelector('[data-testid="script-result-agent-view"]');
  expect(agentView?.textContent).toContain("Your script returned");
  expect(agentView?.textContent).toContain("results[0].data");
  expect(host.querySelector('[data-testid="script-result-raw"]')).toBeNull();
  expect(host.querySelector('[data-testid="script-result-view-toggle"]')?.textContent).toBe(
    "Show raw result",
  );
});

test("a truncated render defaults to the agent view — the raw view would misrepresent it", async () => {
  // Inline truncation, built through the server's own shared helpers: the
  // render carries only a slice of the stringified result plus the truncation
  // notice, so containment fails.
  const result = { items: "item ".repeat(50).trim() };
  const truncatedRender =
    "Your script returned:\n```json\n" +
    truncateScriptResult(stringifyScriptResult(result), 80) +
    "\n```\n" +
    "This result is available to your next script as `results[0].data` (the preamble `results` array, newest first).";
  await using mounted = await renderRounds(
    databaseWithRenderEvent("agent-output:53", truncatedRender),
    codeStep({ result }),
  );
  const { host } = mounted;
  await clickResultTab(host);

  const agentView = host.querySelector('[data-testid="script-result-agent-view"]');
  expect(agentView?.textContent).toContain("Your script returned");
  expect(agentView?.textContent).toContain("truncated (");
  expect(host.querySelector('[data-testid="script-result-raw"]')).toBeNull();
  // The full raw result stays one toggle away.
  const toggle = host.querySelector<HTMLButtonElement>('[data-testid="script-result-view-toggle"]');
  expect(toggle?.textContent).toBe("Show raw result");
  await act(async () => toggle!.click());
  expect(host.querySelector('[data-testid="script-result-agent-view"]')).toBeNull();
  expect(host.querySelector('[data-testid="script-result-raw"]')).not.toBeNull();
});

test("a stream with no agent-facing render falls back to the raw result view", async () => {
  await using mounted = await renderRounds(
    databaseWithRenderEvent(null, ""),
    codeStep({ result: [1, 2] }),
  );
  const { host } = mounted;
  await clickResultTab(host);

  expect(host.querySelector('[data-testid="script-result-agent-view"]')).toBeNull();
  expect(host.querySelector('[data-testid="script-result-view-toggle"]')).toBeNull();
  expect(host.querySelector('[data-testid="script-result-raw"]')).not.toBeNull();
});

test("without a raw-event mirror the raw result view renders alone, as before", async () => {
  await using mounted = await renderRounds(undefined, codeStep({ result: { plain: "raw" } }));
  const { host } = mounted;
  await clickResultTab(host);

  expect(host.querySelector('[data-testid="script-result-agent-view"]')).toBeNull();
  expect(host.querySelector('[data-testid="script-result-view-toggle"]')).toBeNull();
  expect(host.querySelector('[data-testid="script-result-raw"]')).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function codeStep(overrides: Record<string, unknown>) {
  const startedAtMs = Date.UTC(2026, 6, 15, 22, 6, 0);
  return {
    kind: "code",
    id: "code:53",
    executionId: "agent-output:53",
    status: "done",
    code: "return { ok: true }",
    success: true,
    startedAtMs,
    durationMs: 2_000,
    expiresAtMs: startedAtMs + 60_000,
    ...overrides,
  } as any;
}

/**
 * The narrow seam `useStreamQuery` actually uses: `db.query(sql, params)`
 * returning a stable subscribe/getSnapshot handle. When `executionId` is
 * null the mirror has no script render event.
 */
function databaseWithRenderEvent(
  executionId: string | null,
  content: string,
): StreamBrowserDatabase {
  const rows = executionId
    ? [
        {
          raw_json: JSON.stringify({
            type: "events.iterate.com/agents/context-added",
            payload: { role: "developer", content, actor: { type: "script", executionId } },
          }),
        },
      ]
    : [];
  const snapshot = { data: rows, status: "ok", error: undefined };
  const handle = { getSnapshot: () => snapshot, subscribe: () => () => {} };
  return { query: () => handle } as any;
}

async function renderRounds(database: StreamBrowserDatabase | undefined, code: any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<AgentActivityRounds rounds={[{ llm: null, code }]} database={database} />);
  });
  return {
    host,
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

async function clickResultTab(host: HTMLElement) {
  const resultTab = [
    ...host.querySelectorAll<HTMLButtonElement>('[data-slot="tabs-trigger"]'),
  ].find((tab) => tab.textContent === "Result");
  expect(resultTab).toBeDefined();
  await act(async () => resultTab!.click());
}
