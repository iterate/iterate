import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC } from "../../lib/trpc.ts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";

export const Route = createFileRoute("/_auth.layout/admin/")({
  component: AdminIndex,
});

function AdminIndex() {
  const trpc = useTRPC();

  const { data: users } = useSuspenseQuery(trpc.admin.listUsers.queryOptions({ limit: 10 }));

  const { data: organizations } = useSuspenseQuery(
    trpc.admin.listOrganizations.queryOptions({ limit: 10 }),
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Admin Dashboard</h1>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Users</CardTitle>
            <CardDescription>{users.length} users</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {users.map((user) => (
                <div key={user.id} className="flex items-center gap-2 py-1">
                  {user.image && <img src={user.image} alt="" className="w-6 h-6 rounded-full" />}
                  <span className="text-sm">{user.name}</span>
                  <span className="text-xs text-muted-foreground">{user.email}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Organizations</CardTitle>
            <CardDescription>{organizations.length} organizations</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {organizations.map((org) => (
                <div key={org.id} className="py-1">
                  <div className="font-medium text-sm">{org.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {org.instances.length} instances · {org.members.length} members
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
