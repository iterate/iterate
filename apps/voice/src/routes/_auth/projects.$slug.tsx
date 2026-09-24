import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router";
import { useActionState, useRef, useState } from "react";
import { CircleIcon } from "lucide-react";
import { z } from "zod";
import { useLiveState } from "iterate/react";
import { AppShell } from "@iterate-com/ui/components/app-shell";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@iterate-com/ui/components/field";
import { SecretInput } from "@iterate-com/ui/components/not-recorded";
import { cn } from "cn";
import { ensureVoiceAgent, fetchVoiceInstall } from "../../../../agents/voice/install.ts";
import { openAudio, type AudioSession } from "../../audio.ts";
import { startCall, type Call, type CallFact } from "../../call.ts";

/** The relay's live view (apps/agents/voice VoiceLiveView), validated when reading the initial snapshot. */
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
    // Installed is what ensureVoiceAgent checks: the project has an `itx.voice` rule. One that
    // exists but fails is Call's error to report, never a reason to install over it.
    using itx = await context.api.projects.get(project.id);
    const [rule, secrets] = await Promise.all([
      itx.rewriteRules.get("itx.voice"),
      itx.secrets.list(),
    ]);
    const voice = {
      installed: Boolean(rule),
      hasOpenaiKey: secrets.some((secret) => secret.path === "/secrets/openai"),
    };
    return { projects, project, voice };
  },
  component: CallPage,
});

function CallPage() {
  const { info } = Route.useRouteContext();
  const { projects, project, voice } = Route.useLoaderData();
  const href = useRouterState({ select: (state) => state.location.href });
  return (
    <AppShell
      app="Voice"
      projects={projects}
      activeProjectId={project.id}
      projectHref={(item) => `/projects/${item.slug}`}
      header={
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem className="hidden md:inline-flex">Voice</BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:inline-flex" />
            <BreadcrumbItem>
              <BreadcrumbPage className="font-mono">{project.slug}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      }
      account={{ email: info.principal.email || info.principal.actor }}
      locationKey={href}
    >
      {voice.installed ? (
        <Phone key={project.id} project={project.id} />
      ) : (
        <InstallVoice key={project.id} project={project.id} needsOpenaiKey={!voice.hasOpenaiKey} />
      )}
    </AppShell>
  );
}

/** A project with no voice agent: the installer Kit's Prepare runs (apps/agents/voice/install.ts),
 *  here in the browser, as the signed-in person, against whichever platform this app is connected
 *  to. The key goes from this form to the project's `/secrets/openai`, pinned to OpenAI. */
function InstallVoice({ project, needsOpenaiKey }: { project: string; needsOpenaiKey: boolean }) {
  const { api } = Route.useRouteContext();
  const router = useRouter();
  const [error, install, installing] = useActionState(
    async (_previous: string | undefined, form: FormData) => {
      try {
        using itx = await api.projects.get(project);
        const openaiKey = String(form.get("openai-key") || "");
        await ensureVoiceAgent(itx, fetchVoiceInstall, openaiKey);
        // "needs-openai-key" too: the key was deleted since the page loaded, and the reload asks.
        // `sync`: the reload is awaited, so "Installing…" stays up until the page shows what the
        // install made. Without it the router reloads a route it already has data for in the
        // background, the action ends at once, and the form comes back empty (the install looks
        // failed) until the reload lands — seconds on a busy platform.
        await router.invalidate({ sync: true });
        return undefined;
      } catch (e: unknown) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    undefined,
  );
  return (
    <form action={install} className="mx-auto flex w-full max-w-xl flex-col gap-6 p-4 md:p-8">
      <div className="flex flex-col gap-2">
        <p className="text-2xl font-semibold">Install voice</p>
        <p className="text-sm text-muted-foreground">
          This project has no voice agent yet. Installing one adds it to the project, then you can
          call it from here.
        </p>
      </div>
      {needsOpenaiKey ? (
        <Field>
          <FieldLabel htmlFor="openai-key">OpenAI API key</FieldLabel>
          <SecretInput
            id="openai-key"
            name="openai-key"
            type="password"
            autoComplete="new-password"
            required
          />
          <FieldDescription>
            Saved as a secret in your project, and only ever sent to api.openai.com.
          </FieldDescription>
        </Field>
      ) : null}
      <div>
        <Button type="submit" size="lg" className="rounded-full px-8" disabled={installing}>
          {installing ? "Installing…" : "Install voice"}
        </Button>
      </div>
      {error ? (
        <p role="alert" data-type="error" className="text-sm break-words text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** The phone: Call opens the microphone inside the click (the browser wants the gesture) and
 *  places the call; Hang up ends it and reports what this browser saw. */
function Phone({ project }: { project: string }) {
  const { api } = Route.useRouteContext();
  // the microphone and speaker of the call in progress: read by Hang up, never rendered
  const audio = useRef<AudioSession>(undefined);
  const [call, setCall] = useState<Call>();
  const [facts, setFacts] = useState<CallFact[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastStats, setLastStats] = useState<string>();
  const live = useLiveState<VoiceLiveView>(call?.itx, {
    key: "voice-agent",
    readSeed: async () =>
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
      audio.current = opened;
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
      audio.current = undefined;
    } finally {
      setBusy(false);
    }
  };
  const onHangUp = async () => {
    setBusy(true);
    const opened = audio.current;
    try {
      await call?.hangUp();
      if (call && opened) {
        // What this browser saw: the one hop the relay cannot measure.
        const speaker = await opened.speaker.stats();
        const s = call.stats;
        setLastStats(
          `last call: handshake ${s.handshakeMs ?? "?"} ms · mic ${s.micFramesSent} frames sent, ${s.micFramesDropped} dropped · ` +
            `speaker ${s.spkChunksReceived} chunks (${Math.round(s.spkMsReceived)} ms) received, ${speaker.playedMs} ms played, ${speaker.underruns} underruns`,
        );
      }
      await opened?.close();
    } finally {
      setCall(undefined);
      audio.current = undefined;
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
        <p role="alert" data-type="error" className="text-sm break-words text-destructive">
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
              <li key={fact.id}>{fact.text}</li>
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
