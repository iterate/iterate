import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { CircleIcon } from "lucide-react";
import { z } from "zod";
import { useLiveState } from "iterate/next/react";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { cn } from "@iterate-com/ui/lib/utils";
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

export const Route = createFileRoute("/_auth/projects/$slug")({
  loader: async ({ context, params }) => {
    const projects = await context.api.projects.list();
    // the URL names the project by slug (its id works too); one this sign-in lacks → sign in again
    const project = projects.find((item) => item.slug === params.slug || item.id === params.slug);
    if (!project) return context.signInFor(params.slug);
    return { projects, project };
  },
  component: CallPage,
});

function CallPage() {
  const { info } = Route.useRouteContext();
  const { projects, project } = Route.useLoaderData();
  const href = useRouterState({ select: (state) => state.location.href });
  return (
    <AppShell
      app="Voice"
      projects={projects}
      activeProjectId={project?.id || null}
      projectHref={(item) => `/projects/${item.slug}`}
      header={
        project ? (
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:inline-flex">Voice</BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:inline-flex" />
              <BreadcrumbItem>
                <BreadcrumbPage className="font-mono">{project.slug}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        ) : null
      }
      account={{ email: info.principal.email || info.principal.actor }}
      locationKey={href}
    >
      {project ? (
        <Phone key={project.id} project={project.id} />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>
              <a href="https://dash.iterate2.com/projects" className="underline underline-offset-4">
                Create a project
              </a>{" "}
              in the dash, install its voice agent, then call it here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </AppShell>
  );
}

/** The phone: Call opens the microphone inside the click (the browser wants the gesture) and
 *  places the call; Hang up ends it and reports what this browser saw. */
function Phone({ project }: { project: string }) {
  const { api } = Route.useRouteContext();
  const [audio, setAudio] = useState<AudioSession>();
  const [call, setCall] = useState<Call>();
  const [facts, setFacts] = useState<CallFact[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastStats, setLastStats] = useState<string>();
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
        projectId: project,
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
      if (call && audio) {
        // What this browser saw: the one hop the relay cannot measure.
        const speaker = await audio.speaker.stats();
        const s = call.stats;
        setLastStats(
          `last call: handshake ${s.handshakeMs ?? "?"} ms · mic ${s.micFramesSent} frames sent, ${s.micFramesDropped} dropped · ` +
            `speaker ${s.spkChunksReceived} chunks (${Math.round(s.spkMsReceived)} ms) received, ${speaker.playedMs} ms played, ${speaker.underruns} underruns`,
        );
      }
      await audio?.close();
    } finally {
      setCall(undefined);
      setAudio(undefined);
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-4 md:p-8">
      <p className="text-2xl font-semibold">{call ? phaseTitle(view) : "Talk to your project"}</p>
      <div>
        {call ? (
          <Button
            size="lg"
            variant="destructive"
            className="rounded-full px-8"
            onClick={onHangUp}
            disabled={busy}
          >
            Hang up
          </Button>
        ) : (
          <Button size="lg" className="rounded-full px-8" onClick={onCall} disabled={busy}>
            {busy ? "Connecting…" : "Call"}
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-sm break-words text-destructive">
          {error}
        </p>
      ) : null}
      {!call && lastStats ? (
        <p className="font-mono text-xs break-words text-muted-foreground">{lastStats}</p>
      ) : null}
      {call ? (
        <section aria-label="Live state" className="flex flex-col gap-4">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleIcon
              className={cn(
                "size-2 shrink-0",
                view?.answering
                  ? "fill-emerald-500 text-emerald-500"
                  : "fill-muted-foreground/40 text-muted-foreground/40",
              )}
            />
            <span>
              {live.status === "live" ? (view?.phase ?? "live") : live.status}
              {view?.answering ? " · speaking" : ""}
              {view?.lastEnd ? ` · ${view.lastEnd.reason}` : ""}
              {live.error ? ` · ${live.error}` : ""}
            </span>
          </p>
          <ol className="flex flex-col gap-2">
            {(view?.transcript ?? []).map((turn, index) => (
              <li
                key={index}
                className={cn(
                  "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm break-words",
                  turn.role === "listener"
                    ? "self-end bg-primary text-primary-foreground"
                    : "self-start bg-muted",
                )}
              >
                {turn.text}
              </li>
            ))}
          </ol>
          <ul className="flex flex-col gap-1 font-mono text-xs break-words text-muted-foreground">
            {facts.map((fact) => (
              <li key={fact.at}>{fact.text}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
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
