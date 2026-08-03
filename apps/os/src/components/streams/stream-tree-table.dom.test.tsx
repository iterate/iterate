/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { StreamIndexTable } from "./stream-index-table.tsx";
import { StreamTreeRowContent } from "./stream-tree-row.tsx";
import { useIndexedStreamTreeTable } from "./stream-tree-table.ts";
import type { StreamIndexRow } from "~/domains/projects/stream-database.ts";

const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const createdAt = "2026-07-17T10:00:00.000Z";

beforeEach(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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

test("the index table has no row-loading UI and reveals the current path", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (currentPath: string) =>
    root.render(
      <StreamIndexTable currentPath={currentPath} onOpenPath={() => {}} streams={indexedStreams} />,
    );

  await act(async () => render("/"));
  expect(visiblePaths(container)).toEqual(["/", "/agents", "/agents/cows"]);
  expect(container.querySelector(".animate-spin")).toBeNull();
  expect(container.querySelector('button[aria-label^="Retry loading"]')).toBeNull();
  const spans = [...container.querySelectorAll("span")];
  const eventHeading = spans.find((element) => element.textContent === "Events");
  const eventCount = spans.find((element) => element.textContent === "1 event");
  expect(eventHeading?.classList.contains("w-[5.5rem]")).toBe(true);
  expect(eventCount?.classList.contains("w-[5.5rem]")).toBe(true);

  const collapseAgents = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Collapse /agents"]',
  );
  expect(collapseAgents).not.toBeNull();
  await act(async () => collapseAgents?.click());
  expect(visiblePaths(container)).toEqual(["/", "/agents"]);

  await act(async () => render("/agents/cows"));
  expect(visiblePaths(container)).toEqual(["/", "/agents", "/agents/cows"]);

  const collapseCurrentParent = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Collapse /agents"]',
  );
  await act(async () => collapseCurrentParent?.click());
  expect(visiblePaths(container)).toEqual(["/", "/agents"]);

  await act(async () => render("/"));
  await act(async () => render("/agents/cows"));
  expect(visiblePaths(container)).toEqual(["/", "/agents", "/agents/cows"]);

  await act(async () => root.unmount());
});

function visiblePaths(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-stream-path]")].map(
    (element) => element.dataset.streamPath ?? "",
  );
}
