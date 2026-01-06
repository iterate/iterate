import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/team")({
  component: TeamPage,
});

function TeamPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Team</h1>
    </div>
  );
}
