/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Todos } from "../../../config-repo-template/apps/tanstack/src/routes/index.tsx";

const mocks = vi.hoisted(() => ({ useTodos: vi.fn() }));

vi.mock("../../../config-repo-template/apps/tanstack/src/lib/use-todos.ts", () => ({
  useTodos: mocks.useTodos,
}));

const mountedRoots: Array<ReturnType<typeof createRoot>> = [];
const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeEach(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

test("todo submission reports progress until its live-state row arrives", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);

  let resolveAdd: ((id: string) => void) | undefined;
  const add = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resolveAdd = resolve;
      }),
  );
  let todoState = {
    api: { add },
    error: null,
    todos: [] as Array<{ createdAt: string; done: boolean; id: string; title: string }>,
  };
  mocks.useTodos.mockImplementation(() => todoState);

  await act(async () => root.render(<Todos />));
  const input = host.querySelector<HTMLInputElement>('input[aria-label="add a todo"]');
  const form = input?.closest("form");
  if (input === null || input === undefined || form === null || form === undefined) {
    throw new Error("missing todo composer");
  }

  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setValue === undefined) throw new Error("missing native input value setter");
    setValue.call(input, "observable work");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  });

  expect(add).toHaveBeenCalledWith("observable work");
  expect(host.querySelector('[data-spinner="true"]')?.textContent).toContain("adding");
  expect(input.disabled).toBe(true);

  todoState = {
    ...todoState,
    todos: [
      {
        createdAt: "2026-07-19T20:00:00.000Z",
        done: false,
        id: "todo-observed",
        title: "observable work",
      },
    ],
  };
  await act(async () => root.render(<Todos />));

  expect(host.querySelector('[data-spinner="true"]')?.textContent).toContain("adding");
  await act(async () => resolveAdd?.("todo-observed"));

  expect(host.querySelector('[data-spinner="true"]')).toBeNull();
  expect(input.disabled).toBe(false);
  expect(host.textContent).toContain("observable work");
});
