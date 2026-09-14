// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import type { StreamBrowserDatabase } from "../stream-browser-db.ts";
import { useEventSynchronizedLiveState } from "./use-event-synchronized-live-state.ts";

const query = vi.hoisted(() => ({
  offset: 0,
  streamId: "stream-a" as string | null,
  throughOffset: 0,
}));
vi.mock("./use-stream-query.ts", () => ({
  useStreamQuery: (_database: unknown, sql: string) => ({
    data: sql.includes("stream_sync")
      ? [{ stream_id: query.streamId, through_offset: query.throughOffset }]
      : [{ offset: query.offset }],
    status: "ok",
  }),
}));

test("holds the previous server snapshot until its replacement's publications arrive, in either order", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const firstDatabase = {} as StreamBrowserDatabase;
  const secondDatabase = {} as StreamBrowserDatabase;
  type State = { publicationOffset: number; streamId: string | null; text: string };
  function Probe({ database, state }: { database: StreamBrowserDatabase; state: State }) {
    const visible = useEventSynchronizedLiveState(database, state);
    return <output>{visible?.text ?? "pending"}</output>;
  }
  async function render(
    offset: number,
    state: State,
    database = firstDatabase,
    streamId: string | null = "stream-a",
    throughOffset = offset,
  ) {
    query.offset = offset;
    query.streamId = streamId;
    query.throughOffset = throughOffset;
    await act(async () => root.render(<Probe database={database} state={state} />));
    return host.textContent;
  }
  try {
    expect(
      await render(10, { publicationOffset: 10, streamId: "stream-a", text: "streaming" }),
    ).toBe("streaming");
    // Live-state delivery wins the race. Keep the existing activity through unrelated event appends.
    expect(await render(10, { publicationOffset: 20, streamId: "stream-a", text: "settled" })).toBe(
      "streaming",
    );
    expect(await render(19, { publicationOffset: 20, streamId: "stream-a", text: "settled" })).toBe(
      "streaming",
    );
    expect(await render(20, { publicationOffset: 20, streamId: "stream-a", text: "settled" })).toBe(
      "settled",
    );
    // SQLite wins the next race; the later snapshot can be displayed immediately.
    expect(await render(30, { publicationOffset: 20, streamId: "stream-a", text: "settled" })).toBe(
      "settled",
    );
    expect(
      await render(30, { publicationOffset: 30, streamId: "stream-a", text: "next turn" }),
    ).toBe("next turn");
    // Navigation must never show a retained snapshot from a different stream.
    expect(
      await render(
        0,
        { publicationOffset: 5, streamId: "stream-a", text: "other stream" },
        secondDatabase,
      ),
    ).toBe("pending");
    expect(
      await render(
        5,
        { publicationOffset: 5, streamId: "stream-a", text: "other stream" },
        secondDatabase,
      ),
    ).toBe("other stream");
    // Return to the original database before testing its recreated lifetime.
    expect(
      await render(30, { publicationOffset: 30, streamId: "stream-a", text: "next turn" }),
    ).toBe("next turn");
    // A recreated stream starts offsets from zero. While SQLite still names
    // the old lifetime, retain the coherent old presentation rather than using
    // its offset 100 to admit generation B's offset 2.
    expect(
      await render(
        100,
        { publicationOffset: 2, streamId: "stream-b", text: "new generation" },
        firstDatabase,
        "stream-a",
        100,
      ),
    ).toBe("next turn");
    // Once the mirror changes its generation, the old presentation is no
    // longer coherent. Wait for B's own durable rows from offset zero.
    expect(
      await render(
        100,
        { publicationOffset: 2, streamId: "stream-b", text: "new generation" },
        firstDatabase,
        "stream-b",
        1,
      ),
    ).toBe("pending");
    expect(
      await render(
        100,
        { publicationOffset: 2, streamId: "stream-b", text: "new generation" },
        firstDatabase,
        "stream-b",
        2,
      ),
    ).toBe("new generation");
    // Neither side may use a missing identity as a real source lifetime.
    expect(
      await render(
        0,
        { publicationOffset: 0, streamId: null, text: "unidentified" },
        secondDatabase,
        null,
        0,
      ),
    ).toBe("pending");
  } finally {
    await act(async () => root.unmount());
  }
});
