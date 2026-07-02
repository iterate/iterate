import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpIcon, MicIcon, SquareIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { toast } from "@iterate-com/ui/components/sonner";
import { cn } from "@iterate-com/ui/lib/utils";
import { VoiceSession, type VoiceTranscriptEntry } from "~/components/voice/voice-session.ts";
import { mintVoiceRealtimeConnectionServerFn } from "~/lib/voice-server-fns.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/voice")({
  ssr: false,
  loader: async ({ context }) => {
    const { project } = context;
    return { project };
  },
  component: VoicePage,
});

function VoicePage() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const [session] = useState(
    () =>
      new VoiceSession({
        projectId: project.id,
        agentPath: `/agents/voice/${sessionSlug(new Date())}`,
        mint: () => mintVoiceRealtimeConnectionServerFn(),
      }),
  );
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [message, setMessage] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);

  const start = useMutation({
    mutationFn: (withMic: boolean) => session.start({ withMic }),
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  function submitText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim()) return;
    session.sendText(message);
    setMessage("");
    requestAnimationFrame(() => {
      transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
    });
  }

  const live = snapshot.status === "live";

  return (
    <main className="mx-auto flex h-full w-full max-w-3xl flex-1 flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Voice</h1>
          <p className="text-sm text-muted-foreground">
            worker agent:{" "}
            <Link
              to="/projects/$projectSlug/agents/streams/$"
              params={{ ...params, _splat: session.agentPath }}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              {session.agentPath}
            </Link>
          </p>
        </div>
        {live ? (
          <Button variant="destructive" onClick={() => session.stop()}>
            <SquareIcon className="size-4" /> End session
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button onClick={() => start.mutate(true)} disabled={start.isPending}>
              {start.isPending ? <Spinner className="size-4" /> : <MicIcon className="size-4" />}
              Start voice session
            </Button>
            <Button
              variant="outline"
              onClick={() => start.mutate(false)}
              disabled={start.isPending}
            >
              Text only
            </Button>
          </div>
        )}
      </header>

      <div
        ref={transcriptRef}
        className="flex-1 space-y-2 overflow-y-auto rounded-xl border bg-background p-4"
      >
        {snapshot.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Start a session, then just talk (or type below). Your turns are relayed to the worker
            agent, which does real work in this project; the voice assistant speaks its results.
            Headphones aren&apos;t required — the browser does echo cancellation.
          </p>
        ) : (
          snapshot.entries.map((entry) => <TranscriptRow key={entry.id} entry={entry} />)
        )}
      </div>

      <form onSubmit={submitText} className="flex items-end gap-2">
        <textarea
          value={message}
          onChange={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          rows={1}
          placeholder={live ? "Type instead of speaking…" : "Start a session first"}
          disabled={!live}
          className="field-sizing-content max-h-32 min-w-0 flex-1 resize-none rounded-3xl border bg-background px-4 py-2 text-base leading-snug outline-none"
        />
        <Button size="icon-lg" type="submit" disabled={!live || !message.trim()}>
          <ArrowUpIcon className="size-4" />
        </Button>
      </form>
    </main>
  );
}

function TranscriptRow({ entry }: { entry: VoiceTranscriptEntry }) {
  const label = {
    you: "you",
    assistant: "assistant",
    "worker-request": "→ worker",
    "worker-reply": "← worker",
    status: "•",
    error: "⚠",
  }[entry.kind];
  return (
    <p
      className={cn(
        "whitespace-pre-wrap text-sm",
        entry.kind === "assistant" && "text-foreground",
        entry.kind === "you" && "font-medium",
        (entry.kind === "worker-request" || entry.kind === "worker-reply") &&
          "font-mono text-xs text-muted-foreground",
        entry.kind === "status" && "text-xs text-muted-foreground",
        entry.kind === "error" && "text-xs text-destructive",
      )}
    >
      <span className="mr-2 inline-block min-w-16 text-muted-foreground">{label}</span>
      {entry.text}
    </p>
  );
}

function sessionSlug(date: Date) {
  return date
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
