import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon } from "lucide-react";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { toast } from "@iterate-com/ui/components/sonner";
import { connectItx } from "~/itx/itx-react.tsx";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/new")({
  staticData: { hideAppHeader: true },
  loader: async ({ context }) => {
    const { project } = context;

    return { project };
  },
  component: NewAgentPage,
});

function NewAgentPage() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  const createAgent = useMutation({
    mutationFn: async (content: string) => {
      const agentPath = newWebAgentPath();
      // connectItx (imperative, not the suspending hook) lands on the project
      // provider's socket. Agent setup is seeded server-side now (#1524): create
      // the stream, wait for the project-agent-setup processor to write the
      // system prompt, then append the user's first input.
      const itx = await connectItx({ projectId: params.projectSlug });
      await itx.streams.create({ streamPath: agentPath });
      await waitForProjectAgentSetup(itx, agentPath);
      await itx.streams.get(agentPath).append({
        event: {
          type: "events.iterate.com/agent/input-added",
          payload: { content },
        },
      });
      return agentPath;
    },
    onSuccess: (agentPath) => {
      void navigate({
        to: "/projects/$projectSlug/agents/streams/$",
        params: {
          ...params,
          _splat: agentPath,
        },
      });
    },
    onError: (mutationError) => {
      const message =
        mutationError instanceof Error ? mutationError.message : String(mutationError);
      setError(message);
      toast.error(message);
    },
  });

  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const content = message.trim();
    if (content === "" || createAgent.isPending) return;
    setError(undefined);
    createAgent.mutate(content);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  const canSubmit = message.trim() !== "" && !createAgent.isPending;

  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-3xl">
        {error == null ? null : (
          <p className="mb-2 ml-4 truncate font-mono text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-end gap-2 rounded-3xl border bg-background py-2 pl-4 pr-2 shadow-sm">
          <textarea
            ref={composerRef}
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            onKeyDown={onComposerKeyDown}
            rows={1}
            placeholder="Message a new agent"
            className="field-sizing-content max-h-32 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-base leading-snug outline-none"
          />
          <Button
            size="icon-lg"
            type="submit"
            title="Create agent"
            disabled={!canSubmit}
            className="rounded-full"
          >
            {createAgent.isPending ? (
              <Spinner className="size-4" />
            ) : (
              <ArrowUpIcon className="size-4" />
            )}
          </Button>
        </div>
      </form>
    </main>
  );
}

function newWebAgentPath() {
  return StreamPath.parse(`/agents/web/${slugifyCreationTime(new Date())}`);
}

async function waitForProjectAgentSetup(
  itx: Awaited<ReturnType<typeof connectItx>>,
  streamPath: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = await itx.streams.get(streamPath).getEvents();
    if (
      events.some(
        (event) =>
          (event as { idempotencyKey?: string }).idempotencyKey ===
          "project-agent-setup:system-prompt",
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for agent setup.");
}

function slugifyCreationTime(date: Date) {
  return date
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
