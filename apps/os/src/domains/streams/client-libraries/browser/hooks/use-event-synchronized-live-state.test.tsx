// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import type { StreamBrowserDatabase } from "../stream-browser-db.ts";
import { useEventSynchronizedLiveState } from "./use-event-synchronized-live-state.ts";

const query = vi.hoisted(() => ({ offset: 0 }));
vi.mock("./use-stream-query.ts", () => ({
  useStreamQuery: () => ({ data: [{ offset: query.offset }], status: "ok" }),
}));

test("holds the previous server snapshot until its replacement's publications arrive, in either order", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const firstDatabase = {} as StreamBrowserDatabase;
  const secondDatabase = {} as StreamBrowserDatabase;
  type State = { publicationOffset: number; text: string };
  function Probe({ database, state }: { database: StreamBrowserDatabase; state: State }) {
    const visible = useEventSynchronizedLiveState(database, state);
    return <output>{visible?.text ?? "pending"}</output>;
  }
  async function render(offset: number, state: State, database = firstDatabase) {
    query.offset = offset;
    await act(async () => root.render(<Probe database={database} state={state} />));
    return host.textContent;
  }
  try {
    expect(await render(10, { publicationOffset: 10, text: "streaming" })).toBe("streaming");
    // Live-state delivery wins the race. Keep the existing activity through unrelated event appends.
    expect(await render(10, { publicationOffset: 20, text: "settled" })).toBe("streaming");
    expect(await render(19, { publicationOffset: 20, text: "settled" })).toBe("streaming");
    expect(await render(20, { publicationOffset: 20, text: "settled" })).toBe("settled");
    // SQLite wins the next race; the later snapshot can be displayed immediately.
    expect(await render(30, { publicationOffset: 20, text: "settled" })).toBe("settled");
    expect(await render(30, { publicationOffset: 30, text: "next turn" })).toBe("next turn");
    // Navigation must never show a retained snapshot from a different stream.
    expect(await render(0, { publicationOffset: 5, text: "other stream" }, secondDatabase)).toBe(
      "pending",
    );
    expect(await render(5, { publicationOffset: 5, text: "other stream" }, secondDatabase)).toBe(
      "other stream",
    );
  } finally {
    await act(async () => root.unmount());
  }
});
