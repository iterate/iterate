// console/dashboard.tsx — `/`: the account page — orgs, projects, create a project. The SDK's
// `Dashboard` (iterate/next/dashboard), the same component apps/notes and apps/agents render; its
// data is `loadDashboard` over the session, reloaded after a create.
import { useCallback, useEffect, useState } from "react";
import type { AuthenticatedApp } from "iterate/next/app";
import { Dashboard } from "iterate/next/dashboard";
import { loadDashboard } from "iterate/next/dashboard-data";

export function DashboardPage({ app }: { app: AuthenticatedApp }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof loadDashboard>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setData(await loadDashboard(app));
  }, [app]);
  useEffect(() => {
    load().catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [load]);
  if (!data) return <main aria-busy="true">{error && <p role="alert">{error}</p>}</main>;
  return (
    <Dashboard
      data={data}
      createProject={async (project) => {
        using _created = await app.api.projects.create({ project });
        await load();
      }}
    />
  );
}
