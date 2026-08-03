/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RemoteStreamTable } from "./remote-stream-table.tsx";
import { StreamTreeRowContent } from "./stream-tree-row.tsx";
import { useIndexedStreamTreeTable, useRemoteStreamTreeTable } from "./stream-tree-table.ts";
import type { StreamIndexRow } from "~/domains/projects/stream-database.ts";

const { readStreamStateOnce } = vi.hoisted(() => ({ readStreamStateOnce: vi.fn() }));

vi.mock("~/lib/stream-navigation.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  readStreamStateOnce,
}));

const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const createdAt = "2026-07-17T10:00:00.000Z";

beforeEach(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  readStreamStateOnce.mockReset();
});

afterEach(() => {
  document.body.replaceChildren();
});

function stream(path: string): StreamIndexRow {
  return {
    path,
    createdAt,
    lastActivityAt: createdAt,
    lastType: "events.iterate.com/test",
    eventCount: 1,
  };
}

const indexedStreams = Object.fromEntries(
  [stream("/"), stream("/agents"), stream("/agents/cows")].map((row) => [row.path, row]),
);

function IndexedHarness({
  collapsedPaths,
  query,
}: {
  collapsedPaths: ReadonlySet<string>;
  query: string;
}) {
  const table = useIndexedStreamTreeTable({
    streams: indexedStreams,
    collapsedPaths,
    query,
  });
  return table
    .getRowModel()
    .rows.map((row) => (
      <p key={row.id} data-stream-path={row.original.path} data-depth={row.depth} />
    ));
}

test("the indexed table collapses normally and leaf-first search restores context", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => root.render(<IndexedHarness collapsedPaths={new Set()} query="" />));
  expect(visiblePaths(container)).toEqual(["/", "/agents", "/agents/cows"]);

  await act(async () =>
    root.render(<IndexedHarness collapsedPaths={new Set(["/agents"])} query="" />),
  );
  expect(visiblePaths(container)).toEqual(["/", "/agents"]);

  await act(async () =>
    root.render(<IndexedHarness collapsedPaths={new Set(["/agents"])} query="cows" />),
  );
  expect(visiblePaths(container)).toEqual(["/", "/agents", "/agents/cows"]);
  expect(
    container.querySelector('[data-stream-path="/agents/cows"]')?.getAttribute("data-depth"),
  ).toBe("2");

  await act(async () => root.unmount());
});

function PassiveDisclosureHarness() {
  const table = useIndexedStreamTreeTable({
    streams: indexedStreams,
    collapsedPaths: new Set(),
    query: "",
  });
  const row = table.getRowModel().rows[0];
  if (row === undefined) return null;
  return (
    <div role="option" aria-selected="false">
      <StreamTreeRowContent row={row} />
    </div>
  );
}

test("cmdk row content keeps disclosures passive inside an option", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => root.render(<PassiveDisclosureHarness />));

  const option = container.querySelector('[role="option"]');
  expect(option?.querySelector("[data-stream-disclosure]")).not.toBeNull();
  expect(option?.querySelector("button")).toBeNull();

  await act(async () => root.unmount());
});

function RemoteHarness({ expandedPaths }: { expandedPaths: ReadonlySet<string> }) {
  const { table } = useRemoteStreamTreeTable({
    currentPath: "/",
    expandedPaths,
    scope: "project-1",
    source: () => {
      throw new Error("the read function is mocked");
    },
  });
  return table
    .getRowModel()
    .rows.map((row) => <p key={row.id} data-stream-path={row.original.path} />);
}

test("the remote table loads only visible levels and grows through the same row model", async () => {
  readStreamStateOnce.mockImplementation(async (_source, path: string) => {
    if (path === "/") return { eventCount: 4, childPaths: ["/agents"] };
    if (path === "/agents") return { eventCount: 2, childPaths: ["/agents/slack"] };
    return { eventCount: 1, childPaths: [] };
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (expandedPaths: ReadonlySet<string>) =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RemoteHarness expandedPaths={expandedPaths} />
      </QueryClientProvider>,
    );

  await act(async () => render(new Set(["/"])));
  await act(async () =>
    vi.waitFor(() => expect(visiblePaths(container)).toEqual(["/", "/agents"])),
  );
  expect(readStreamStateOnce.mock.calls.map((call) => call[1]).toSorted()).toEqual([
    "/",
    "/agents",
  ]);

  await act(async () => render(new Set(["/", "/agents"])));
  await act(async () =>
    vi.waitFor(() => expect(visiblePaths(container)).toEqual(["/", "/agents", "/agents/slack"])),
  );
  expect(readStreamStateOnce.mock.calls.map((call) => call[1]).toSorted()).toEqual([
    "/",
    "/agents",
    "/agents/slack",
  ]);

  await act(async () => root.unmount());
  queryClient.clear();
});

test("the remote table preserves manual expansion when the current path changes", async () => {
  readStreamStateOnce.mockImplementation(async (_source, path: string) => {
    if (path === "/") return { eventCount: 5, childPaths: ["/agents", "/global"] };
    if (path === "/agents") return { eventCount: 2, childPaths: ["/agents/slack"] };
    return { eventCount: 1, childPaths: [] };
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (currentPath: string) =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RemoteStreamTable
          currentPath={currentPath}
          onOpenPath={() => {}}
          scope="project-1"
          source={() => {
            throw new Error("the read function is mocked");
          }}
        />
      </QueryClientProvider>,
    );

  await act(async () => render("/"));
  await act(async () =>
    vi.waitFor(() => expect(visiblePaths(container)).toEqual(["/", "/agents", "/global"])),
  );
  const expandAgents = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Expand /agents"]',
  );
  expect(expandAgents).not.toBeNull();
  await act(async () => expandAgents?.click());
  await act(async () =>
    vi.waitFor(() =>
      expect(visiblePaths(container)).toEqual(["/", "/agents", "/agents/slack", "/global"]),
    ),
  );

  await act(async () => render("/global"));
  expect(visiblePaths(container)).toEqual(["/", "/agents", "/agents/slack", "/global"]);

  await act(async () => root.unmount());
  queryClient.clear();
});

function visiblePaths(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-stream-path]")].map(
    (element) => element.dataset.streamPath ?? "",
  );
}
