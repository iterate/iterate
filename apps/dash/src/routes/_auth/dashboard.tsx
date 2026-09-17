import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Dashboard } from "iterate/next/dashboard";
import { loadDashboard } from "iterate/next/dashboard-data";
import { APPS } from "../../apps.ts";

export const Route = createFileRoute("/_auth/dashboard")({
  loader: ({ context }) => loadDashboard(context),
  component: DashboardPage,
});
function DashboardPage() {
  const data = Route.useLoaderData();
  const { api, info } = Route.useRouteContext();
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
      {info.scopes.includes("organizations:write") ? (
        <CreateOrganization />
      ) : (
        <AllowOrganizations />
      )}
      <Apps />
    </>
  );
}
/** The dash asked for `organizations:write` and the person unticked it at consent: creating an
 *  organization is off until they grant it — `/.auth/login` with the scope asked for again, which
 *  re-consents (the granted set is what `info.scopes` says, never what the dash requested). */
function AllowOrganizations() {
  const stepUp = `/.auth/login?${new URLSearchParams({
    next: "/dashboard",
    scope: "iterate account organizations:write",
  })}`;
  return (
    <section className="account" aria-label="Organizations">
      <p className="muted">
        This session may not create organizations.{" "}
        <a href={stepUp}>Allow the dash to create organizations</a>
      </p>
    </section>
  );
}
/** The first-party apps, each independently deployed on its own origin (src/apps.ts). */
function Apps() {
  return (
    <section className="account" aria-label="Apps">
      <h2>Apps</h2>
      <ul>
        {APPS.map((app) => (
          <li key={app.url}>
            <a href={app.url}>{app.name}</a> <span className="muted">{app.blurb}</span>
          </li>
        ))}
      </ul>
    </section>
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
