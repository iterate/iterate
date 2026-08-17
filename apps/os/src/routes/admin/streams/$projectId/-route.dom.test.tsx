/**
 * @vitest-environment jsdom
 *
 * The leading dash keeps this test out of TanStack Router's route tree.
 */

import { act, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { StreamIndexTablePanel } from "~/components/streams/stream-index-table.tsx";

type StreamIndexTableProps = Parameters<typeof StreamIndexTablePanel>[0];

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  projectId: "project-1",
  streamIndexTableProps: undefined as StreamIndexTableProps | undefined,
  routeComponent: undefined as ComponentType | undefined,
  useLiveState: vi.fn(() => ({
    value: {
      "/": {
        path: "/",
        createdAt: "2026-08-03T10:00:00.000Z",
        lastActivityAt: "2026-08-03T10:00:00.000Z",
        lastType: "events.iterate.com/test",
        eventCount: 1,
      },
    },
    status: "live",
    refresh: vi.fn(),
  })),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: ComponentType }) => {
    mocks.routeComponent = options.component;
    return {
      useParams: () => ({ projectId: mocks.projectId }),
    };
  },
  linkOptions: <Options,>(options: Options) => options,
  Outlet: () => null,
  useMatch: () => undefined,
  useNavigate: () => mocks.navigate,
}));

vi.mock("iterate/sdk/itx/react", () => ({
  useLiveState: mocks.useLiveState,
}));

vi.mock("~/components/streams/stream-index-table.tsx", () => ({
  StreamIndexTablePanel: (props: StreamIndexTableProps) => {
    mocks.streamIndexTableProps = props;
    return null;
  },
}));

vi.mock("~/lib/stream-navigation.ts", () => ({
  NULL_DURABLE_OBJECT_PROJECT_ID: "__null__",
  streamProjectDisplayLabel: () => "project-1",
}));

beforeEach(() => {
  mocks.projectId = "project-1";
  mocks.navigate.mockReset();
  mocks.streamIndexTableProps = undefined;
  mocks.useLiveState.mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
});

test("subscribes once to the project index and navigates root and deep rows", async () => {
  await import("./route.tsx");
  const Layout = mocks.routeComponent;
  expect(Layout).toBeDefined();

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(Layout === undefined ? null : <Layout />));

  expect(mocks.useLiveState).toHaveBeenCalledWith(
    expect.any(Function),
    expect.any(Function),
    ["project-1"],
    { slug: "project-1", enabled: true },
  );
  expect(mocks.useLiveState).toHaveBeenCalledTimes(1);
  expect(mocks.streamIndexTableProps?.streams?.["/"]?.eventCount).toBe(1);

  mocks.streamIndexTableProps?.onOpenPath("/");
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/admin/streams/$projectId",
    params: { projectId: "project-1" },
    search: {},
  });

  mocks.streamIndexTableProps?.onOpenPath("/agents/slack");
  expect(mocks.navigate).toHaveBeenLastCalledWith({
    to: "/admin/streams/$projectId/$",
    params: { projectId: "project-1", _splat: "/agents/slack" },
    search: {},
  });

  await act(async () => root.unmount());
});

test("keeps the global namespace inert because it has no project index", async () => {
  mocks.projectId = "__null__";
  await import("./route.tsx");
  const Layout = mocks.routeComponent;
  expect(Layout).toBeDefined();

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(Layout === undefined ? null : <Layout />));

  expect(mocks.useLiveState).toHaveBeenCalledWith(
    expect.any(Function),
    expect.any(Function),
    ["__null__"],
    { slug: "__null__", enabled: false },
  );
  expect(mocks.useLiveState).toHaveBeenCalledTimes(1);
  expect(mocks.streamIndexTableProps?.available).toBe(false);

  await act(async () => root.unmount());
});
