// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { CapnWebProvider } from "../../sdk/capnweb/react.tsx";
import { TodoClient } from "./todo-client.tsx";

test("an added todo stays optimistic until the subscription confirms it, even after the RPC returns", async () => {
  await using ui = await mountTodo();
  await ui.add("green apples");
  expect(ui.host.querySelector("li")?.textContent).toContain("green apples");
  expect(ui.host.querySelector('li[data-spinner="true"]')).not.toBeNull();
  await act(async () => ui.response.resolve(ui.added().id));
  expect(ui.host.querySelector('li[data-spinner="true"]')).not.toBeNull();
  await act(async () => ui.publish([ui.added()]));
  expect(ui.host.querySelectorAll("li")).toHaveLength(1);
  expect(ui.host.querySelector('[data-spinner="true"]')).toBeNull();
  // A later remote deletion must not bring the optimistic row back.
  await act(async () => ui.publish([]));
  expect(ui.host.querySelectorAll("li")).toHaveLength(0);
});

test("a subscription that arrives before the add response does not duplicate the optimistic row", async () => {
  await using ui = await mountTodo();
  await ui.add("green apples");
  await act(async () => ui.publish([ui.added()]));
  expect(ui.host.querySelectorAll("li")).toHaveLength(1);
  await act(async () => ui.response.resolve(ui.added().id));
  expect(ui.host.querySelectorAll("li")).toHaveLength(1);
  expect(ui.host.querySelector('[data-spinner="true"]')).toBeNull();
});

test("a rejected add removes its optimistic row and shows the error", async () => {
  await using ui = await mountTodo();
  await ui.add("green apples");
  expect(ui.host.querySelector("li")?.textContent).toContain("green apples");
  await act(async () => ui.response.reject(new Error("Could not save todo")));
  expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain("Could not save todo");
  expect(ui.host.querySelectorAll("li")).toHaveLength(0);
  expect(ui.host.querySelector('[data-spinner="true"]')).toBeNull();
});

async function mountTodo() {
  const previous = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const response = Promise.withResolvers<string>();
  let sink: any;
  let revision = 0;
  let added: any;
  const api = {
    add: (title: string, id = "saved-id") => {
      added = { title, id, done: false };
      return response.promise;
    },
    onRpcBroken() {},
    [Symbol.dispose]() {},
    liveState: {
      get: async () => ({ todos: [] }),
      subscribe: async (callback: any) => {
        sink = callback;
        return { ping: () => true, unsubscribe() {}, [Symbol.dispose]() {} };
      },
    },
  };
  await act(async () =>
    root.render(
      <CapnWebProvider makeConnection={() => api}>
        <TodoClient />
      </CapnWebProvider>,
    ),
  );
  const publish = (todos: any[]) =>
    sink({ type: "snapshot", revision: revision++, state: { todos } });
  await act(async () => publish([]));
  return {
    host,
    response,
    publish,
    added: () => added,
    async add(title: string) {
      const input = host.querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          title,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        host
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
    },
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      host.remove();
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous;
    },
  };
}
