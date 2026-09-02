/** @vitest-environment jsdom */

import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ComposerTextarea } from "./composer-textarea.tsx";
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
});

afterEach(() => {
  document.body.replaceChildren();
});

const provider: ComposerSuggestionProvider = {
  id: "files",
  trigger: "@",
  label: "Config repo files",
  cacheKey: ["test"],
  search: async (query) =>
    [
      { id: "agents", label: "AGENTS.md", text: "@AGENTS.md" },
      { id: "worker", label: "worker.ts", text: "@worker.ts" },
    ].filter((suggestion) => suggestion.label.toLowerCase().includes(query.toLowerCase())),
};

function Harness({ source = provider, submit = vi.fn() }) {
  const [value, setValue] = useState("");
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <QueryClientProvider client={queryClient}>
      <ComposerTextarea
        value={value}
        onValueChange={setValue}
        onSubmit={submit}
        placeholder="Message this agent"
        providers={[source]}
        textareaRef={textareaRef}
      />
    </QueryClientProvider>
  );
}

async function enterText(textarea: HTMLTextAreaElement, value: string, caret = value.length) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: value.at(-1) }),
    );
  });
}

async function settleSuggestionSearch() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

test("typing a trigger keeps textarea focus and Enter chooses the selected fuzzy result", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  const textarea = host.querySelector("textarea");
  if (textarea === null) throw new Error("missing textarea");

  await act(async () => textarea.focus());
  await enterText(textarea, "@ag");
  await settleSuggestionSearch();
  expect(document.activeElement).toBe(textarea);
  expect(document.body.textContent).toContain("AGENTS.md");

  await act(async () =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  );
  expect(textarea.value).toBe("@AGENTS.md ");
  expect(textarea.selectionStart).toBe(textarea.value.length);

  await act(async () => root.unmount());
});

test("a pointer selection works without moving focus away from the mobile textarea", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  const textarea = host.querySelector("textarea");
  if (textarea === null) throw new Error("missing textarea");

  await act(async () => textarea.focus());
  await enterText(textarea, "@");
  await settleSuggestionSearch();
  const worker = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
    (item) => item.textContent === "worker.ts",
  );
  if (worker === undefined) throw new Error("missing worker suggestion");
  await act(async () => worker.click());

  expect(textarea.value).toBe("@worker.ts ");
  expect(document.activeElement).toBe(textarea);
  await act(async () => root.unmount());
});

test("choosing a mention before existing text advances past its separator and closes the menu", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  const textarea = host.querySelector("textarea");
  if (textarea === null) throw new Error("missing textarea");

  await act(async () => textarea.focus());
  await enterText(textarea, "@ag later", 3);
  await settleSuggestionSearch();
  expect(document.body.textContent).toContain("AGENTS.md");

  await act(async () =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  );
  expect(textarea.value).toBe("@AGENTS.md later");
  expect(textarea.selectionStart).toBe(11);
  expect(textarea.getAttribute("aria-expanded")).toBe("false");

  await act(async () => root.unmount());
});

test("retry keeps textarea focus while refetching failed suggestions", async () => {
  let attempts = 0;
  const flaky: ComposerSuggestionProvider = {
    id: "files",
    trigger: "@",
    label: "Config repo files",
    cacheKey: ["flaky"],
    search: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary outage");
      return [{ id: "worker", label: "worker.ts", text: "@worker.ts" }];
    },
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Harness source={flaky} />));
  const textarea = host.querySelector("textarea");
  if (textarea === null) throw new Error("missing textarea");

  await act(async () => textarea.focus());
  await enterText(textarea, "@wor");
  await settleSuggestionSearch();
  const retry = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  );
  if (retry === undefined) throw new Error("missing retry button");

  const pointerDown = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
  await act(async () => retry.dispatchEvent(pointerDown));
  expect(pointerDown.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(textarea);
  await act(async () => retry.click());
  await settleSuggestionSearch();
  expect(document.activeElement).toBe(textarea);
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
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Harness source={loading} submit={submit} />));
  const textarea = host.querySelector("textarea");
  if (textarea === null) throw new Error("missing textarea");

  await act(async () => textarea.focus());
  await enterText(textarea, "@");
  expect(document.body.textContent).toContain("Loading config repo files…");
  await act(async () =>
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    ),
  );
  expect(submit).toHaveBeenCalledOnce();

  await act(async () => root.unmount());
});
