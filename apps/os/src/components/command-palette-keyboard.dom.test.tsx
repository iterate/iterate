/** @vitest-environment jsdom */

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@iterate-com/ui/components/command";
import { Button } from "@iterate-com/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import {
  isPaletteResultKeyboardTarget,
  paletteKeyboardAction,
  paletteKeyboardTarget,
  type PaletteKeyboardAction,
} from "./command-palette-model.ts";

const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeEach(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe() {}
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

test("the focused cmdk input bubbles structural keys to the Command boundary", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let action: PaletteKeyboardAction | undefined;

  await act(async () => {
    root.render(
      <Command
        shouldFilter={false}
        value="agent:/agents/research"
        onKeyDown={(event) => {
          const target = paletteKeyboardTarget("agents", "agent:/agents/research");
          if (target === undefined) return;
          action = paletteKeyboardAction({
            target,
            key: event.key,
            shiftKey: event.shiftKey,
            query: "",
            hasChildren: true,
            expanded: false,
          });
          if (action !== undefined) event.preventDefault();
        }}
      >
        <CommandInput aria-label="Search agents" />
        <CommandList>
          <CommandItem value="agent:/agents/research">Research</CommandItem>
        </CommandList>
      </Command>,
    );
  });

  const input = container.querySelector("input");
  if (input === null) throw new Error("missing command input");
  input.focus();
  const event = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => input.dispatchEvent(event));

  expect(document.activeElement).toBe(input);
  expect(action).toBe("expand");
  expect(event.defaultPrevented).toBe(true);

  await act(async () => root.unmount());
});

test("editing the query retargets Shift+P away from the hidden agent", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const pinned: string[] = [];

  function Harness() {
    const [query, setQuery] = useState("");
    const [selectedValue, setSelectedValue] = useState("agent:/agents/a");
    return (
      <Command
        shouldFilter={false}
        value={selectedValue}
        onValueChange={setSelectedValue}
        onKeyDown={(event) => {
          const target = paletteKeyboardTarget("agents", selectedValue);
          if (target === undefined) return;
          const action = paletteKeyboardAction({
            target,
            key: event.key,
            shiftKey: event.shiftKey,
            query,
            hasChildren: false,
            expanded: false,
          });
          if (action === "toggle_pin") pinned.push(target.path);
        }}
      >
        <CommandInput
          aria-label="Search agents"
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            setSelectedValue("");
          }}
        />
        <CommandList>
          {query === "b" ? (
            <CommandItem value="agent:/agents/b">B</CommandItem>
          ) : (
            <CommandItem value="agent:/agents/a">A</CommandItem>
          )}
        </CommandList>
      </Command>
    );
  }

  await act(async () => root.render(<Harness />));
  const input = container.querySelector("input");
  if (input === null) throw new Error("missing command input");

  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, "b");
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: "b" }),
    );
  });
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "P", shiftKey: true, bubbles: true, cancelable: true }),
    ),
  );

  expect(pinned).toEqual(["/agents/b"]);
  expect(container.querySelector('[cmdk-item][data-value="agent:/agents/b"]')).not.toBeNull();

  await act(async () => root.unmount());
});

test("tab and footer keys cannot act on the selected cmdk row", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const actedFrom: string[] = [];

  await act(async () => {
    root.render(
      <Command
        shouldFilter={false}
        value="agent:/agents/a"
        onKeyDown={(event) => {
          if (!isPaletteResultKeyboardTarget(event.target)) return;
          actedFrom.push((event.target as HTMLElement).dataset.slot ?? "unknown");
        }}
      >
        <CommandInput aria-label="Search agents" />
        <Tabs defaultValue="agents">
          <TabsList>
            <TabsTrigger value="tree">Tree</TabsTrigger>
            <TabsTrigger value="agents">Agents</TabsTrigger>
          </TabsList>
        </Tabs>
        <CommandList>
          <CommandItem value="agent:/agents/a">A</CommandItem>
        </CommandList>
        <Button type="button">Open or create stream</Button>
      </Command>,
    );
  });

  const tab = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === "Agents",
  );
  const footer = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === "Open or create stream",
  );
  if (tab === undefined || footer === undefined) throw new Error("missing keyboard controls");

  for (const control of [tab, footer]) {
    control.focus();
    await act(async () =>
      control.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "P",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  }

  expect(actedFrom).toEqual([]);
  await act(async () => root.unmount());
});
