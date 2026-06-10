// /admin — the platform admin area. Everything under this layout talks to the
// platform through a ROOT itx handle: a Cap'n Web session on the global
// context (/api/itx), not oRPC. The handle only has global authority (access
// "all") when the request carries admin credentials — the admin-cookie bridge
// (POST /api/itx/admin-cookie with the admin API secret) sets those for the
// browser, since WebSockets cannot send Authorization headers. Until then the
// layout shows an unlock form instead of its children.

import { useEffect, useState } from "react";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import type { RpcStub } from "capnweb";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import type { Itx } from "~/itx/handle.ts";
import { AdminItxContext } from "~/lib/admin-itx.ts";
import { createBrowserReplSession } from "~/routes/_app/itx-repl.tsx";

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
});

type AdminItxState =
  | { status: "connecting" }
  // The WebSocket is up but the handle lacks global authority (no admin
  // cookie yet) — or the connection failed outright. Either way the fix is
  // the same: unlock with the admin API secret.
  | { status: "locked"; reason: string }
  | { status: "ready"; itx: RpcStub<Itx> };

function AdminLayout() {
  const [state, setState] = useState<AdminItxState>({ status: "connecting" });
  // Bumped after a successful unlock so the connect effect runs again with
  // the freshly set admin cookie on the WebSocket handshake.
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let closed = false;
    const session = createBrowserReplSession();

    // Probe global authority: itx.streams on a global handle throws unless
    // the connection authenticated as admin, so one cheap call tells us
    // whether to render the admin pages or the unlock form.
    void session.itx.streams
      .get("/")
      .describe()
      .then(() => {
        if (!closed) setState({ status: "ready", itx: session.itx });
      })
      .catch((error: unknown) => {
        if (!closed) {
          setState({
            status: "locked",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      closed = true;
      setState({ status: "connecting" });
      session.close();
    };
  }, [epoch]);

  return (
    <div className="flex h-svh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b px-4">
        <span className="font-semibold">Iterate Admin</span>
        <nav className="flex items-center gap-3 text-sm text-muted-foreground">
          <Link to="/admin" className="hover:text-foreground [&.active]:text-foreground">
            Global stream
          </Link>
        </nav>
        <div className="ml-auto text-sm">
          <Link to="/" className="text-muted-foreground hover:text-foreground">
            Back to app
          </Link>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto p-4">
        {state.status === "connecting" && (
          <p className="text-sm text-muted-foreground">Connecting to the root itx context…</p>
        )}
        {state.status === "locked" && (
          <AdminUnlockForm reason={state.reason} onUnlocked={() => setEpoch((e) => e + 1)} />
        )}
        {state.status === "ready" && (
          <AdminItxContext.Provider value={state.itx}>
            <Outlet />
          </AdminItxContext.Provider>
        )}
      </main>
    </div>
  );
}

function AdminUnlockForm({ reason, onUnlocked }: { reason: string; onUnlocked: () => void }) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function unlock() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/itx/admin-cookie", {
        body: secret.trim(),
        credentials: "same-origin",
        headers: { "content-type": "text/plain" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(response.status === 401 ? "Wrong admin API secret." : response.statusText);
      }
      onUnlocked();
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : String(unlockError));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col gap-3">
      <h1 className="text-lg font-semibold">Admin access required</h1>
      <p className="text-sm text-muted-foreground">
        This area uses a root itx context with global authority. Paste the admin API secret for this
        deployment to set the admin cookie.
      </p>
      <p className="text-xs text-muted-foreground">({reason})</p>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void unlock();
        }}
      >
        <Input
          type="password"
          placeholder="Admin API secret"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
        <Button type="submit" disabled={submitting || secret.trim() === ""}>
          {submitting ? "Unlocking…" : "Unlock"}
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
