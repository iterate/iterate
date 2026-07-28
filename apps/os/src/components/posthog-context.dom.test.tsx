/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capturePageview: vi.fn(),
  contextFor: vi.fn((_session, project) => ({ project })),
  project: vi.fn(),
  routerState: {
    location: { href: "/projects/difference-engine" },
    matches: [{ routeId: "/_app/projects/$projectSlug" }],
    resolvedLocation: { href: "/projects/difference-engine" },
  },
  syncContext: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useMatch: () => mocks.project(),
  useRouterState: ({ select }: { select: (state: typeof mocks.routerState) => unknown }) =>
    select(mocks.routerState),
}));

vi.mock("@iterate-com/auth/client", () => ({
  useAuthClient: () => ({ session: { authenticated: false } }),
}));

vi.mock("@iterate-com/ui/components/posthog", () => ({
  capturePosthogPageview: mocks.capturePageview,
  syncPosthogContext: mocks.syncContext,
}));

vi.mock("./posthog-context-model.ts", () => ({
  osPosthogContext: mocks.contextFor,
}));

import { PosthogContextSync } from "./posthog-context.tsx";

const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeEach(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  mocks.capturePageview.mockReset();
  mocks.contextFor.mockClear();
  mocks.project.mockReset();
  mocks.syncContext.mockReset();
});

afterEach(() => {
  document.body.replaceChildren();
});

test("waits for a client-only project context before capturing the first pageview", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => root.render(<PosthogContextSync />));
  expect(mocks.capturePageview).not.toHaveBeenCalled();

  mocks.project.mockReturnValue({
    id: "prj_123",
    organizationId: "org_123",
    slug: "difference-engine",
  });
  await act(async () => root.render(<PosthogContextSync />));

  expect(mocks.capturePageview).toHaveBeenCalledOnce();
  expect(mocks.capturePageview).toHaveBeenCalledWith(
    {
      project: {
        id: "prj_123",
        organizationId: "org_123",
        slug: "difference-engine",
      },
    },
    "/projects/difference-engine",
  );

  await act(async () => root.unmount());
});
