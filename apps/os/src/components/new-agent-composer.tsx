import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, PaperclipIcon, XIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { toast } from "@iterate-com/ui/components/sonner";
import { cn } from "@iterate-com/ui/lib/utils";
import { connectItx } from "iterate/sdk/itx/react";
import {
  createAgentWithFirstTurn,
  fileSizeErrorMessage,
  formatFileSize,
  partitionFilesBySize,
} from "~/components/composer-files.ts";

/**
 * Lightweight "start a new thread" composer for the project dashboard.
 * Same attach + size limits + addFiles path as the agent chat composer,
 * plus drag-and-drop onto the pill.
 */
export function NewAgentComposer({
  projectId,
  projectSlug,
  autoFocus = true,
}: {
  projectId: string;
  projectSlug: string;
  autoFocus?: boolean;
}) {
  const navigate = useNavigate();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [error, setError] = useState<string>();
  const [fileError, setFileError] = useState<string>();
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (autoFocus) composerRef.current?.focus();
  }, [autoFocus]);

  const createAgent = useMutation({
    mutationFn: async (input: { content: string; files: File[] }) =>
      createAgentWithFirstTurn({
        projectId,
        connectItx,
        message: input.content,
        files: input.files,
      }),
    onSuccess: (agentPath) => {
      void navigate({
        to: "/projects/$projectSlug/agents/streams/$",
        params: { projectSlug, _splat: agentPath },
        search: {},
      });
    },
    onError: (mutationError) => {
      const text = mutationError instanceof Error ? mutationError.message : String(mutationError);
      setError(text);
      toast.error(text);
    },
  });

  function addSelectedFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    const { accepted, rejected } = partitionFilesBySize(files);
    setFileError(fileSizeErrorMessage(rejected));
    if (accepted.length > 0) {
      setSelectedFiles((previous) => [...previous, ...accepted]);
    }
  }

  function removeSelectedFile(index: number) {
    setSelectedFiles((previous) => previous.filter((_, candidate) => candidate !== index));
    setFileError(undefined);
  }

  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const content = message.trim();
    if ((content === "" && selectedFiles.length === 0) || createAgent.isPending) return;
    setError(undefined);
    createAgent.mutate({ content, files: selectedFiles });
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  function onDragEnter(event: DragEvent<HTMLFormElement>) {
    if (createAgent.isPending || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setIsDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLFormElement>) {
    if (createAgent.isPending || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(event: DragEvent<HTMLFormElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragging(false);
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    if (createAgent.isPending || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setIsDragging(false);
    addSelectedFiles(event.dataTransfer.files);
  }

  const canSubmit = (message.trim() !== "" || selectedFiles.length > 0) && !createAgent.isPending;
  const displayError = [fileError, error].filter(Boolean).join(" · ") || undefined;

  return (
    <form
      onSubmit={submit}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="w-full"
      data-testid="new-agent-composer"
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          addSelectedFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      {displayError == null ? null : (
        <p className="mb-2 ml-4 truncate font-mono text-xs text-destructive" role="alert">
          {displayError}
        </p>
      )}
      <div
        className={cn(
          "flex items-end gap-2 rounded-3xl border bg-background py-2 pl-2 pr-2 shadow-sm transition-shadow",
          isDragging && "ring-2 ring-primary/40 border-primary/40",
        )}
        data-drop-active={isDragging ? "true" : undefined}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          title="Attach files"
          className="rounded-full"
          disabled={createAgent.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          <PaperclipIcon className="size-4.5" />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedFiles.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1">
              {selectedFiles.map((file, index) => (
                <span
                  key={`${file.name}-${file.lastModified}-${index}`}
                  className="inline-flex max-w-52 items-center gap-1.5 rounded-full border bg-muted/50 py-1 pl-2 pr-1 text-xs"
                >
                  <span className="min-w-0 truncate">{file.name}</span>
                  <span className="shrink-0 font-mono text-muted-foreground">
                    {formatFileSize(file.size)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    title={`Remove ${file.name}`}
                    onClick={() => removeSelectedFile(index)}
                    className="size-5 rounded-full text-muted-foreground"
                  >
                    <XIcon className="size-3" />
                  </Button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={composerRef}
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            onKeyDown={onComposerKeyDown}
            rows={1}
            aria-label="Start a new thread"
            placeholder="Message a new agent"
            className="field-sizing-content max-h-32 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-base leading-snug outline-none"
          />
        </div>
        <Button
          size="icon-lg"
          type="submit"
          title="Start thread"
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
      {isDragging ? (
        <p className="mt-2 text-center text-xs text-muted-foreground">Drop files to attach</p>
      ) : null}
    </form>
  );
}
