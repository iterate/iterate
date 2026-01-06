import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/$organizationSlug/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Organization Settings</h1>
    </div>
  );
}
