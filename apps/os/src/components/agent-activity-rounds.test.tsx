// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { AgentActivityRounds } from "./agent-activity-rounds.tsx";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";

test("the Result tab defaults to the settlement text the agent was shown", async () => {
  const agentRender =
    'Your script returned:\n```json\n{\n  "ok": true\n}\n```\n' +
    "This result is available to your next script as `results[0].data` (the preamble `results` array, newest first).";
  await using mounted = await renderRounds(
    databaseWithRenderEvent("agent-output:53", agentRender),
    codeStep({ result: { ok: true } }),
  );
  const { host } = mounted;
  await clickResultTab(host);

  const agentView = host.querySelector('[data-testid="script-result-agent-view"]');
  expect(agentView?.textContent).toContain("Your script returned");
  expect(agentView?.textContent).toContain("results[0].data");
  // The client-side YAML re-serialization is NOT the default any more…
  expect(host.querySelector('[data-testid="script-result-raw"]')).toBeNull();
  // …but stays one toggle away.
  const toggle = host.querySelector<HTMLButtonElement>('[data-testid="script-result-view-toggle"]');
  expect(toggle?.textContent).toBe("Show raw result");
  await act(async () => toggle!.click());
  expect(host.querySelector('[data-testid="script-result-agent-view"]')).toBeNull();
  // SourceCodeBlock is a lazy client-only chunk, so assert the raw container
  // rather than the highlighted YAML text (it never paints in jsdom).
  expect(host.querySelector('[data-testid="script-result-raw"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="script-result-view-toggle"]')?.textContent).toBe(
    "Show agent view",
  );
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
  const rows =
    executionId == null
      ? []
      : [
          {
            raw_json: JSON.stringify({
              type: "events.iterate.com/agents/context-added",
              payload: { role: "developer", content, actor: { type: "script", executionId } },
            }),
          },
        ];
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
