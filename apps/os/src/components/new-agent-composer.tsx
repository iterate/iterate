import { useState } from "react";
import {
  flattenAgentRichContent,
  plainAgentRichContent,
  type AgentRichContentV1,
} from "@iterate-com/shared/agent-rich-content";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "@iterate-com/ui/components/sonner";
import { connectItx } from "iterate/sdk/itx/react";
import { AgentPillComposer } from "~/components/agent-pill-composer.tsx";
import { AttachmentChips, AttachmentFileInput } from "~/components/composer-attachments.tsx";
import { useComposerAttachments } from "~/components/use-composer-attachments.ts";
import { configRepoFileMentionProvider } from "~/components/config-repo-file-mentions.tsx";
import { newWebAgentPath, sendAgentFirstTurn } from "~/lib/web-agent.ts";

/**
 * The dashboard's "start a new thread" composer: the shared pill in
 * message-only trim (no raw/examples modes). Same attach limits, chips, and
 * addFiles path as the agent chat composer.
 */
export function NewAgentComposer({
  projectId,
  projectSlug,
}: {
  projectId: string;
  projectSlug: string;
}) {
  const navigate = useNavigate();
  const attachments = useComposerAttachments();
  const fileMentions = configRepoFileMentionProvider(projectId);
  const [message, setMessage] = useState(() => plainAgentRichContent());

  const createAgent = useMutation({
    mutationFn: async (input: {
      content: string;
      files: File[];
      richContent: AgentRichContentV1;
    }) => {
      const agentPath = newWebAgentPath(new Date());
      // connectItx (imperative, not the suspending hook) narrows the one
      // session socket to this project.
      const itx = await connectItx(projectId);
      await sendAgentFirstTurn(itx.agents.get(agentPath), {
        message: input.content,
        files: input.files,
        richContent: input.richContent,
      });
      return agentPath;
    },
    onSuccess: (agentPath) => {
      void navigate({
        to: "/projects/$projectSlug/agents/streams/$",
        params: { projectSlug, _splat: agentPath },
        search: {},
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
  // isSuccess keeps the pill disabled while onSuccess's navigation unmounts
  // this page — isPending alone reopens a double-submit window.
  const busy = createAgent.isPending || createAgent.isSuccess;

  function submit() {
    const content = flattenAgentRichContent(message);
    if (busy || (content.trim() === "" && attachments.files.length === 0)) return;
    createAgent.mutate({ content, files: attachments.files, richContent: message });
  }

  return (
    <div data-testid="new-agent-composer">
      <AttachmentFileInput attachments={attachments} />
      <AgentPillComposer
        mode="message"
        onModeChange={() => {}}
        autoFocusMessage
        isSubmitting={busy}
        {...(attachments.fileError == null ? {} : { error: attachments.fileError })}
        message={{
          value: message,
          onValueChange: setMessage,
          onSubmit: submit,
          canSubmit: flattenAgentRichContent(message).trim() !== "" || attachments.files.length > 0,
          placeholder: "Message a new agent",
          suggestionProviders: [fileMentions],
          onAttach: attachments.openFilePicker,
          onAddFiles: attachments.addFiles,
          ...(attachments.entries.length === 0
            ? {}
            : {
                attachments: (
                  <AttachmentChips
                    entries={attachments.entries}
                    onRemove={attachments.removeFile}
                  />
                ),
              }),
        }}
      />
    </div>
  );
}
