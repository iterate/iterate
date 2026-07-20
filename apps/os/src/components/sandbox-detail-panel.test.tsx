// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { SandboxDetailPanel } from "../routes/_app/projects/$projectSlug/sandboxes/$sandboxId.tsx";
import type { SandboxProcessorState } from "~/domains/sandboxes/sandbox-processor-contract.ts";

const mountedRoots: Array<ReturnType<typeof createRoot>> = [];

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
});

test("a destroyed sandbox is terminal and exposes no actions", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  mountedRoots.push(root);
  const state: SandboxProcessorState = {
    birthCertificate: null,
    status: "destroyed",
    running: false,
    lastBackupId: null,
    env: {},
  };

  await act(async () => {
    root.render(
      <SandboxDetailPanel
        projectId="prj_test"
        routeConfig={{} as never}
        sandboxPath="/sandboxes/retired"
        state={state}
      />,
    );
  });

  expect(host.textContent).toContain("Sandbox destroyed");
  expect(host.textContent).not.toContain("Controls");
  expect(host.textContent).not.toContain("SSH into this sandbox");
  expect(host.querySelectorAll("button")).toHaveLength(0);
});
