import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils.ts";

interface TypeIdProps {
  id: string;
  /** Number of characters to show at start (default: 8) */
  startChars?: number;
  /** Number of characters to show at end (default: 4) */
  endChars?: number;
  className?: string;
}

export function TypeId({ id, startChars = 8, endChars = 4, className }: TypeIdProps) {
  const [copied, setCopied] = useState(false);

  const needsTruncation = id.length > startChars + endChars + 3;
  const displayText = needsTruncation ? `${id.slice(0, startChars)}…${id.slice(-endChars)}` : id;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={id}
      className={cn(
        "inline-flex items-center gap-1 font-mono text-xs text-muted-foreground",
        "hover:text-foreground transition-colors cursor-pointer",
        className,
      )}
    >
      <span>{displayText}</span>
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3 opacity-50" />}
    </button>
  );
}
