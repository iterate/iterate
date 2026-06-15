import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon } from "lucide-react";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { toast } from "@iterate-com/ui/components/sonner";
import {
  DEFAULT_OPENAI_AGENT_MODEL,
  configuredAgentSetupEvents,
  defaultAgentSystemPrompt,
} from "~/domains/agents/agent-presets.ts";
import {
  agentProcessorSubscriptionConfiguredEvents,
  defaultAgentProcessorSlugs,
} from "~/domains/agents/agent-stream-subscriptions.ts";
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
  const { project } = Route.useLoaderData();
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
      // provider's pooled socket; seed the agent stream, then send the message
      // through itx.agents.sendMessage (force-wakes the agent DO).
      const itx = await connectItx({ projectId: params.projectSlug });
      await itx.streams.get(agentPath).appendBatch([
        ...configuredAgentSetupEvents({
          idempotencyKeyPrefix: "os-agent-new:web-setup",
          model: DEFAULT_OPENAI_AGENT_MODEL,
          provider: "openai-ws",
          runOpts: {},
          systemPrompt: defaultAgentSystemPrompt(agentPath),
        }),
        ...agentProcessorSubscriptionConfiguredEvents({
          agentPath,
          processorSlugs: defaultAgentProcessorSlugs("openai-ws"),
          projectId: project.id,
        }),
      ]);
      await itx.agents.sendMessage({ agentPath, message: content, channel: "web" });
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

function slugifyCreationTime(date: Date) {
  return date
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
