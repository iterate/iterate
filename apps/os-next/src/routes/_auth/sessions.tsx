import { useMemo, useState, type FormEvent } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { useItx } from "../-itx.tsx";
import { useLiveState } from "../../client/react.tsx";
import { ACCOUNT_PROCESSOR_SOURCE } from "../../generated/account-processor-source.ts";
import { AccountContract, AccountView } from "../../account/contract.ts";

export const Route = createFileRoute("/_auth/sessions")({
  validateSearch: (search: Record<string, unknown>) => ({
    cursor: typeof search.cursor === "string" ? search.cursor : undefined,
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  // Host the account processor (the live token view) alongside the grant list. RpcPromise is
  // callable; normalize the grant list to a native Promise for the router loader.
  loader: async ({ deps, context }) => {
    await context.api.user.processors.enable("account", {
      source: ACCOUNT_PROCESSOR_SOURCE,
      className: "AccountDurableObject",
      consumes: [...AccountContract.consumes],
    });
    return await context.api.grants.list(deps.cursor);
  },
  component: SessionsPage,
});

function SessionsPage() {
  const { items, cursor } = Route.useLoaderData();
  const router = useRouter();
  const { api } = useItx();
  const search = Route.useSearch();
  const [error, setError] = useState<string | null>(null);

  // API tokens are LiveState — the account processor on session.user. Creating or revoking one is a
  // single appended command; the list updates the instant the delta streams back, no reload.
  const userItx = useMemo(() => api.user, [api]);
  const { value, status } = useLiveState<AccountView>(userItx, {
    key: "account",
    door: async () =>
      z
        .object({ rev: z.number(), state: AccountView })
        .parse(await userItx.invoke("itx.facets.get('account').liveSnapshot()")),
  });
  const [tokenName, setTokenName] = useState("");
  const createToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = tokenName.trim() || "Untitled token";
    setTokenName("");
    setError(null);
    try {
      const requestId = crypto.randomUUID();
      await userItx.append({
        type: "events.iterate.com/account/token-create-requested",
        payload: {
          requestId,
          name,
          // INSECURE-FIRST: a readable token value (a client-generated string for now).
          value: `tok_${crypto.randomUUID().replace(/-/g, "")}`,
          requestedAt: Date.now(),
        },
        idempotencyKey: `token-create/${requestId}`,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  const revokeToken = async (requestId: string) => {
    setError(null);
    try {
      await userItx.append({
        type: "events.iterate.com/account/token-revoked",
        payload: { requestId },
        idempotencyKey: `token-revoke/${requestId}`,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
                <button
                  type="button"
                  onClick={async () => {
                    setError(null);
                    try {
                      await api.grants.end(item.id);
                      if (item.current) window.location.assign("/");
                      else await router.invalidate();
                    } catch (caught) {
                      setError(caught instanceof Error ? caught.message : String(caught));
                    }
                  }}
                >
                  {item.cleanupPending ? "Retry cleanup" : item.expired ? "Remove" : "Log out"}
                </button>
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

      <h2>
        API tokens (<span data-testid="token-count">{value?.tokens.length ?? 0}</span>)
      </h2>
      <p>
        Live from <code>session.user</code> — created and revoked tokens appear instantly.{" "}
        <span data-testid="status">{status}</span>
      </p>
      <form onSubmit={createToken}>
        <label>
          Name{" "}
          <input
            aria-label="Token name"
            value={tokenName}
            onChange={(event) => setTokenName(event.target.value)}
            maxLength={100}
            placeholder="My script"
          />
        </label>{" "}
        <button type="submit">Create token</button>
      </form>
      <ul data-testid="tokens">
        {(value?.tokens ?? []).map((token) => (
          <li key={token.requestId}>
            <strong>{token.name}</strong> <code>{token.value}</code>{" "}
            <button
              type="button"
              aria-label={`Revoke ${token.name}`}
              onClick={() => revokeToken(token.requestId)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
