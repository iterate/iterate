import { z } from "zod";
import { useState, type FormEvent } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { endGrant, listGrants, mintPersonalToken } from "../../grants.ts";
import { consoleContext } from "../-console-context.ts";

const inventory = createServerFn({ method: "GET" })
  .middleware([consoleContext])
  .inputValidator(z.object({ cursor: z.string().max(2000).optional() }))
  .handler(({ data, context }) => listGrants(context, data.cursor));
const revoke = createServerFn({ method: "POST" })
  .middleware([consoleContext])
  .inputValidator(z.object({ id: z.string().min(1).max(200) }))
  .handler(({ data, context }) => endGrant(context, data.id));
const mint = createServerFn({ method: "POST" })
  .middleware([consoleContext])
  .inputValidator(z.object({ name: z.string(), projects: z.array(z.string()) }))
  .handler(({ data, context }) => mintPersonalToken(context, data));

export const Route = createFileRoute("/_auth/sessions")({
  validateSearch: (search: Record<string, unknown>) => ({
    cursor: typeof search.cursor === "string" ? search.cursor : undefined,
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ deps }) => inventory({ data: deps }),
  component: SessionsPage,
});

function SessionsPage() {
  const { items, cursor, projects, canMintToken } = Route.useLoaderData();
  const router = useRouter();
  const search = Route.useSearch();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mintToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    setToken(null);
    try {
      const answer = await mint({
        data: {
          name: String(form.get("name") ?? ""),
          projects: form.getAll("project").map(String),
        },
      });
      setToken(answer.token);
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };
  return (
    <main>
      <p>
        <Link to="/">Projects</Link>
      </p>
      <h1>Sessions</h1>
      <p>
        Each browser, connected client, and API token can be signed out independently. Existing
        connections end within a minute.
      </p>
      {error && <p role="alert">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Last used</th>
            <th>Expires</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                {item.name}
                {item.current && " (this browser)"}
              </td>
              <td>{item.kind}</td>
              <td>{item.lastUsedAt ? new Date(item.lastUsedAt).toISOString() : "Not used yet"}</td>
              <td>
                {item.cleanupPending
                  ? "Access revoked; cleanup pending"
                  : item.expired
                    ? "Expired"
                    : item.expiresAt
                      ? new Date(item.expiresAt).toISOString()
                      : "—"}
              </td>
              <td>
                <form
                  method="post"
                  action="/sessions/revoke"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    setError(null);
                    try {
                      await revoke({ data: { id: item.id } });
                      if (item.current) window.location.assign("/");
                      else await router.invalidate();
                    } catch (caught) {
                      setError(caught instanceof Error ? caught.message : String(caught));
                    }
                  }}
                >
                  <input type="hidden" name="grantId" value={item.id} />
                  <button type="submit">
                    {item.cleanupPending ? "Retry cleanup" : item.expired ? "Remove" : "Log out"}
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && <p>No sessions on this page.</p>}
      <p>
        {search.cursor && (
          <Link to="/sessions" search={{ cursor: undefined }}>
            First page
          </Link>
        )}{" "}
        {cursor && (
          <Link to="/sessions" search={{ cursor }}>
            Next page
          </Link>
        )}
      </p>
      <h2>Create an API token</h2>
      <p>A token acts as you on the projects you select. It expires after 30 days.</p>
      {canMintToken ? (
        <form method="post" action="/sessions/token" onSubmit={mintToken}>
          <label>
            Name <input name="name" required maxLength={100} placeholder="My script" />
          </label>
          <fieldset>
            <legend>Projects</legend>
            {projects.map((project) => (
              <label key={project.id}>
                <input type="checkbox" name="project" value={project.id} /> {project.id}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={pending || !projects.length}>
            {pending ? "Creating…" : "Create token"}
          </button>
        </form>
      ) : (
        <p>Token creation is available on HTTPS deployments.</p>
      )}
      {token && (
        <div>
          <p>Copy this token now. It will not be shown again.</p>
          <textarea aria-label="New API token" readOnly value={token} rows={3} />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(token).catch((caught) => setError(String(caught)));
            }}
          >
            Copy token
          </button>
          <button type="button" onClick={() => setToken(null)}>
            Done
          </button>
        </div>
      )}
    </main>
  );
}
