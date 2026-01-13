import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/tmux-sessions/$tmuxSessionName")({
  component: TmuxSessionLayout,
});

function TmuxSessionLayout() {
  return <Outlet />;
}
