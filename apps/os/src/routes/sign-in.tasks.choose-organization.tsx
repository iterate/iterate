import { createFileRoute } from "@tanstack/react-router";
import { ChooseOrganizationTaskRoute } from "./session-tasks.choose-organization.tsx";

export const Route = createFileRoute("/sign-in/tasks/choose-organization")({
  component: ChooseOrganizationTaskRoute,
});
