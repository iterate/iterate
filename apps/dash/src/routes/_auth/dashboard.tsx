import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Dashboard } from "iterate/next/dashboard";
import { loadDashboard } from "iterate/next/dashboard-data";

export const Route = createFileRoute("/_auth/dashboard")({
  loader: ({ context }) => loadDashboard(context),
  component: DashboardPage,
});
function DashboardPage() {
  const data = Route.useLoaderData();
  const { api } = Route.useRouteContext();
  const router = useRouter();
  return (
    <>
      <nav className="account" aria-label="Account">
        <Link to="/sessions">Sessions</Link>
      </nav>
      <Dashboard
        data={data}
        createProject={async (project) => {
          using _created = await api.projects.create({ project });
          await router.invalidate();
        }}
      />
      <CreateOrganization />
    </>
  );
}
/** One organization per submit: `api.createOrg(name)`, then the router reloads the dashboard. */
function CreateOrganization() {
  const { api } = Route.useRouteContext();
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await api.createOrg(name.trim());
      setName("");
      await router.invalidate();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="account">
      <form onSubmit={create}>
        <label htmlFor="organization-name">Organization name</label>
        <input
          id="organization-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Acme"
          required
        />
        <div className="actions">
          <button type="submit" disabled={pending || name.trim().length === 0}>
            {pending ? "Creating…" : "Create organization"}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
