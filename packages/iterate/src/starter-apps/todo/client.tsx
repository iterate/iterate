/** @jsxImportSource react */
import React from "react";
import { createRoot } from "react-dom/client";
import { newWebSocketRpcSession } from "../../sdk/capnweb/index.ts";
import { CapnWebProvider } from "../../sdk/capnweb/react.tsx";
import type { TodoApi } from "./worker.ts";
import { TodoClient } from "./todo-client.tsx";

function makeConnection() {
  const endpoint = new URL("/api", window.location.href);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<TodoApi>(endpoint.toString());
}

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(
  <CapnWebProvider makeConnection={makeConnection}>
    <TodoClient />
  </CapnWebProvider>,
);
