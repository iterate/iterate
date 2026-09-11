// /_auth/account — a control-plane page driven ENTIRELY by the React LiveState hook. No loader
// re-fetch, no manual refresh: the account view (authentications + tokens) is `session.user`'s live
// facet, and creating a token is one appended COMMAND — the row appears the instant the processor
// reduces it and the delta streams back. This is the "just use LiveState" proof: the whole page is
// `useLiveState(session.user, …)` plus an append. (_auth is ssr:false, so this is client-only, which
// is exactly what a live WebSocket view wants.) Access enforcement is deferred — see the
// control-plane security spec's expected-fails.
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";
import { useLiveState } from "../../client/react.tsx";
import { ACCOUNT_PROCESSOR_SOURCE } from "../../account/account-processor-source.ts";
import { tokenCreateRequestedEvent, type AccountView } from "../../account/contract.ts";

export const Route = createFileRoute("/_auth/account")({
  // Host the account processor on the user's own context before the page reads its live view. The
  // client installing its own processor is fine for the shape; a platform-owned install path is
  // deferred with the enforcement.
  loader: async ({ context }) => {
    await context.api.user.processors.enable("account", {
      source: ACCOUNT_PROCESSOR_SOURCE,
      className: "AccountDurableObject",
      consumes: [
        "events.iterate.com/account/authenticated",
        "events.iterate.com/account/token-create-requested",
      ],
    });
  },
  component: AccountLivePage,
});

function AccountLivePage() {
  const { api } = Route.useRouteContext();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a capnweb stub is an untyped proxy, as in the demo
  const userItx = useMemo<any>(() => api.user, [api]);
  const { value, status, error } = useLiveState<AccountView>(userItx, {
    key: "account",
    door: () => userItx.invoke("itx.facets.get('account').liveSnapshot()"),
  });

  const [name, setName] = useState("");
  const [failure, setFailure] = useState<string>();
  const createToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requested = name.trim() || "Untitled token";
    setName("");
    setFailure(undefined);
    try {
      await userItx.invoke([
        "itx",
        ["append", tokenCreateRequestedEvent({ requestId: crypto.randomUUID(), name: requested })],
      ]);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main style={{ maxWidth: "36rem", margin: "2.5rem auto", padding: "0 1.25rem", lineHeight: 1.5 }}>
      <h1 style={{ fontSize: "1.2rem", fontWeight: 600 }}>Account</h1>
      <p style={{ color: "#6b7280", fontSize: "0.85rem" }}>
        Live from <code>session.user</code> — no refresh. Create a token and it appears the instant
        the account processor reduces the command. <span data-testid="status">{error ?? status}</span>
      </p>

      <form onSubmit={createToken} style={{ display: "flex", gap: "0.6rem", margin: "1.25rem 0" }}>
        <input
          aria-label="Token name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Token name"
          style={{ font: "inherit", padding: "0.4rem 0.6rem", flex: 1 }}
        />
        <button type="submit" style={{ font: "inherit", padding: "0.4rem 0.9rem" }}>
          Create token
        </button>
      </form>
      {failure ? <p style={{ color: "#b91c1c" }}>append failed: {failure}</p> : null}

      <h2 style={{ fontSize: "0.95rem", fontWeight: 600 }}>
        Tokens (<span data-testid="token-count">{value?.tokens.length ?? 0}</span>)
      </h2>
      <ul data-testid="tokens">
        {(value?.tokens ?? []).map((token) => (
          <li key={token.requestId}>{token.name}</li>
        ))}
      </ul>

      <h2 style={{ fontSize: "0.95rem", fontWeight: 600 }}>
        Sign-ins (<span data-testid="signin-count">{value?.authentications.length ?? 0}</span>)
      </h2>
    </main>
  );
}
