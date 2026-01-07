import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Users, Building2 } from "lucide-react";
import { trpc } from "../../lib/trpc.ts";

export const Route = createFileRoute("/_auth-required.layout/_/admin/")({
  component: AdminDashboardPage,
});

function AdminDashboardPage() {
  const { data: users } = useSuspenseQuery(
    trpc.admin.listUsers.queryOptions({ limit: 10 }),
  );

  const { data: organizations } = useSuspenseQuery(
    trpc.admin.listOrganizations.queryOptions({ limit: 10 }),
  );

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
                  {org.memberCount} members, {org.instanceCount} projects
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
