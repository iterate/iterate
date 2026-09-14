import { memo, useState } from "react";
import { CopyIcon } from "lucide-react";
import { sliceText, type StreamText } from "@iterate-com/shared/chunked-text";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@iterate-com/ui/components/sheet";

export function FullTextSnapshot({ text }: { text: StreamText }) {
  const [snapshot, setSnapshot] = useState<string | null>(null);
  return (
    <span className="mb-2 flex flex-wrap items-center gap-2 whitespace-normal font-sans text-xs not-italic text-muted-foreground">
      Latest ~32K characters
      <Sheet
        open={snapshot !== null}
        onOpenChange={(open) => setSnapshot(open ? sliceText(text) : null)}
      >
        <SheetTrigger render={<Button variant="outline" size="xs" />}>View full text</SheetTrigger>
        <SheetContent className="sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>Available response text</SheetTitle>
            <SheetDescription>Captured when opened. Reopen for newer text.</SheetDescription>
          </SheetHeader>
          <Button
            className="mx-4 self-start"
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(snapshot ?? "").then(
                () => toast.success("Copied"),
                () => toast.error("Failed to copy to clipboard"),
              );
            }}
          >
            <CopyIcon data-icon="inline-start" />
            Copy text
          </Button>
          <SnapshotBody text={snapshot} />
        </SheetContent>
      </Sheet>
    </span>
  );
}

const SnapshotBody = memo(function SnapshotBody({ text }: { text: string | null }) {
  return (
    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 pb-4 text-sm">
      {text}
    </pre>
  );
});
