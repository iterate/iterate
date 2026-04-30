import { TaskChooseOrganization } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/session-tasks/choose-organization")({
  component: ChooseOrganizationTaskRoute,
});

function ChooseOrganizationTaskRoute() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <TaskChooseOrganization redirectUrlComplete="/" />
    </main>
  );
}
