import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { useLiveState } from "os-next/react";
import { openAudio, type AudioSession } from "../../audio.ts";
import { startCall, type Call, type CallFact } from "../../call.ts";

/** The relay's live view (apps/os-next/examples/voice-agent VoiceLiveView), parsed at the seed door. */
const VoiceLiveView = z.object({
  phase: z.enum(["idle", "dialing", "live", "ended"]),
  activation: z.string().nullable(),
  answering: z.boolean(),
  transcript: z.array(z.object({ role: z.enum(["listener", "assistant"]), text: z.string() })),
  lastEnd: z.object({ activation: z.string(), reason: z.string() }).nullable(),
});
type VoiceLiveView = z.infer<typeof VoiceLiveView>;

export const Route = createFileRoute("/_auth/call")({
  validateSearch: z.object({ project: z.string().optional() }),
  loader: async ({ context }) => ({ projects: await context.api.projects.list() }),
  component: CallPage,
});

function CallPage() {
  const { api, info } = Route.useRouteContext();
  const { projects } = Route.useLoaderData();
  const search = Route.useSearch();
  const [projectId, setProjectId] = useState(search.project || projects[0]?.id || "");
  const [audio, setAudio] = useState<AudioSession>();
  const [call, setCall] = useState<Call>();
  const [facts, setFacts] = useState<CallFact[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const live = useLiveState<VoiceLiveView>(call?.itx, {
    key: "voice-agent",
    door: async () =>
      z
        .object({ rev: z.number(), state: VoiceLiveView })
        .parse(await call!.itx.invoke("itx.facets.get('voice-agent').liveSnapshot()")),
  });
  const view = live.value;
  const onCall = async () => {
    setBusy(true);
    setError(undefined);
    setFacts([]);
    let opened: AudioSession | undefined; // the session THIS press opened, not the render's state
    try {
      opened = await openAudio(); // inside the click: the browser wants a gesture
      setAudio(opened);
      const started = await startCall({
        api,
        projectId,
        audio: opened,
        onFact: (fact) => setFacts((previous) => [...previous.slice(-19), fact]),
      });
      setCall(started);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      await opened?.close();
      setAudio(undefined);
    } finally {
      setBusy(false);
    }
  };
  const onHangUp = async () => {
    setBusy(true);
    try {
      await call?.hangUp();
      await audio?.close();
    } finally {
      setCall(undefined);
      setAudio(undefined);
      setBusy(false);
    }
  };
  return (
    <main>
      <p className="eyebrow">VOICE · {info.principal.email || info.principal.actor}</p>
      <h1>{call ? phaseTitle(view) : "Talk to your project"}</h1>
      {!call && (
        <label>
          Project{" "}
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={busy}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <p>
        {call ? (
          <button onClick={onHangUp} disabled={busy}>
            Hang up
          </button>
        ) : (
          <button onClick={onCall} disabled={busy || !projectId}>
            {busy ? "Connecting…" : "Call"}
          </button>
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      {call && (
        <section aria-label="Live state">
          <p>
            <span className={`dot ${view?.answering ? "on" : ""}`} />
            {live.status === "live" ? (view?.phase ?? "live") : live.status}
            {view?.answering ? " · speaking" : ""}
            {view?.lastEnd ? ` · ${view.lastEnd.reason}` : ""}
            {live.error ? ` · ${live.error}` : ""}
          </p>
          <ol className="transcript">
            {(view?.transcript ?? []).map((turn, index) => (
              <li key={index} className={turn.role}>
                {turn.text}
              </li>
            ))}
          </ol>
          <ul className="facts">
            {facts.map((fact) => (
              <li key={fact.at}>{fact.text}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function phaseTitle(view: VoiceLiveView | undefined): string {
  switch (view?.phase) {
    case "live":
      return view.answering ? "Answering…" : "Listening";
    case "ended":
      return "Call ended";
    case "dialing":
      return "Calling…";
    default:
      return "Connecting…";
  }
}
