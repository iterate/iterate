import { useRef, useState } from "react";
import { parse as parseYaml } from "yaml";
import { XIcon } from "lucide-react";
import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { Button } from "@iterate-com/ui/components/button";
import { StreamEventInput, type StreamEvent } from "iterate/processors";
import type { StreamBrowserStore } from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";
import { AgentPillComposer, type AgentComposerMode } from "~/components/agent-pill-composer.tsx";
import {
  fileSizeErrorMessage,
  formatFileSize,
  partitionFilesBySize,
} from "~/components/composer-files.ts";
import { ExampleEventsPanel } from "~/components/example-events-panel.tsx";

const DEFAULT_RAW_EVENT_YAML =
  "type: events.iterate.com/os/manual-event\npayload:\n  message: Hello from OS\n";

/**
 * How a domain page lets its stream view send chat messages (agents only).
 * Submit handlers return the committed event: the composer feeds its offset
 * into the store's consume-own-append metric (real append→observed latency),
 * and requiring the return means a handler cannot silently opt the metric
 * out by forgetting it.
 */
export type StreamMessageComposer = {
  placeholder?: string;
  onInterrupt?: (llmRequestOffset: number) => Promise<void>;
  onSubmit: (message: string) => Promise<StreamEvent>;
  onSubmitFiles?: (input: { files: File[]; message: string }) => Promise<StreamEvent>;
};

/**
 * An in-flight agent turn's interrupt affordance, owned by the view (the
 * agent feed shows the same interrupt on queued messages). `error` surfaces
 * in the composer's error slot alongside submit failures.
 */
export type StreamInterrupt = {
  run: () => Promise<void>;
  isInterrupting: boolean;
  error?: string;
};

/**
 * The stream view's input surface: the message/raw-YAML pill composer plus
 * the example-events picker. Owns all composer state (mode, drafts, submit
 * error) — the view only supplies the store to append to and, for agent
 * streams, the chat/interrupt wiring.
 */
export function StreamViewComposer({
  autoFocusMessage,
  defaultMode,
  interrupt,
  messageComposer,
  onNudgeDeliveries,
  presence,
  store,
}: {
  autoFocusMessage: boolean;
  defaultMode?: "message" | "raw";
  /** Null while no turn is running (or the stream has no interrupt hook). */
  interrupt: StreamInterrupt | null;
  messageComposer?: StreamMessageComposer;
  /**
   * Called right after this component appends: the server is about to push,
   * so the view verifies deliveries arrive and reconnects dead subscriptions.
   */
  onNudgeDeliveries: () => void;
  presence: readonly AgentUiPresenceEntry[];
  store: StreamBrowserStore;
}) {
  const [mode, setMode] = useState<AgentComposerMode>(
    defaultMode ?? (messageComposer ? "message" : "raw"),
  );
  const [messageText, setMessageText] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [rawText, setRawText] = useState(DEFAULT_RAW_EVENT_YAML);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [fileError, setFileError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function runSubmit(action: () => Promise<void>) {
    setIsSubmitting(true);
    setSubmitError(undefined);
    try {
      await action();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitMessage() {
    const trimmed = messageText.trim();
    if (messageComposer == null) return;
    const { onSubmit, onSubmitFiles } = messageComposer;
    // Time the whole submit: this is the real consume-own-append t0, and the
    // committed offset the handler returns is what closes the loop when this
    // tab's own subscription ingests past it.
    const measured = async (submit: () => Promise<StreamEvent>) => {
      const t0 = Date.now();
      const committed = await submit();
      store.noteExternalAppend({ maxCommittedOffset: committed.offset, t0 });
    };
    if (selectedFiles.length > 0 && onSubmitFiles != null) {
      await runSubmit(async () => {
        await measured(() => onSubmitFiles({ files: selectedFiles, message: trimmed }));
        setMessageText("");
        setSelectedFiles([]);
        setFileError(undefined);
        onNudgeDeliveries();
      });
      return;
    }
    if (!trimmed) return;
    await runSubmit(async () => {
      await measured(() => onSubmit(trimmed));
      setMessageText("");
      onNudgeDeliveries();
    });
  }

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

  async function submitRawEvents() {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    await runSubmit(async () => {
      const parsed = parseYaml(trimmed) as unknown;
      const events = (Array.isArray(parsed) ? parsed : [parsed]).map((event) =>
        StreamEventInput.parse(event),
      );
      await store.appendBatch({ events });
      onNudgeDeliveries();
    });
  }

  // Picking an example drops the user into the raw editor with the YAML loaded.
  function loadRawExample(yaml: string) {
    setRawText(yaml);
    setMode("raw");
  }

  // File validation, submit, and interrupt failures have independent
  // lifecycles, so none may mask the others — show all active messages.
  const error = [fileError, submitError, interrupt?.error].filter(Boolean).join(" · ") || undefined;
  const attachmentChips =
    selectedFiles.length === 0 ? undefined : (
      <div className="flex flex-wrap items-center gap-1.5">
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
    );

  return (
    <>
      {messageComposer?.onSubmitFiles == null ? null : (
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
      )}
      <AgentPillComposer
        mode={mode}
        onModeChange={setMode}
        autoFocusMessage={autoFocusMessage}
        examples={<ExampleEventsPanel presence={presence} onLoadExample={loadRawExample} />}
        {...(messageComposer == null
          ? {}
          : {
              message: {
                value: messageText,
                onValueChange: setMessageText,
                onSubmit: submitMessage,
                canSubmit:
                  messageText.trim() !== "" ||
                  (selectedFiles.length > 0 && messageComposer.onSubmitFiles != null),
                ...(attachmentChips == null ? {} : { attachments: attachmentChips }),
                ...(messageComposer.onSubmitFiles == null
                  ? {}
                  : {
                      onAttach: () => fileInputRef.current?.click(),
                      onAddFiles: addSelectedFiles,
                    }),
                ...(messageComposer.placeholder == null
                  ? {}
                  : { placeholder: messageComposer.placeholder }),
              },
              ...(interrupt == null
                ? {}
                : { onInterrupt: interrupt.run, isInterrupting: interrupt.isInterrupting }),
            })}
        raw={{
          value: rawText,
          onValueChange: setRawText,
          onSubmit: submitRawEvents,
        }}
        isSubmitting={isSubmitting}
        {...(error == null ? {} : { error })}
      />
    </>
  );
}
