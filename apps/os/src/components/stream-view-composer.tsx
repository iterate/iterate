import { useState } from "react";
import { parse as parseYaml } from "yaml";
import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { StreamBrowserStore } from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";
import { StreamEventInput } from "~/domains/streams/schemas.ts";
import { AgentPillComposer, type AgentComposerMode } from "~/components/agent-pill-composer.tsx";
import { ExampleEventsPanel } from "~/components/example-events-panel.tsx";

const DEFAULT_RAW_EVENT_YAML =
  "type: events.iterate.com/os/manual-event\npayload:\n  message: Hello from OS\n";

/** How a domain page lets its stream view send chat messages (agents only). */
export type StreamMessageComposer = {
  placeholder?: string;
  onInterrupt?: (llmRequestId: number) => Promise<void>;
  onSubmit: (message: string) => Promise<void>;
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
    if (!trimmed || messageComposer == null) return;
    await runSubmit(async () => {
      await messageComposer.onSubmit(trimmed);
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

  const error = submitError ?? interrupt?.error;

  return (
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
  );
}
