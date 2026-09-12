import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Dashboard } from "os-next/dashboard";
import { loadDashboard } from "os-next/dashboard-data";

export const Route = createFileRoute("/_auth/dashboard")({
  loader: ({ context }) => loadDashboard(context),
  component: DashboardPage,
});
function DashboardPage() {
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
