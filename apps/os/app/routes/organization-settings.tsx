import type { Route } from "./+types/organization-settings";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Organization Settings" },
    { name: "description", content: "Manage your organization settings" },
  ];
}

export default function OrganizationSettings() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Organization settings</h1>
      <p className="text-muted-foreground mt-2">Name, branding, and preferences.</p>
    </div>
  );
}

