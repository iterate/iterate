import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/$projectSlug/")({
  component: MachinesPage,
});

function MachinesPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Machines</h1>
      <p className="text-muted-foreground">Manage your machines here.</p>
    </div>
  );
}
