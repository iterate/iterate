import { TaskChooseOrganization } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/session-tasks/choose-organization")({
  component: ChooseOrganizationTaskRoute,
});

export function ChooseOrganizationTaskRoute() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      {/*
        OS disables Clerk Personal Account mode, so new Google sign-ins can
        produce a pending `choose-organization` session task. Clerk should use
        the custom taskUrls entry in __root, but it may also emit nested
        sign-in/sign-up task paths during OAuth callbacks. All aliases render
        this same first-party task component.
        https://clerk.com/docs/tanstack-react-start/components/authentication/task-choose-organization
      */}
      <TaskChooseOrganization redirectUrlComplete="/" />
    </main>
  );
}
