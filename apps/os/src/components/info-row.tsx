import { Copy } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";

/**
 * One label/value line of a domain object's description card (secret detail,
 * repo detail). Pass `copyValue` to append a copy-to-clipboard button.
 */
export function InfoRow(input: { copyValue?: string; label: string; value: string }) {
  return (
    <div className="grid gap-2 border-b p-4 last:border-b-0 md:grid-cols-[10rem_minmax(0,1fr)_auto] md:items-center">
      <div className="text-xs font-medium text-muted-foreground">{input.label}</div>
      <code className="min-w-0 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
        {input.value}
      </code>
      {input.copyValue ? <CopyButton value={input.copyValue} /> : <div />}
    </div>
  );
}

function CopyButton(input: { value: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="h-8 w-8 shrink-0"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(input.value).then(
          () => toast.success("Copied"),
          () => toast.error("Could not copy"),
        );
      }}
    >
      <Copy className="h-4 w-4" />
    </Button>
  );
}
