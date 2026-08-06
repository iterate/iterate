import { useEffect, useState } from "react";
import {
  configureIterateSession,
  disconnectIterateSession,
  reconnectIterateSession,
  useItx,
  useLiveState,
  type CapabilityProvision,
} from "iterate/sdk/itx/react";
import { getAccessToken, isSignedIn, requestSignIn, signOut } from "./auth.ts";
import {
  browserCapability,
  browserCapabilityInstructions,
  browserCapabilityTypes,
} from "./browser-capability.ts";

const PROJECT_STORAGE_KEY = "iterateProjectSlug";

configureIterateSession({
  baseUrl: "https://os.iterate.com",
  credentials: async ({ forceRefresh }) => ({
    type: "bearer",
    token: await getAccessToken(forceRefresh),
  }),
});

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean>();
  const [projectSlug, setProjectSlug] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([isSignedIn(), chrome.storage.local.get(PROJECT_STORAGE_KEY)]).then(
      ([signedIn, stored]) => {
        setAuthenticated(signedIn);
        const savedSlug = stored[PROJECT_STORAGE_KEY];
        if (typeof savedSlug === "string") setProjectSlug(savedSlug);
      },
    );
  }, []);

  async function authenticate() {
    setBusy(true);
    setError(undefined);
    try {
      await requestSignIn();
      setAuthenticated(true);
      reconnectIterateSession();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function logOut() {
    await signOut();
    disconnectIterateSession();
    setAuthenticated(false);
  }

  async function updateProjectSlug(value: string) {
    setProjectSlug(value);
    await chrome.storage.local.set({ [PROJECT_STORAGE_KEY]: value });
  }

  if (authenticated === undefined) return <main>Loading…</main>;
  if (!authenticated) {
    return (
      <main>
        <h1>Iterate</h1>
        <p>Sign in to view a project's live processor state.</p>
        <button type="button" disabled={busy} onClick={authenticate}>
          {busy ? "Signing in…" : "Sign in with Iterate"}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </main>
    );
  }

  return (
    <main>
      <header>
        <h1>Project state</h1>
        <button className="secondary" type="button" onClick={logOut}>
          Sign out
        </button>
      </header>
      <label>
        Project slug
        <input
          value={projectSlug}
          onChange={(event) => void updateProjectSlug(event.target.value.trim())}
          placeholder="my-project"
          spellCheck={false}
        />
      </label>
      {projectSlug ? (
        <>
          <BrowserCapability key={projectSlug} projectSlug={projectSlug} />
          <ProjectState projectSlug={projectSlug} />
        </>
      ) : null}
    </main>
  );
}

function BrowserCapability({ projectSlug }: { projectSlug: string }) {
  const itx = useItx(projectSlug);
  const proofPrompt = `Use the ${projectSlug} project capability to call itx.chrome.openPage({ url: "https://example.com/?iterate-capability-proof=${encodeURIComponent(projectSlug)}" }). Then report the returned tabId and url.`;
  const [state, setState] = useState<
    { status: "connecting" } | { status: "available" } | { error: string; status: "error" }
  >({ status: "connecting" });

  useEffect(() => {
    let provision: CapabilityProvision | undefined;
    let stopped = false;
    setState({ status: "connecting" });

    void itx
      .provideCapability({
        capability: browserCapability,
        instructions: browserCapabilityInstructions,
        path: ["chrome"],
        type: "live",
        types: browserCapabilityTypes,
      })
      .then(
        (mounted) => {
          if (stopped) {
            mounted[Symbol.dispose]();
            return;
          }
          provision = mounted;
          setState({ status: "available" });
        },
        (cause: unknown) => {
          if (!stopped) {
            setState({
              error: cause instanceof Error ? cause.message : String(cause),
              status: "error",
            });
          }
        },
      );

    return () => {
      stopped = true;
      provision?.[Symbol.dispose]();
    };
  }, [itx]);

  return (
    <section className="capability">
      <div className="status">
        <span>Chrome capability</span>
        <span>{state.status}</span>
      </div>
      <code>itx.chrome.openPage({`{ url }`})</code>
      <div className="proof">
        <span>Post this to an agent to prove it works</span>
        <p>{proofPrompt}</p>
      </div>
      {state.status === "error" ? <p className="error">{state.error}</p> : null}
    </section>
  );
}

function ProjectState({ projectSlug }: { projectSlug: string }) {
  const state = useLiveState(
    (itx) => itx.liveState,
    (project) => project.reduced,
    [],
    { slug: projectSlug },
  );

  return (
    <section>
      <div className="status">
        <span>{state.status}</span>
        <button className="secondary" type="button" onClick={state.refresh}>
          Refresh
        </button>
      </div>
      <textarea
        aria-label="Project processor state"
        readOnly
        value={
          state.value === undefined
            ? "Waiting for live state…"
            : JSON.stringify(state.value, null, 2)
        }
      />
      {state.error ? <p className="error">{state.error}</p> : null}
    </section>
  );
}
