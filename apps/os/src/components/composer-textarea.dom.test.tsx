/** @vitest-environment jsdom */

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditorView } from "@codemirror/view";
import {
  flattenAgentRichContent,
  plainAgentRichContent,
  type AgentRichContentV1,
} from "@iterate-com/shared/agent-rich-content";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComposerTextareaClient as ComposerTextarea } from "./composer-textarea.client.tsx";
import type { ComposerSuggestionProvider } from "./composer-suggestions.ts";

const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeEach(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
  document.body.replaceChildren();
});

function fileSuggestion(path: string) {
  return {
    id: path,
    label: path,
    completion: {
      type: "reference" as const,
      display: `@${path}`,
      target: {
        kind: "config-repo-file" as const,
        repoPath: "/repos/config" as const,
        path,
      },
    },
  };
}

const provider: ComposerSuggestionProvider = {
  id: "files",
  trigger: "@",
  label: "Config repo files",
  cacheKey: ["test"],
  search: async (query) =>
    [fileSuggestion("AGENTS.md"), fileSuggestion("worker.ts")].filter((suggestion) =>
      suggestion.label.toLowerCase().includes(query.toLowerCase()),
    ),
};

function Harness({
  source = provider,
  submit = vi.fn(),
  onDocumentChange = vi.fn(),
}: {
  source?: ComposerSuggestionProvider;
  submit?: () => void;
  onDocumentChange?: (document: AgentRichContentV1) => void;
}) {
  const [value, setValue] = useState(() => plainAgentRichContent());
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ComposerTextarea
        value={value}
        onValueChange={(document) => {
          setValue(document);
          onDocumentChange(document);
        }}
        onSubmit={submit}
        placeholder="Message this agent"
        providers={[source]}
      />
    </QueryClientProvider>
  );
}

async function mountHarness(props: Parameters<typeof Harness>[0] = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Harness {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const content = host.querySelector<HTMLElement>(".cm-content");
  if (content === null) throw new Error("missing CodeMirror content");
  const view = EditorView.findFromDOM(content);
  if (view === null) throw new Error("missing CodeMirror view");
  return { content, host, root, view };
}

async function enterText(view: EditorView, value: string, caret = value.length) {
  await act(async () => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: caret },
    });
  });
}

async function settleSuggestionSearch() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

test("typing a trigger keeps editor focus and Enter inserts an atomic reference", async () => {
  const onDocumentChange = vi.fn();
  const { content, root, view } = await mountHarness({ onDocumentChange });
  expect(content.getAttribute("aria-placeholder")).toBe("Message this agent");
  expect(content.getAttribute("placeholder")).toBe("Message this agent");
  await act(async () => view.focus());
  await enterText(view, "@ag");
  await settleSuggestionSearch();
  expect(document.activeElement).toBe(content);
  expect(document.body.textContent).toContain("AGENTS.md");

  await act(async () =>
    content.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  );
  expect(view.state.doc.toString()).toBe("@AGENTS.md ");
  expect(document.querySelector(".cm-agent-reference")?.textContent).toBe("@AGENTS.md");
  const documentValue = onDocumentChange.mock.calls.at(-1)?.[0] as AgentRichContentV1;
  expect(flattenAgentRichContent(documentValue)).toBe("@AGENTS.md ");
  expect(documentValue.nodes.some((node) => node.type === "reference")).toBe(true);

  await act(async () => {
    view.dispatch({ changes: { from: 10, to: 11 }, selection: { anchor: 10 } });
  });
  await act(async () =>
    content.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
    ),
  );
  expect(view.state.doc.toString()).toBe("");
  expect(document.querySelector(".cm-agent-reference")).toBeNull();

  await act(async () => root.unmount());
});

test("pointer selection works without moving focus away from the mobile editor", async () => {
  const { content, root, view } = await mountHarness();
  await act(async () => view.focus());
  await enterText(view, "@");
  await settleSuggestionSearch();
  const worker = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
    (item) => item.textContent === "worker.ts",
  );
  if (worker === undefined) throw new Error("missing worker suggestion");
  await act(async () => worker.click());

  expect(view.state.doc.toString()).toBe("@worker.ts ");
  expect(document.activeElement).toBe(content);
  await act(async () => root.unmount());
});

test("choosing a mention before existing text advances past its separator", async () => {
  const { content, root, view } = await mountHarness();
  await act(async () => view.focus());
  await enterText(view, "@ag later", 3);
  await settleSuggestionSearch();

  await act(async () =>
    content.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  );
  expect(view.state.doc.toString()).toBe("@AGENTS.md later");
  expect(view.state.selection.main.head).toBe(11);
  expect(content.getAttribute("aria-expanded")).toBe("false");

  await act(async () => root.unmount());
});

test("retry keeps editor focus while refetching failed suggestions", async () => {
  let attempts = 0;
  const flaky: ComposerSuggestionProvider = {
    id: "files",
    trigger: "@",
    label: "Config repo files",
    cacheKey: ["flaky"],
    search: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary outage");
      return [fileSuggestion("worker.ts")];
    },
  };
  const { content, root, view } = await mountHarness({ source: flaky });
  await act(async () => view.focus());
  await enterText(view, "@wor");
  await settleSuggestionSearch();
  const retry = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  );
  if (retry === undefined) throw new Error("missing retry button");

  const pointerDown = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
  await act(async () => retry.dispatchEvent(pointerDown));
  expect(pointerDown.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(content);
  await act(async () => retry.click());
  await settleSuggestionSearch();
  expect(document.activeElement).toBe(content);
  expect(document.body.textContent).toContain("worker.ts");

  await act(async () => root.unmount());
});

test("loading is explicit and Enter still submits when there is no selectable result", async () => {
  const submit = vi.fn();
  const loading: ComposerSuggestionProvider = {
    id: "files",
    trigger: "@",
    label: "Config repo files",
    cacheKey: ["loading"],
    search: () => new Promise(() => {}),
  };
  const { content, root, view } = await mountHarness({ source: loading, submit });
  await act(async () => view.focus());
  await enterText(view, "@");
  expect(document.body.textContent).toContain("Loading config repo files…");
  await act(async () =>
    content.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  );
  expect(submit).toHaveBeenCalledOnce();

  await act(async () => root.unmount());
});
