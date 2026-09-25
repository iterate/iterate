// /users — every person on the platform (`api.users`, a platform admin's). To use an app as one of
// them, sign in to that app again (its account menu's Switch account…) and pick them at the
// issuer's consent: "Sign in as someone else…" (apps/os consent.ts `#impersonate`).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/users")({
  loader: async ({ context }) => ({ users: await context.api.users.list() }),
  head: () => ({ meta: [{ title: "Users · Admin" }] }),
  component: UsersPage,
});

function UsersPage() {
  const { users } = Route.useLoaderData();
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">Email</th>
            <th className="py-1 font-medium">Id</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-t">
              <td className="py-1.5">{user.email}</td>
              <td className="py-1.5 font-mono text-xs text-muted-foreground">{user.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
