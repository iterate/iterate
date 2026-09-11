// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import type { AgentUiActivity } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { StreamFeedView } from "./stream-feed-view.tsx";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";

const publication = vi.hoisted(() => ({
  kind: "activity",
  id: "activity-1",
  status: "done",
  steps: [],
  startedAtMs: 0,
  endedAtMs: 1,
}));
vi.mock("~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts", () => ({
  useStreamQuery: (_database: unknown, sql: string) => ({
    status: sql.includes("FROM events") ? "pending" : "ok",
    data: sql.includes("COUNT(*)")
      ? [{ count: 1 }]
      : sql.includes("FROM events")
        ? [{ published: 1, item_id: "activity-1" }]
        : [
            {
              local_index: 10,
              kind: "agent.activity",
              first_offset: 1,
              last_offset: 10,
              data: JSON.stringify(publication),
            },
          ],
  }),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 56 })),
    getTotalSize: () => count * 56,
    measureElement: () => {},
    isAtEnd: () => true,
  }),
}));

const staleLive: AgentUiActivity = {
  kind: "activity",
  id: "activity-1",
  status: "running",
  steps: [],
  startedAtMs: 0,
};

test("keeps work visible when a published activity arrives before the next live snapshot", () => {
  function render(runningScripts: number) {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <StreamFeedView
        database={{} as StreamBrowserDatabase}
        filter={{ agent: { showDebug: false, searchQuery: null }, raw: null }}
        liveState={{ live: staleLive }}
        runtime={{ ...ZERO_AGENT_RUNTIME, runningScripts }}
      />,
    );
    return host;
  }
  // History has replaced the old live item, but server runtime still reports work.
  // The next activity snapshot is independently delivered and may arrive later.
  expect(render(1).querySelector('[aria-label="Loading"]')).not.toBeNull();
  expect(render(0).querySelector('[aria-label="Loading"]')).toBeNull();
});

test("keeps the next live activity visible while its query retains the prior activity result", () => {
  const html = renderToStaticMarkup(
    <StreamFeedView
      database={{} as StreamBrowserDatabase}
      filter={{ agent: { showDebug: false, searchQuery: null }, raw: null }}
      liveState={{ live: { ...staleLive, id: "activity-2" } }}
      runtime={{ ...ZERO_AGENT_RUNTIME, runningScripts: 1 }}
    />,
  );
  expect(html).toContain('data-testid="agent-live-status"');
});
