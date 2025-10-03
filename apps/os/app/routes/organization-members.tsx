import type { Route } from "./+types/organization-members";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Organization Members" },
    { name: "description", content: "Manage members, roles, and invites" },
  ];
}

export default function OrganizationMembers() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Members & access</h1>
      <p className="text-muted-foreground mt-2">Invite teammates and manage roles.</p>
    </div>
  );
}

