// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { Sheet, SheetContent } from "@iterate-com/ui/components/sheet";
import type { Stream } from "../itx-api.generated.ts";
import type { LlmRequestReplay } from "../lib/llm-request-replay.ts";
import type {
  SqliteQuerySnapshot,
  SqlValue,
  StreamBrowserDatabase,
} from "../domains/streams/client-libraries/browser/stream-browser-db.ts";
import { LlmRequestInspectorContent } from "./llm-request-inspector-panel.tsx";

const mirror = vi.hoisted<{ snapshot: SqliteQuerySnapshot<Record<string, SqlValue>> }>(() => ({
  snapshot: { status: "pending", data: [], error: undefined },
}));
vi.mock("~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts", () => ({
  useStreamQuery: () => mirror.snapshot,
}));

const roots: ReturnType<typeof createRoot>[] = [];
const clients: QueryClient[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  clients.splice(0).forEach((client) => client.clear());
  document.body.replaceChildren();
  mirror.snapshot = { status: "pending", data: [], error: undefined };
});

function setup() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const inspect = vi.fn(
    async (): Promise<LlmRequestReplay> => ({
      model: String(mirror.snapshot.data[0]?.stream_id),
      requestedAt: "2026-09-10T00:00:00Z",
      messages: [],
      reconstructed: false,
      response: null,
      outcome: null,
      stats: {
        tokens: null,
        timeToFirstChunkMs: null,
        generationMs: null,
        chunkCount: 0,
        outputTokensPerSecond: null,
        gatewayCacheStatus: null,
        rawResponse: null,
      },
    }),
  );
  const database = { databasePath: "same-path" } as StreamBrowserDatabase;
  const render = () =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Sheet open>
            <SheetContent>
              <LlmRequestInspectorContent
                database={database}
                streamSource={() => ({ inspectLlmRequest: inspect }) as unknown as Stream}
                streamPath="/agents/same-path"
                llmRequestOffset={4}
              />
            </SheetContent>
          </Sheet>
        </QueryClientProvider>,
      );
    });
  return { render, inspect };
}

test("waits for the mirrored lifecycle before requesting one durable reconstruction", async () => {
  const { render, inspect } = setup();
  await render();
  expect(inspect).not.toHaveBeenCalled();
  mirror.snapshot = {
    status: "ok",
    data: [{ stream_id: "source-a", offset: 4 }],
    error: undefined,
  };
  await render();
  await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
  await render();
  expect(inspect).toHaveBeenCalledTimes(1);
});

test("reconstructs a recreated source even when path and request offsets are reused", async () => {
  mirror.snapshot = {
    status: "ok",
    data: [{ stream_id: "source-a", offset: 4 }],
    error: undefined,
  };
  const { render, inspect } = setup();
  await render();
  await vi.waitFor(() => expect(document.body.textContent).toContain("source-a"));
  mirror.snapshot = {
    status: "ok",
    data: [{ stream_id: "source-b", offset: 4 }],
    error: undefined,
  };
  await render();
  await vi.waitFor(() => expect(document.body.textContent).toContain("source-b"));
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).not.toContain("source-a");
});

test("keeps the same request visible while a new lifecycle event refreshes it", async () => {
  mirror.snapshot = {
    status: "ok",
    data: [{ stream_id: "source-a", offset: 4 }],
    error: undefined,
  };
  const { render, inspect } = setup();
  await render();
  await vi.waitFor(() => expect(document.body.textContent).toContain("source-a"));
  const first = await inspect.mock.results[0]!.value;
  const refreshed = Promise.withResolvers<LlmRequestReplay>();
  inspect.mockReturnValueOnce(refreshed.promise);
  mirror.snapshot = {
    status: "ok",
    data: [{ stream_id: "source-a", offset: 8 }],
    error: undefined,
  };
  await render();
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("source-a");
  expect(document.body.textContent).not.toContain("Reconstructing request…");
  await act(async () => refreshed.resolve({ ...first, model: "refreshed" }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("refreshed"));
});
