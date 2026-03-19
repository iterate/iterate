import "./index.css";

import { Suspense, use, useState } from "react";
import { createIterateAuthClient, type SessionResponse } from "@iterate-com/auth/client";

const auth = createIterateAuthClient();

let sessionPromise: Promise<SessionResponse> | null = null;

function getSessionPromise() {
  sessionPromise ??= auth.fetchSession();
  return sessionPromise;
}

function ProtectedRouteTest() {
  const [result, setResult] = useState<string | null>(null);

  async function fetchProtected() {
    const response = await fetch("/api/protected", { credentials: "include" });
    setResult(`${response.status}: ${await response.text()}`);
  }

  return (
    <div className="mt-6 rounded-2xl bg-[#f5efe8] p-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-medium text-[#30434d]">Protected route</p>
        <button
          onClick={fetchProtected}
          className="inline-flex items-center rounded-full bg-[#1f2f38] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#15232b]"
        >
          Fetch /api/protected
        </button>
      </div>
      {result && (
        <pre className="mt-3 overflow-x-auto rounded-lg bg-white/60 p-3 text-xs text-[#30434d]">
          {result}
        </pre>
      )}
    </div>
  );
}

function SessionCard() {
  const response = use(getSessionPromise());

  if (!response.authenticated) {
    return (
      <section className="w-full max-w-md rounded-4xl border border-black/10 bg-white/90 p-8 text-left shadow-[0_30px_120px_rgba(36,51,66,0.14)] backdrop-blur">
        <p className="text-sm font-medium uppercase tracking-[0.25em] text-[#7d6a58]">OAuth Demo</p>
        <h1 className="mt-4 font-serif text-4xl leading-tight text-[#1f2f38]">
          Sign in with the Better Auth server
        </h1>
        <p className="mt-4 text-sm leading-6 text-[#4a5d68]">
          This example app is registered as a confidential OAuth client. It sends you to the auth
          worker, exchanges the authorization code on the server, and keeps tokens in an HttpOnly
          cookie.
        </p>
        <button
          onClick={() => auth.login()}
          className="mt-8 inline-flex items-center rounded-full bg-[#1f2f38] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#15232b]"
        >
          Continue to login
        </button>
      </section>
    );
  }

  const { user, session } = response;
  const expiresAt = new Date(session.expiresAt * 1000);

  return (
    <section className="w-full max-w-md rounded-4xl border border-black/10 bg-white/90 p-8 text-left shadow-[0_30px_120px_rgba(36,51,66,0.14)] backdrop-blur">
      <p className="text-sm font-medium uppercase tracking-[0.25em] text-[#7d6a58]">Signed in</p>
      <div className="mt-6 flex items-center gap-4">
        {user.picture ? (
          <img
            alt={user.name ?? user.email}
            className="size-16 rounded-full object-cover ring-4 ring-[#efe5d7]"
            src={user.picture}
          />
        ) : (
          <div className="flex size-16 items-center justify-center rounded-full bg-[#efe5d7] text-xl font-semibold text-[#1f2f38]">
            {(user.name ?? user.email).slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="truncate font-serif text-3xl leading-tight text-[#1f2f38]">
            {user.name ?? "Authenticated user"}
          </h1>
          <p className="truncate text-sm text-[#4a5d68]">{user.email}</p>
        </div>
      </div>

      <dl className="mt-8 space-y-3 rounded-2xl bg-[#f5efe8] p-4 text-sm text-[#30434d]">
        <div className="flex items-start justify-between gap-4">
          <dt className="font-medium">User ID</dt>
          <dd className="max-w-[16rem] truncate font-mono text-xs">{user.id}</dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="font-medium">Scopes</dt>
          <dd className="max-w-[16rem] text-right">{session.scope}</dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="font-medium">Access token expiry</dt>
          <dd>{expiresAt.toLocaleTimeString()}</dd>
        </div>
      </dl>

      <ProtectedRouteTest />

      <div className="mt-8 flex flex-wrap gap-3">
        <a
          className="inline-flex items-center rounded-full border border-[#1f2f38] px-4 py-2 text-sm font-semibold text-[#1f2f38] transition hover:bg-[#1f2f38] hover:text-white"
          href="http://localhost:5173/"
          rel="noreferrer"
          target="_blank"
        >
          Open auth worker
        </a>
        <button
          className="inline-flex items-center rounded-full bg-[#d26d4d] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#bb5b3d]"
          onClick={() => auth.logout().then(() => window.location.reload())}
        >
          Log out
        </button>
      </div>
    </section>
  );
}

export function App() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center p-6">
      <Suspense
        fallback={
          <section className="w-full max-w-md rounded-4xl border border-black/10 bg-white/80 p-8 text-left shadow-[0_30px_120px_rgba(36,51,66,0.14)] backdrop-blur">
            <p className="text-sm font-medium uppercase tracking-[0.25em] text-[#7d6a58]">
              OAuth Demo
            </p>
            <h1 className="mt-4 font-serif text-4xl leading-tight text-[#1f2f38]">
              Checking your session
            </h1>
          </section>
        }
      >
        <SessionCard />
      </Suspense>
    </main>
  );
}

export default App;
