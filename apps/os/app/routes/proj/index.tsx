import { useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Circle, MessageSquare, Plus, SendHorizontal, Server } from "lucide-react";
import { z } from "zod/v4";
import { StickToBottom } from "use-stick-to-bottom";
import { Streamdown } from "streamdown";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card } from "../../components/ui/card.tsx";
import { EmptyState } from "../../components/empty-state.tsx";
import { HeaderActions } from "../../components/header-actions.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { cn } from "../../lib/utils.ts";

const Search = z.object({
  thread: z.string().optional(),
});

export const Route = createFileRoute("/_auth/proj/$projectSlug/")({
  validateSearch: Search,
  // Note: project.bySlug is already preloaded in the parent proj layout
  component: ProjectHomePage,
});

function ProjectHomePage() {
  const params = useParams({
    from: "/_auth/proj/$projectSlug/",
  });
  const search = useSearch({
    from: "/_auth/proj/$projectSlug/",
  });
  const navigate = useNavigate({
    from: Route.fullPath,
  });
  const queryClient = useQueryClient();
  const [draftMessage, setDraftMessage] = useState("");

  const { data: machines } = useSuspenseQuery(
    trpc.machine.list.queryOptions({
      projectSlug: params.projectSlug,
      includeArchived: false,
    }),
  );

  const activeMachine = machines.find((machine) => machine.state === "active") ?? null;

  const { data: threadsData } = useSuspenseQuery(
    trpc.webChat.listThreads.queryOptions({
      projectSlug: params.projectSlug,
    }),
  );

  const isCreatingThread = search.thread === "new";
  const selectedThreadId = isCreatingThread
    ? undefined
    : (search.thread ?? threadsData.threads[0]?.threadId);

  const { data: messagesData } = useSuspenseQuery(
    trpc.webChat.getThreadMessages.queryOptions({
      projectSlug: params.projectSlug,
      threadId: selectedThreadId,
    }),
  );

  const messages = selectedThreadId ? messagesData.messages : [];

  const sendMessage = useMutation({
    mutationFn: async (input: { text: string }) =>
      trpcClient.webChat.sendMessage.mutate({
        projectSlug: params.projectSlug,
        threadId: selectedThreadId,
        text: input.text,
      }),
    onSuccess: async (result) => {
      setDraftMessage("");

      if (result.threadId !== selectedThreadId) {
        navigate({ search: { thread: result.threadId }, replace: true });
      }

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.webChat.listThreads.queryKey({ projectSlug: params.projectSlug }),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.webChat.getThreadMessages.queryKey({
            projectSlug: params.projectSlug,
            threadId: result.threadId,
          }),
        }),
      ]);
    },
    onError: (error) => {
      toast.error(`Failed to send message: ${error.message}`);
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draftMessage.trim();
    if (!text || sendMessage.isPending || !activeMachine) {
      return;
    }

    sendMessage.mutate({ text });
  };

  return (
    <div className="p-4 space-y-4" data-component="ProjectHomePage">
      <HeaderActions>
        <Button
          type="button"
          size="sm"
          variant={isCreatingThread ? "default" : "outline"}
          onClick={() => navigate({ search: { thread: "new" } })}
        >
          <Plus className="h-4 w-4" />
          New Thread
        </Button>
      </HeaderActions>

      {activeMachine ? null : (
        <Card className="p-4">
          <EmptyState
            icon={<Server className="h-8 w-8" />}
            title="No active machine"
            description="Web chat runs through your active machine, like Slack and email webhooks."
            action={
              <Button asChild size="sm">
                <Link to="/proj/$projectSlug/machines" params={params}>
                  Open machines
                </Link>
              </Button>
            }
          />
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <section className="space-y-3">
          {threadsData.threads.length === 0 ? (
            <Card className="p-4">
              <EmptyState
                icon={<MessageSquare className="h-5 w-5" />}
                title="No threads yet"
                description="Send a first message to start a thread."
                className="py-8"
              />
            </Card>
          ) : (
            <div className="space-y-3">
              {threadsData.threads.map((thread) => {
                const isSelected = thread.threadId === selectedThreadId && !isCreatingThread;
                return (
                  <button
                    key={thread.threadId}
                    type="button"
                    data-testid={`web-chat-thread-${thread.threadId}`}
                    className={cn(
                      "w-full rounded-lg border bg-card p-3 text-left transition-colors",
                      "hover:bg-muted/50",
                      isSelected ? "border-primary bg-primary/5" : "border-border",
                    )}
                    onClick={() => navigate({ search: { thread: thread.threadId } })}
                  >
                    <p className="truncate text-sm font-medium">{thread.title}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {thread.lastMessagePreview}
                    </p>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <Circle
                        className={cn(
                          "h-2.5 w-2.5 fill-current",
                          thread.lastMessageRole === "assistant"
                            ? "text-sky-500"
                            : "text-emerald-500",
                        )}
                      />
                      <span>{thread.messageCount} messages</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="space-y-3 min-w-0">
          <Card className="overflow-hidden">
            <StickToBottom className="h-[360px]">
              <StickToBottom.Content className="space-y-3 p-4">
                {messages.length === 0 ? (
                  <EmptyState
                    icon={<MessageSquare className="h-5 w-5" />}
                    title="Start a new thread"
                    description="Chat with your project configuration from here."
                    className="py-10"
                  />
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.messageId}
                      data-testid={`web-chat-message-${message.role}`}
                      className={cn(
                        "flex",
                        message.role === "user" ? "justify-end" : "justify-start",
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[92%] rounded-lg px-3 py-2 text-sm",
                          message.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-foreground",
                        )}
                      >
                        {message.role === "assistant" ? (
                          <Streamdown>{message.text}</Streamdown>
                        ) : (
                          <p className="whitespace-pre-wrap break-words">{message.text}</p>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </StickToBottom.Content>
            </StickToBottom>
          </Card>

          <form className="space-y-2" onSubmit={handleSubmit}>
            <Textarea
              data-testid="web-chat-input"
              value={draftMessage}
              onChange={(event) => setDraftMessage(event.target.value)}
              placeholder="Message your project..."
              disabled={!activeMachine || sendMessage.isPending}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Shift+Enter for newline. Enter to send.
              </p>
              <Button
                data-testid="web-chat-send"
                type="submit"
                size="sm"
                disabled={!activeMachine || sendMessage.isPending || !draftMessage.trim()}
              >
                <SendHorizontal className="h-4 w-4" />
                Send
              </Button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
