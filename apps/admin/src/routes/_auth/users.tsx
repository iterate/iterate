// /users — every person on the platform (`api.users`, a platform admin's), each with "View dash as":
// the dash's own `/.auth/login?act_as=<email>`, which asks the issuer — as this admin — to sign the
// dash in as that person for an hour (apps/os consent.ts `#impersonate`).
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";

/** The dash's origin, from the worker's first-party apps (`APP_CONFIG urls.dash`). */
const dashOrigin = createServerFn().handler(async () => {
  const { env } = await import("cloudflare:workers");
  const { dash } = startAppConfigOf(env).urls;
  if (!dash)
    throw new Error(
      "APP_CONFIG urls.dash (APP_CONFIG_URLS__DASH): unset — the admin app links into the dash",
    );
  return dash;
});

/** What the dash asks for at sign-in (apps/dash/src/lib/scopes.ts): viewed as someone, it gets the
 *  same, so it works as it does for them. */
const DASH_SCOPES = "iterate account organizations:write";

export const Route = createFileRoute("/_auth/users")({
  loader: async ({ context }) => ({
    users: await context.api.users.list(),
    dash: await dashOrigin(),
  }),
  head: () => ({ meta: [{ title: "Users · Admin" }] }),
  component: UsersPage,
});

function UsersPage() {
  const { users, dash } = Route.useLoaderData();
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">Email</th>
            <th className="py-1 font-medium">Id</th>
            <th className="py-1 font-medium" />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-t">
              <td className="py-1.5">{user.email}</td>
              <td className="py-1.5 font-mono text-xs text-muted-foreground">{user.id}</td>
              <td className="py-1.5 text-right">
                <a
                  href={`${dash}/.auth/login?${new URLSearchParams({ act_as: user.email, next: "/", scope: DASH_SCOPES })}`}
                  className="hover:underline"
                >
                  View dash as
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
