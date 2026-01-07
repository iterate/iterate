import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Users, Building2 } from "lucide-react";
import { orpc } from "../../lib/orpc.tsx";

export const Route = createFileRoute("/_auth-required/_/admin/")({
  component: AdminDashboardPage,
});

type User = { id: string; name: string; email: string; role: string | null };
type Organization = { id: string; name: string; slug: string; memberCount: number; projectCount: number };

function AdminDashboardPage() {
  const { data: users } = useSuspenseQuery(
    orpc.admin.listUsers.queryOptions({ input: { limit: 10 } }),
  ) as { data: User[] };

  const { data: organizations } = useSuspenseQuery(
    orpc.admin.listOrganizations.queryOptions({ input: { limit: 10 } }),
  ) as { data: Organization[] };

  return (
    <div className="p-8 space-y-8">
      <h1 className="text-2xl font-bold">Admin</h1>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <div className="border-b pb-4">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Total users</span>
            <Users className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-bold">{users?.length || 0}</div>
        </div>
        <div className="border-b pb-4">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>Organizations</span>
            <Building2 className="h-4 w-4" />
          </div>
          <div className="mt-2 text-2xl font-bold">{organizations?.length || 0}</div>
        </div>
      </div>

      <div className="grid gap-8 md:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Recent users</h2>
          <div className="divide-y">
            {users?.slice(0, 5).map((u) => (
              <div key={u.id} className="flex items-center justify-between py-3">
                <div>
                  <div className="font-medium">{u.name}</div>
                  <div className="text-sm text-muted-foreground">{u.email}</div>
                </div>
                <div className="text-xs text-muted-foreground">{u.role}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Recent organizations</h2>
          <div className="divide-y">
            {organizations?.slice(0, 5).map((org) => (
              <div key={org.id} className="flex items-center justify-between py-3">
                <div>
                  <div className="font-medium">{org.name}</div>
                  <div className="text-sm text-muted-foreground">{org.slug}</div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {org.memberCount} members, {org.projectCount} projects
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
