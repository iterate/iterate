// console/account.tsx — /account: a control-plane page driven ENTIRELY by the React LiveState hook.
// No re-fetch, no manual refresh: the account view (the user's authentications) is `session.user`'s
// live facet — a sign-in appears the instant the platform's fact is reduced and the delta streams
// back. This is the "just use LiveState" proof: the whole page is `useLiveState(session.user, …)`.
// Access enforcement is deferred — see the control-plane security spec's expected-fails.
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import type { AuthenticatedApp } from "iterate/next/app";
import { useLiveState } from "iterate/next/react";
import { AccountContract, AccountView } from "../account/contract.ts";

export function AccountPage({ app }: { app: AuthenticatedApp }) {
  const { api } = app;
  const userItx = useMemo(() => api.user, [api]);
  // Host the account processor on the user's own context before the page reads its live view. The
  // client installing its own processor is fine for the shape; a platform-owned install path is
  // deferred with the enforcement. The hook waits for `itx` (undefined until then).
  const [hosted, setHosted] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(
      userItx.processors.enable("account", { consumes: [...AccountContract.consumes] }),
    ).then(
      () => !cancelled && setHosted(true),
      (caught: unknown) =>
        !cancelled && setHostError(caught instanceof Error ? caught.message : String(caught)),
    );
    return () => void (cancelled = true);
  }, [userItx]);
  const { value, status, error } = useLiveState<AccountView>(hosted ? userItx : undefined, {
    key: "account",
    door: async () =>
      z
        .object({ rev: z.number(), state: AccountView })
        .parse(await userItx.invoke("itx.facets.get('account').liveSnapshot()")),
  });

  return (
    <main
      style={{ maxWidth: "36rem", margin: "2.5rem auto", padding: "0 1.25rem", lineHeight: 1.5 }}
    >
      <h1 style={{ fontSize: "1.2rem", fontWeight: 600 }}>Account</h1>
      <p style={{ color: "#6b7280", fontSize: "0.85rem" }}>
        Live from <code>session.user</code> — no refresh. Every sign-in appears the instant the
        account processor reduces the platform's fact.{" "}
        <span data-testid="status">{hostError || error || status}</span>
      </p>

      <h2 style={{ fontSize: "0.95rem", fontWeight: 600 }}>
        Sign-ins (<span data-testid="signin-count">{value?.authentications.length ?? 0}</span>)
      </h2>
      <ul data-testid="signins">
        {(value?.authentications ?? []).map((fact) => (
          <li key={fact.operationId}>
            {fact.credential} at {new Date(fact.at).toISOString()}
          </li>
        ))}
      </ul>
    </main>
  );
}
