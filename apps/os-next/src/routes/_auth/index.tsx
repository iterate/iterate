import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Dashboard } from "iterate/next/dashboard";

import { loadDashboard } from "iterate/next/dashboard-data";
import { useItx } from "../-itx.tsx";

export const Route = createFileRoute("/_auth/")({
  loader: ({ context }) => loadDashboard(context),
  component: AccountPage,
});
function AccountPage() {
  const data = Route.useLoaderData();
  const { api } = useItx();
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
