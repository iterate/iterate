import { useState } from "react";
import { parse as parseYaml } from "yaml";
import {
  agentMessageToEditorDocument,
  emptyAgentMessageDraft,
  type AgentMessageAttachment,
} from "@iterate-com/shared/agent-message-attachments";
import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { StreamEventInput, type StreamEvent } from "iterate/processors";
import type { StreamBrowserStore } from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";
import { AgentPillComposer, type AgentComposerMode } from "~/components/agent-pill-composer.tsx";
import { AttachmentChips, AttachmentFileInput } from "~/components/composer-attachments.tsx";
import { useComposerAttachments } from "~/components/use-composer-attachments.ts";
import { ExampleEventsPanel } from "~/components/example-events-panel.tsx";
import type { ComposerSuggestionProvider } from "~/components/composer-suggestions.ts";

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
  suggestionProviders?: readonly ComposerSuggestionProvider[];
  onInterrupt?: (llmRequestOffset: number) => Promise<void>;
  onSubmit: (input: {
    content: string;
    attachments: AgentMessageAttachment[];
  }) => Promise<StreamEvent>;
  onSubmitFiles?: (input: {
    files: File[];
    content: string;
    attachments: AgentMessageAttachment[];
  }) => Promise<StreamEvent>;
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
  const [message, setMessage] = useState(() => emptyAgentMessageDraft());
  const attachments = useComposerAttachments();
  const [rawText, setRawText] = useState(DEFAULT_RAW_EVENT_YAML);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function runSubmit(action: () => Promise<void>): Promise<boolean> {
    setIsSubmitting(true);
    setSubmitError(undefined);
    try {
      await action();
      return true;
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitMessage() {
    const visibleText = agentMessageToEditorDocument(message).text;
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
    if (attachments.files.length > 0 && onSubmitFiles != null) {
      const didSubmit = await runSubmit(() =>
        measured(() => onSubmitFiles({ files: attachments.files, ...message })),
      );
      if (didSubmit) {
        setMessage(emptyAgentMessageDraft());
        attachments.clearFiles();
        onNudgeDeliveries();
      }
      return;
    }
    if (visibleText.trim() === "") return;
    const didSubmit = await runSubmit(() => measured(() => onSubmit(message)));
    if (didSubmit) {
      setMessage(emptyAgentMessageDraft());
      onNudgeDeliveries();
    }
  }

  async function submitRawEvents() {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    const didSubmit = await runSubmit(async () => {
      const parsed = parseYaml(trimmed) as unknown;
      const events = (Array.isArray(parsed) ? parsed : [parsed]).map((event) =>
        StreamEventInput.parse(event),
      );
      await store.appendBatch({ events });
    });
    if (didSubmit) {
      onNudgeDeliveries();
    }
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
      {messageComposer?.onSubmitFiles == null ? null : (
        <AttachmentFileInput attachments={attachments} />
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
                value: message,
                onValueChange: setMessage,
                onSubmit: submitMessage,
                canSubmit:
                  agentMessageToEditorDocument(message).text.trim() !== "" ||
                  (attachments.files.length > 0 && messageComposer.onSubmitFiles != null),
                ...(attachmentChips == null ? {} : { attachments: attachmentChips }),
                ...(messageComposer.onSubmitFiles == null
                  ? {}
                  : {
                      onAttach: attachments.openFilePicker,
                      onAddFiles: attachments.addFiles,
                    }),
                ...(messageComposer.placeholder == null
                  ? {}
                  : { placeholder: messageComposer.placeholder }),
                ...(messageComposer.suggestionProviders == null
                  ? {}
                  : { suggestionProviders: messageComposer.suggestionProviders }),
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
        disabled={disabled}
        {...(error == null ? {} : { error })}
      />
    </>
  );
}
