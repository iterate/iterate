import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  Circle,
  Download,
  ExternalLink,
  File,
  Loader2,
  MessageSquare,
  Paperclip,
  Plus,
  SendHorizontal,
  Server,
  Terminal,
  X,
} from "lucide-react";
import { z } from "zod/v4";
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
  component: ProjectHomePage,
});

// --- Types ---

interface FileAttachment {
  fileName: string;
  filePath: string;
  mimeType?: string;
  size?: number;
}

interface PendingFile {
  id: string;
  file: globalThis.File;
  preview?: string;
}

// --- Helpers ---

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);
const PREVIEW_TYPES = new Set([...IMAGE_TYPES, "application/pdf"]);

const EXT_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

/** Resolve mimeType — use provided value or infer from file extension. */
function resolveMime(mimeType?: string, fileName?: string): string {
  if (mimeType) return mimeType;
  if (!fileName) return "";
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  return EXT_TO_MIME[ext] ?? "";
}

function isImageType(mimeType?: string): boolean {
  return !!mimeType && IMAGE_TYPES.has(mimeType);
}

function isPreviewableType(mimeType?: string): boolean {
  return !!mimeType && PREVIEW_TYPES.has(mimeType);
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build a URL to serve a file from the machine through the existing proxy.
 * Pattern: /org/{org}/proj/{project}/{machineId}/proxy/3001/api/files/read/{filePath}
 */
function buildFileUrl(
  orgSlug: string,
  projectSlug: string,
  machineId: string,
  filePath: string,
  download?: boolean,
): string {
  const encodedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
  const base = `/org/${orgSlug}/proj/${projectSlug}/${machineId}/proxy/3001/api/files/read/${encodedPath}`;
  return download ? `${base}?download=1` : base;
}

function buildUploadUrl(orgSlug: string, projectSlug: string, machineId: string): string {
  return `/org/${orgSlug}/proj/${projectSlug}/${machineId}/proxy/3001/api/files/upload`;
}

// --- Component ---

function ProjectHomePage() {
  const params = useParams({ from: "/_auth/proj/$projectSlug/" });
  const search = useSearch({ from: "/_auth/proj/$projectSlug/" });
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  const [draftMessage, setDraftMessage] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: projectData } = useSuspenseQuery(
    trpc.project.bySlug.queryOptions({ projectSlug: params.projectSlug }),
  );
  const orgSlug = projectData.organization?.slug ?? "";

  const { data: machines } = useSuspenseQuery(
    trpc.machine.list.queryOptions({ projectSlug: params.projectSlug, includeArchived: false }),
  );
  const activeMachine = machines.find((m) => m.state === "active") ?? null;

  const { data: threadsData } = useSuspenseQuery(
    trpc.webChat.listThreads.queryOptions({ projectSlug: params.projectSlug }),
  );

  const isCreatingThread = search.thread === "new";
  const selectedThreadId = isCreatingThread
    ? undefined
    : (search.thread ?? threadsData.threads[0]?.threadId);

  const { data: messagesData } = useQuery({
    ...trpc.webChat.getThreadMessages.queryOptions({
      projectSlug: params.projectSlug,
      threadId: selectedThreadId,
    }),
    refetchInterval: selectedThreadId ? 3000 : false,
  });

  const messages = selectedThreadId ? (messagesData?.messages ?? []) : [];
  const agentSessionUrl = messagesData?.agentSessionUrl;
  const threadStatus = messagesData?.status;

  const messagesEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // --- File handling ---

  const addFiles = useCallback((files: globalThis.File[]) => {
    const newPending = files.map((file) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const preview = isImageType(file.type) ? URL.createObjectURL(file) : undefined;
      return { id, file, preview };
    });
    setPendingFiles((prev) => [...prev, ...newPending]);
  }, []);

  const removePendingFile = useCallback((id: string) => {
    setPendingFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (file?.preview) URL.revokeObjectURL(file.preview);
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const uploadFile = useCallback(
    async (file: globalThis.File): Promise<FileAttachment> => {
      if (!activeMachine) throw new Error("No active machine");
      const formData = new FormData();
      formData.append("file", file);
      const url = buildUploadUrl(orgSlug, params.projectSlug, activeMachine.id);
      const response = await fetch(url, { method: "POST", body: formData });
      if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
      const data = (await response.json()) as {
        filePath: string;
        fileName: string;
        size: number;
        mimeType: string;
      };
      return {
        fileName: data.fileName,
        filePath: data.filePath,
        mimeType: data.mimeType,
        size: data.size,
      };
    },
    [activeMachine, orgSlug, params.projectSlug],
  );

  // --- Send ---

  const sendMessage = useMutation({
    mutationFn: async (input: { text: string; attachments?: FileAttachment[] }) =>
      trpcClient.webChat.sendMessage.mutate({
        projectSlug: params.projectSlug,
        threadId: selectedThreadId,
        text: input.text,
        attachments: input.attachments,
      }),
    onSuccess: async (result) => {
      setDraftMessage("");
      setPendingFiles([]);
      if (result.threadId && result.threadId !== selectedThreadId) {
        void navigate({ search: { thread: result.threadId }, replace: true });
      }
      await queryClient.invalidateQueries({
        queryKey: trpc.webChat.listThreads.queryKey({ projectSlug: params.projectSlug }),
      });
    },
    onError: (error) => {
      toast.error(`Failed to send message: ${error.message}`);
    },
  });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draftMessage.trim();
    if ((!text && pendingFiles.length === 0) || sendMessage.isPending || !activeMachine) return;

    let attachments: FileAttachment[] | undefined;
    if (pendingFiles.length > 0) {
      try {
        attachments = await Promise.all(pendingFiles.map((pf) => uploadFile(pf.file)));
      } catch (error) {
        toast.error(`File upload failed: ${error instanceof Error ? error.message : "Unknown"}`);
        return;
      }
    }

    sendMessage.mutate({ text, attachments });
  };

  // --- Drag/drop/paste ---

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setIsDragOver(false);
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) addFiles(files);
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length > 0) {
        event.preventDefault();
        addFiles(files);
      }
    },
    [addFiles],
  );

  return (
    <div
      className="flex flex-col gap-4 p-4"
      style={{ height: "calc(100svh - 4rem)" }}
      data-component="ProjectHomePage"
    >
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

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* Thread sidebar */}
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

        {/* Messages + input */}
        <section className="flex min-h-0 min-w-0 flex-col gap-3">
          {selectedThreadId && messages.length > 0 ? (
            <div className="flex flex-shrink-0 items-center justify-between rounded-lg border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
              <span className="truncate font-medium">
                {threadsData.threads.find((t) => t.threadId === selectedThreadId)?.title ??
                  "Thread"}
              </span>
              {agentSessionUrl ? (
                <a
                  href={agentSessionUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
                >
                  <Terminal className="h-3 w-3" />
                  Attach
                </a>
              ) : null}
            </div>
          ) : null}
          <Card className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
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
                  className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[92%] rounded-lg px-3 py-2 text-sm space-y-2",
                      message.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground",
                    )}
                  >
                    {message.text ? (
                      <p className="whitespace-pre-wrap break-words">{message.text}</p>
                    ) : null}
                    {message.attachments?.map((att, i) => (
                      <AttachmentPreview
                        key={i}
                        attachment={att}
                        orgSlug={orgSlug}
                        projectSlug={params.projectSlug}
                        machineId={activeMachine?.id ?? ""}
                        isUserMessage={message.role === "user"}
                        onImageClick={setLightbox}
                      />
                    ))}
                  </div>
                </div>
              ))
            )}
            {threadStatus ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>{threadStatus}</span>
              </div>
            ) : null}
            <div ref={messagesEndRef} />
          </Card>

          <form className="flex-shrink-0 space-y-2" onSubmit={handleSubmit}>
            {/* Pending file previews */}
            {pendingFiles.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {pendingFiles.map((pf) => (
                  <div
                    key={pf.id}
                    className="relative rounded-md border bg-muted p-1.5 flex items-center gap-2 text-xs"
                  >
                    {pf.preview ? (
                      <img
                        src={pf.preview}
                        alt={pf.file.name}
                        className="h-10 w-10 rounded object-cover"
                      />
                    ) : (
                      <File className="h-5 w-5 text-muted-foreground" />
                    )}
                    <span className="max-w-[120px] truncate">{pf.file.name}</span>
                    <button
                      type="button"
                      className="ml-1 rounded-full p-0.5 hover:bg-background"
                      onClick={() => removePendingFile(pf.id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div
              className={cn(
                "relative rounded-md transition-colors",
                isDragOver && "ring-2 ring-primary ring-offset-2",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
            >
              <Textarea
                data-testid="web-chat-input"
                value={draftMessage}
                onChange={(event) => setDraftMessage(event.target.value)}
                placeholder="Message your project... (paste or drop files)"
                disabled={!activeMachine || sendMessage.isPending}
                onPaste={handlePaste}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!activeMachine}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  multiple
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 0) addFiles(files);
                    e.target.value = "";
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Shift+Enter for newline. Enter to send.
                </p>
              </div>
              <Button
                data-testid="web-chat-send"
                type="submit"
                size="sm"
                disabled={
                  !activeMachine ||
                  sendMessage.isPending ||
                  (!draftMessage.trim() && pendingFiles.length === 0)
                }
              >
                <SendHorizontal className="h-4 w-4" />
                Send
              </Button>
            </div>
          </form>
        </section>
      </div>

      {/* Image lightbox */}
      {lightbox ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
          onClick={() => setLightbox(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setLightbox(null);
          }}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <img
            src={lightbox.src}
            alt={lightbox.alt}
            className="rounded-lg object-contain shadow-2xl"
            style={{ maxHeight: "75vh", maxWidth: "min(75vw, 800px)" }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
    </div>
  );
}

// --- Attachment preview component ---

function AttachmentPreview({
  attachment,
  orgSlug,
  projectSlug,
  machineId,
  isUserMessage,
  onImageClick,
}: {
  attachment: FileAttachment;
  orgSlug: string;
  projectSlug: string;
  machineId: string;
  isUserMessage: boolean;
  onImageClick?: (info: { src: string; alt: string }) => void;
}) {
  if (!machineId) return null;

  const viewUrl = buildFileUrl(orgSlug, projectSlug, machineId, attachment.filePath);
  const downloadUrl = buildFileUrl(orgSlug, projectSlug, machineId, attachment.filePath, true);
  const mime = resolveMime(attachment.mimeType, attachment.fileName);

  // Inline image preview
  if (isImageType(mime)) {
    return (
      <div className="space-y-1">
        <button
          type="button"
          className="cursor-zoom-in"
          onClick={() => onImageClick?.({ src: viewUrl, alt: attachment.fileName })}
        >
          <img
            src={viewUrl}
            alt={attachment.fileName}
            className="max-h-48 max-w-full rounded object-contain"
            loading="lazy"
          />
        </button>
        <div className="flex items-center gap-1.5 text-xs opacity-70">
          <span className="truncate">{attachment.fileName}</span>
          {attachment.size ? <span>{formatFileSize(attachment.size)}</span> : null}
          <a href={downloadUrl} className="inline-flex" title="Download">
            <Download className="h-3 w-3" />
          </a>
        </div>
      </div>
    );
  }

  // PDF — show link to view inline + download
  if (mime === "application/pdf") {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded border p-2 text-xs",
          isUserMessage ? "border-primary-foreground/20" : "border-border",
        )}
      >
        <File className="h-4 w-4 shrink-0" />
        <span className="truncate flex-1">{attachment.fileName}</span>
        {attachment.size ? (
          <span className="text-muted-foreground shrink-0">{formatFileSize(attachment.size)}</span>
        ) : null}
        <a href={viewUrl} target="_blank" rel="noreferrer" title="View">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <a href={downloadUrl} title="Download">
          <Download className="h-3.5 w-3.5" />
        </a>
      </div>
    );
  }

  // Generic file — download link
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded border p-2 text-xs",
        isUserMessage ? "border-primary-foreground/20" : "border-border",
      )}
    >
      <File className="h-4 w-4 shrink-0" />
      <span className="truncate flex-1">{attachment.fileName}</span>
      {attachment.size ? (
        <span className="text-muted-foreground shrink-0">{formatFileSize(attachment.size)}</span>
      ) : null}
      {isPreviewableType(mime) ? (
        <a href={viewUrl} target="_blank" rel="noreferrer" title="View">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : null}
      <a href={downloadUrl} title="Download">
        <Download className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}
