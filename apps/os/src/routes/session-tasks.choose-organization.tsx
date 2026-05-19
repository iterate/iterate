import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/session-tasks/choose-organization")({
  component: ChooseOrganizationTaskRoute,
});

export function ChooseOrganizationTaskRoute() {
  return <Navigate to="/organization" />;
}
