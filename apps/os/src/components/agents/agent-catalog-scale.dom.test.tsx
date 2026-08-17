/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import { AgentCatalog } from "./agent-catalog.tsx";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";
import type { AgentCatalogView } from "~/lib/agent-catalog-search.ts";

const { runtimeTransitions } = vi.hoisted(() => ({
  runtimeTransitions: new Map<string, unknown>(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a href="#new-agent">{children}</a>,
}));

vi.mock("iterate/sdk/itx/react", () => ({
  useLiveState: (_node: unknown, _selector: unknown, deps: readonly string[]) => ({
    value: runtimeTransitions.get(deps[0] ?? ""),
  }),
}));

const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let observedTargets: WeakSet<Element>;
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const originalResizeObserver = globalThis.ResizeObserver;

function rect(height: number, top = 0): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 1_000,
    top,
    width: 1_000,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

beforeEach(() => {
  runtimeTransitions.clear();
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  observedTargets = new WeakSet<Element>();
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.matches("li[data-index]") ? 142 : 800;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.matches("li[data-index]")) return rect(142);
    if (this.matches("[data-agent-table-row]")) return rect(65);
    return rect(800);
  };
  globalThis.ResizeObserver = class ResizeObserver {
    readonly #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element) {
      if (observedTargets.has(target)) return;
      observedTargets.add(target);
      const contentRect = target.getBoundingClientRect();
      queueMicrotask(() =>
        this.#callback(
          [
            {
              target,
              contentRect,
              borderBoxSize: [{ blockSize: contentRect.height, inlineSize: contentRect.width }],
              contentBoxSize: [{ blockSize: contentRect.height, inlineSize: contentRect.width }],
              devicePixelContentBoxSize: [],
            } as unknown as ResizeObserverEntry,
          ],
          this,
        ),
      );
    }
    unobserve() {}
    disconnect() {}
    takeRecords(): ResizeObserverEntry[] {
      return [];
    }
  };
});

afterEach(() => {
  document.body.replaceChildren();
  if (originalOffsetHeight !== undefined) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
  }
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  globalThis.ResizeObserver = originalResizeObserver;
});

function record(index: number): AgentRecord {
  const path = `/agents/load-${String(index).padStart(4, "0")}`;
  return {
    path,
    summary: {
      pinned: index < 5,
      title: `Load agent ${index}`,
      activity: `Processing fixture row ${index}`,
    },
    runtime: ZERO_AGENT_RUNTIME,
    timestamps: {
      createdAt: "2026-07-17T10:00:00.000Z",
      lastWorkAt: "2026-07-17T10:00:00.000Z",
    },
  };
}

async function setSearch(container: HTMLElement, value: string) {
  const input = container.querySelector('input[aria-label="Search agents"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("missing agent search input");
  const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setInputValue === undefined) throw new Error("missing native input value setter");

  await act(async () => {
    setInputValue.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value || null }));
  });
}

test("a 5,000-agent catalog mounts bounded rows and patches one visible row", async () => {
  runtimeTransitions.set("/agents/load-0000", {
    runtime: { ...ZERO_AGENT_RUNTIME, runningScripts: 1 },
    sinceOffset: 4,
    since: "2026-07-17T10:00:04.000Z",
  });
  const agents = Object.fromEntries(
    Array.from({ length: 5_000 }, (_, index) => {
      const agent = record(index);
      return [agent.path, agent];
    }),
  );
  const container = document.createElement("div");
  Object.assign(container.style, { height: "800px", width: "1000px" });
  document.body.appendChild(container);
  const root = createRoot(container);
  const renderCatalog = (records: Record<string, AgentRecord>) =>
    root.render(
      <AgentCatalog
        agents={records}
        onOpen={() => undefined}
        onTogglePinned={() => undefined}
        projectId="prj_scale"
        projectSlug="scale"
      />,
    );

  await act(async () => renderCatalog(agents));
  const mountedBefore = container.querySelectorAll('[data-agent-variant="catalog"]');
  expect(mountedBefore.length).toBeGreaterThan(5);
  expect(mountedBefore.length).toBeLessThanOrEqual(30);
  expect(container.textContent).toContain("5000");
  expect(
    container
      .querySelector('[data-agent-path="/agents/load-0000"]')
      ?.getAttribute("data-agent-runtime-state"),
  ).toBe("running_code");
  expect(container.textContent).toContain("Running code");

  const path = "/agents/load-0000";
  const updated = {
    ...agents,
    [path]: {
      ...agents[path]!,
      summary: { ...agents[path]!.summary, title: "Patched visible agent" },
    },
  };
  const startedAt = performance.now();
  await act(async () => renderCatalog(updated));
  const updateDurationMs = performance.now() - startedAt;

  expect(container.textContent).toContain("Patched visible agent");
  expect(container.querySelectorAll('[data-agent-variant="catalog"]').length).toBeLessThanOrEqual(
    30,
  );
  expect(updateDurationMs).toBeLessThan(1_000);

  await act(async () => root.unmount());
});

test("search reveals matching descendants without changing the collapsed tree", async () => {
  const parent = { ...record(0), path: "/agents/research" };
  const child = {
    ...record(1),
    path: "/agents/research/bath",
    summary: {
      pinned: false,
      title: "Bath cattle survey",
      activity: "Comparing nearby farms",
    },
  };
  const agents = { [parent.path]: parent, [child.path]: child };
  const container = document.createElement("div");
  Object.assign(container.style, { height: "800px", width: "1000px" });
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () =>
    root.render(
      <AgentCatalog
        agents={agents}
        onOpen={() => undefined}
        onTogglePinned={() => undefined}
        projectId="prj_search"
        projectSlug="search"
      />,
    ),
  );

  expect(container.textContent).not.toContain("Bath cattle survey");
  expect(container.querySelector('button[aria-label="Expand child agents"]')).not.toBeNull();

  await setSearch(container, " cattle ");

  expect(container.textContent).toContain("Bath cattle survey");
  expect(container.querySelector('button[aria-label="Collapse child agents"]')).toBeNull();

  await setSearch(container, "");

  expect(container.textContent).not.toContain("Bath cattle survey");
  expect(container.querySelector('button[aria-label="Expand child agents"]')).not.toBeNull();

  await act(async () => root.unmount());
});

for (const view of ["list", "table"] satisfies AgentCatalogView[]) {
  test(`${view} search keeps the empty-state gate aligned with its TanStack rows`, async () => {
    const agent = {
      ...record(0),
      path: "/agents/research/bath",
      summary: { pinned: false, title: "Bath cattle survey" },
    };
    const container = document.createElement("div");
    Object.assign(container.style, { height: "800px", width: "1000px" });
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <AgentCatalog
          agents={{ [agent.path]: agent }}
          onOpen={() => undefined}
          onTogglePinned={() => undefined}
          projectId={`prj_${view}_search_contract`}
          projectSlug={`${view}-search-contract`}
          view={view}
        />,
      ),
    );

    await setSearch(container, "BATH CATTLE");
    expect(container.textContent).toContain("Bath cattle survey");
    expect(container.textContent).toContain("1 match");

    await setSearch(container, "missing search value");
    expect(container.textContent).toContain("No matches");
    expect(container.querySelector(`[data-agent-path="${agent.path}"]`)).toBeNull();

    await act(async () => root.unmount());
  });
}

test("table leaves a real agent's missing activity blank", async () => {
  const idleAgent = {
    ...record(0),
    path: "/agents/idle",
    summary: { pinned: false, title: "Idle agent" },
  };
  const container = document.createElement("div");
  Object.assign(container.style, { height: "800px", width: "1000px" });
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () =>
    root.render(
      <AgentCatalog
        agents={{ [idleAgent.path]: idleAgent }}
        onOpen={() => undefined}
        onTogglePinned={() => undefined}
        projectId="prj_table_activity"
        projectSlug="table-activity"
        view="table"
      />,
    ),
  );

  await setSearch(container, " Idle agent ");

  const row = container.querySelector('[data-agent-path="/agents/idle"]');
  expect(row?.querySelectorAll("td")[2]?.textContent).toBe("—");

  await act(async () => root.unmount());
});

test("table subagent aggregates exclude self and use singular folder labels", async () => {
  const parent = {
    ...record(0),
    path: "/agents/active",
    runtime: { ...ZERO_AGENT_RUNTIME, runningScripts: 1 },
  };
  const child = {
    ...record(1),
    path: "/agents/active/child",
    runtime: { ...ZERO_AGENT_RUNTIME, runningScripts: 1 },
  };
  const operationsAgent = {
    ...record(2),
    path: "/operations/releases/check",
  };
  const container = document.createElement("div");
  Object.assign(container.style, { height: "800px", width: "1000px" });
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () =>
    root.render(
      <AgentCatalog
        agents={{
          [parent.path]: parent,
          [child.path]: child,
          [operationsAgent.path]: operationsAgent,
        }}
        onOpen={() => undefined}
        onTogglePinned={() => undefined}
        projectId="prj_table_aggregates"
        projectSlug="table-aggregates"
        view="table"
      />,
    ),
  );

  const parentRow = container.querySelector('[data-agent-path="/agents/active"]');
  const childRow = container.querySelector('[data-agent-path="/agents/active/child"]');
  const operationsRow = container.querySelector('[data-agent-path="/operations"]');
  expect(parentRow?.querySelectorAll("td")[4]?.textContent).toBe("11 active");
  expect(childRow?.querySelectorAll("td")[4]?.textContent).toBe("0");
  expect(operationsRow?.querySelectorAll("td")[2]?.textContent).toBe("1 descendant agent");

  await act(async () => root.unmount());
});

test("table does not repeat the primary state in a redundant subtitle", async () => {
  const parent = {
    ...record(0),
    path: "/agents/release",
  };
  const child = {
    ...record(1),
    path: "/agents/release/approval",
    summary: { pinned: false, waitingFor: "user_input" as const },
  };
  const container = document.createElement("div");
  Object.assign(container.style, { height: "800px", width: "1000px" });
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () =>
    root.render(
      <AgentCatalog
        agents={{ [parent.path]: parent, [child.path]: child }}
        onOpen={() => undefined}
        onTogglePinned={() => undefined}
        projectId="prj_table_waiting"
        projectSlug="table-waiting"
        view="table"
      />,
    ),
  );

  const parentStatus = container
    .querySelector('[data-agent-path="/agents/release"]')
    ?.querySelectorAll("td")[1]?.textContent;
  const childStatus = container
    .querySelector('[data-agent-path="/agents/release/approval"]')
    ?.querySelectorAll("td")[1]?.textContent;
  expect(parentStatus).toBe("Idle");
  expect(childStatus).toBe("Needs input");

  await act(async () => root.unmount());
});

test("the 5,000-agent table mounts bounded rows", async () => {
  const agents = Object.fromEntries(
    Array.from({ length: 5_000 }, (_, index) => {
      const agent = record(index);
      return [agent.path, agent];
    }),
  );
  const container = document.createElement("div");
  Object.assign(container.style, { height: "800px", width: "1000px" });
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () =>
    root.render(
      <AgentCatalog
        agents={agents}
        onOpen={() => undefined}
        onTogglePinned={() => undefined}
        projectId="prj_table_scale"
        projectSlug="table-scale"
        view="table"
      />,
    ),
  );

  const mountedRows = container.querySelectorAll("[data-agent-table-row]");
  expect(mountedRows.length).toBeGreaterThan(5);
  expect(mountedRows.length).toBeLessThanOrEqual(40);
  expect(container.querySelector('table[aria-label="Agents table"]')).not.toBeNull();
  expect(container.textContent).toContain("Load agent 0");
  expect(container.textContent).toContain("5000 agents");

  await act(async () => root.unmount());
});

test("table disclosures collapse the derived path hierarchy", async () => {
  const parent = { ...record(0), path: "/agents/research" };
  const child = {
    ...record(1),
    path: "/agents/research/bath",
    summary: { pinned: false, title: "Bath cattle survey" },
  };
  const container = document.createElement("div");
  Object.assign(container.style, { height: "800px", width: "1000px" });
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () =>
    root.render(
      <AgentCatalog
        agents={{ [parent.path]: parent, [child.path]: child }}
        onOpen={() => undefined}
        onTogglePinned={() => undefined}
        projectId="prj_table_tree"
        projectSlug="table-tree"
        view="table"
      />,
    ),
  );

  expect(container.textContent).toContain("Bath cattle survey");
  const parentRow = container.querySelector('[data-agent-path="/agents/research"]');
  const disclosure = parentRow?.querySelector('button[aria-label="Collapse child agents"]');
  if (!(disclosure instanceof HTMLButtonElement)) throw new Error("missing table disclosure");

  await act(async () => disclosure.click());

  expect(container.textContent).not.toContain("Bath cattle survey");
  expect(parentRow?.querySelector('button[aria-label="Expand child agents"]')).not.toBeNull();

  await act(async () => root.unmount());
});
