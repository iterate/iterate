import { useState } from "react";
import { parse as parseYaml } from "yaml";
import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { StreamEventInput, type StreamEvent } from "iterate/processors";
import type { StreamBrowserStore } from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";
import { AgentPillComposer, type AgentComposerMode } from "~/components/agent-pill-composer.tsx";
import { AttachmentChips, AttachmentFileInput } from "~/components/composer-attachments.tsx";
import { useComposerAttachments } from "~/components/use-composer-attachments.ts";
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
  disabled,
  interrupt,
  messageComposer,
  onNudgeDeliveries,
  presence,
  store,
}: {
  autoFocusMessage: boolean;
  defaultMode?: "message" | "raw";
  disabled: boolean;
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
  const attachments = useComposerAttachments();
  const [rawText, setRawText] = useState(DEFAULT_RAW_EVENT_YAML);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

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
    if (!messageComposer) return;
    const { onSubmit, onSubmitFiles } = messageComposer;
    // Time the whole submit: this is the real consume-own-append t0, and the
    // committed offset the handler returns is what closes the loop when this
    // tab's own subscription ingests past it.
    const measured = async (submit: () => Promise<StreamEvent>) => {
      const t0 = Date.now();
      const committed = await submit();
      store.noteExternalAppend({ maxCommittedOffset: committed.offset, t0 });
    };
    if (attachments.files.length && onSubmitFiles) {
      await runSubmit(async () => {
        await measured(() => onSubmitFiles({ files: attachments.files, message: trimmed }));
        setMessageText("");
        attachments.clearFiles();
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
  const error =
    [attachments.fileError, submitError, interrupt?.error].filter(Boolean).join(" · ") || undefined;
  const attachmentChips =
    attachments.entries.length === 0 ? undefined : (
      <AttachmentChips entries={attachments.entries} onRemove={attachments.removeFile} />
    );

  return (
    <>
      {!messageComposer?.onSubmitFiles ? null : <AttachmentFileInput attachments={attachments} />}
      <AgentPillComposer
        mode={mode}
        onModeChange={setMode}
        autoFocusMessage={autoFocusMessage}
        examples={<ExampleEventsPanel presence={presence} onLoadExample={loadRawExample} />}
        {...(!messageComposer
          ? {}
          : {
              message: {
                value: messageText,
                onValueChange: setMessageText,
                onSubmit: submitMessage,
                canSubmit:
                  messageText.trim() !== "" ||
                  (!!attachments.files.length && !!messageComposer.onSubmitFiles),
                ...(!attachmentChips ? {} : { attachments: attachmentChips }),
                ...(!messageComposer.onSubmitFiles
                  ? {}
                  : {
                      onAttach: attachments.openFilePicker,
                      onAddFiles: attachments.addFiles,
                    }),
                ...(!messageComposer.placeholder
                  ? {}
                  : { placeholder: messageComposer.placeholder }),
              },
              ...(!interrupt
                ? {}
                : { onInterrupt: interrupt.run, isInterrupting: interrupt.isInterrupting }),
            })}
        raw={{
          value: rawText,
          onValueChange: setRawText,
          onSubmit: submitRawEvents,
        }}
        isSubmitting={isSubmitting}
        disabled={disabled}
        {...(!error ? {} : { error })}
      />
    </>
  );
}
