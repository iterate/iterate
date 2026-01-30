import { cn } from "@/lib/utils.ts";

type SerializedObjectCodeBlockProps = {
  data: unknown;
  className?: string;
};

export function SerializedObjectCodeBlock({ data, className }: SerializedObjectCodeBlockProps) {
  let serialized = "";
  try {
    serialized =
      data === undefined ? "undefined" : (JSON.stringify(data, null, 2) ?? String(data ?? ""));
  } catch {
    serialized = String(data ?? "");
  }

  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-lg border bg-background p-3 text-xs leading-relaxed",
        className,
      )}
    >
      <code>{serialized}</code>
    </pre>
  );
}
