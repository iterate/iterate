// The composer: packages/ui's prompt-input primitives (the shadcn ai-elements composer). Enter
// sends, Shift+Enter is a new line; attachments arrive as data URLs, which is what
// `itx.files.put` takes as a string. The state lives in the provider, so the text and attachments
// clear only once `onSend` resolves — a failed send keeps the draft for a retry.
import { useState } from "react";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@iterate-com/ui/components/ai-elements/prompt-input";

/** A file as the agent's `message()` takes it: a data URL for `data`. */
export type OutgoingFile = { contentType: string; filename: string; data: string };

export function Composer({
  onSend,
}: {
  onSend: (message: string, files: OutgoingFile[]) => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <PromptInputProvider>
      <PromptInput
        accept="image/*"
        multiple
        className="mx-auto w-full max-w-3xl"
        onSubmit={async ({ text, files }) => {
          const message = text.trim();
          if (!message && files.length === 0) return;
          setSending(true);
          setError(null);
          try {
            await onSend(
              message || "(see attached)",
              files.map((file) => ({
                contentType: file.mediaType || "application/octet-stream",
                filename: file.filename || "attachment",
                data: file.url,
              })),
            );
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            throw e; // the input keeps its text for a retry
          } finally {
            setSending(false);
          }
        }}
      >
        <PromptInputBody>
          <PromptInputAttachments>
            {(attachment) => <PromptInputAttachment data={attachment} />}
          </PromptInputAttachments>
          <PromptInputTextarea placeholder="Message this agent" />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
          </PromptInputTools>
          {error ? (
            <span className="min-w-0 truncate text-xs text-destructive">{error}</span>
          ) : null}
          <PromptInputSubmit status={sending ? "submitted" : undefined} />
        </PromptInputFooter>
      </PromptInput>
    </PromptInputProvider>
  );
}
