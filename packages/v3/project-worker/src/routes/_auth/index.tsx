import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Dashboard } from "../../client/dashboard.tsx";

import { loadDashboard } from "../../client/dashboard-data.ts";

export const Route = createFileRoute("/_auth/")({
  loader: ({ context }) => loadDashboard(context),
  component: AccountPage,
});
function AccountPage() {
  const data = Route.useLoaderData();
  const { api } = Route.useRouteContext();
  const router = useRouter();
  return (
    <Dashboard
      data={data}
      createProject={async (project) => {
        using _created = await api.projects.create({ project });
        await router.invalidate();
      }}
    />
  );
}
