/**
 * @vitest-environment jsdom
 *
 * The leading dash keeps this test out of TanStack Router's route tree.
 */

import { act, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RemoteStreamTable } from "~/components/streams/remote-stream-table.tsx";

type RemoteStreamTableProps = Parameters<typeof RemoteStreamTable>[0];

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  remoteStreamTableProps: undefined as RemoteStreamTableProps | undefined,
  routeComponent: undefined as ComponentType | undefined,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: ComponentType }) => {
    mocks.routeComponent = options.component;
    return {
      useParams: () => ({ projectId: "project-1" }),
    };
  },
  Outlet: () => null,
  useNavigate: () => mocks.navigate,
  useParams: () => ({}),
}));

vi.mock("~/components/streams/remote-stream-table.tsx", () => ({
  RemoteStreamTable: (props: RemoteStreamTableProps) => {
    mocks.remoteStreamTableProps = props;
    return null;
  },
}));

vi.mock("~/lib/stream-navigation.ts", () => ({
  streamProjectDisplayLabel: () => "project-1",
  useAdminStreamSource: () => ({ source: vi.fn() }),
}));

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.remoteStreamTableProps = undefined;
});

afterEach(() => {
  document.body.replaceChildren();
});

test("the root table row returns to the admin project index", async () => {
  await import("./route.tsx");
  const Layout = mocks.routeComponent;
  expect(Layout).toBeDefined();

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(Layout === undefined ? null : <Layout />));

  mocks.remoteStreamTableProps?.onOpenPath("/");
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/admin/streams/$projectId",
    params: { projectId: "project-1" },
    search: {},
  });

  mocks.remoteStreamTableProps?.onOpenPath("/agents/slack");
  expect(mocks.navigate).toHaveBeenLastCalledWith({
    to: "/admin/streams/$projectId/$",
    params: { projectId: "project-1", _splat: "/agents/slack" },
    search: {},
  });

  await act(async () => root.unmount());
});
