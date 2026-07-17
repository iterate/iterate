/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import { AgentCatalog } from "./agent-catalog.tsx";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a href="#new-agent">{children}</a>,
}));

const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let observedTargets: WeakSet<Element>;

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
    if (this.getAttribute("aria-labelledby") === "all-agents-heading") return rect(1_000, 200);
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
});

function record(index: number): AgentRecord {
  const path = `/agents/load-${String(index).padStart(4, "0")}`;
  return {
    path,
    metadata: {
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

test("a 5,000-agent catalog mounts bounded rows and patches one visible row", async () => {
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
        projectSlug="scale"
      />,
    );

  await act(async () => renderCatalog(agents));
  const mountedBefore = container.querySelectorAll('[data-agent-variant="catalog"]');
  expect(mountedBefore.length).toBeGreaterThan(5);
  expect(mountedBefore.length).toBeLessThanOrEqual(30);
  expect(container.textContent).toContain("5000");

  const path = "/agents/load-0000";
  const updated = {
    ...agents,
    [path]: {
      ...agents[path]!,
      metadata: { ...agents[path]!.metadata, title: "Patched visible agent" },
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
    metadata: {
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
        projectSlug="search"
      />,
    ),
  );

  expect(container.textContent).not.toContain("Bath cattle survey");
  expect(container.querySelector('button[aria-label="Expand child agents"]')).not.toBeNull();

  const input = container.querySelector('input[aria-label="Search agents"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("missing agent search input");
  const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setInputValue === undefined) throw new Error("missing native input value setter");

  await act(async () => {
    setInputValue.call(input, "cattle");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "cattle" }));
  });

  expect(container.textContent).toContain("Bath cattle survey");
  expect(container.querySelector('button[aria-label="Collapse child agents"]')).toBeNull();

  await act(async () => {
    setInputValue.call(input, "");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: null }));
  });

  expect(container.textContent).not.toContain("Bath cattle survey");
  expect(container.querySelector('button[aria-label="Expand child agents"]')).not.toBeNull();

  await act(async () => root.unmount());
});
