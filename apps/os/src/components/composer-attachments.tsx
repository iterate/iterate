import { XIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { formatFileSize } from "~/lib/feed-format.ts";
import type {
  AttachmentEntry,
  ComposerAttachments,
} from "~/components/use-composer-attachments.ts";

/** The hidden `<input type="file">` behind `ComposerAttachments.openFilePicker`. */
export function AttachmentFileInput({ attachments }: { attachments: ComposerAttachments }) {
  return (
    <input
      ref={attachments.inputRef}
      type="file"
      multiple
      className="hidden"
      onChange={(event) => {
        attachments.addFiles(event.currentTarget.files);
        event.currentTarget.value = "";
      }}
    />
  );
}

/** Selected-file chips for a composer's attachments slot. */
export function AttachmentChips({
  entries,
  onRemove,
}: {
  entries: readonly AttachmentEntry[];
  onRemove: (id: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {entries.map(({ id, file }) => (
        <span
          key={id}
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
            onClick={() => onRemove(id)}
            className="size-5 rounded-full text-muted-foreground"
          >
            <XIcon className="size-3" />
          </Button>
        </span>
      ))}
    </div>
  );
}
