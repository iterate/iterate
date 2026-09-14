import { memo, useLayoutEffect, useRef } from "react";
import { CopyIcon } from "lucide-react";
import { sliceText, textGroupSize, type StreamText } from "@iterate-com/shared/chunked-text";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";
import { cn } from "@iterate-com/ui/lib/utils";
import { FullTextSnapshot } from "./full-text-snapshot.tsx";

/** Sealed groups keep their React subtree; only the small append tail changes. */
export const StreamingText = memo(function StreamingText({
  text,
  animate = false,
}: {
  text: StreamText;
  animate?: boolean;
}) {
  if (typeof text === "string") return text;
  const lastBlock = text.blockCount - 1;
  const lastGroup = Math.floor(lastBlock / textGroupSize);
  // Even unchanged inline nodes share a paragraph's layout. Bound the live
  // formatting context; retain complete text in state and materialize on demand.
  const firstBlock = Math.max(0, text.blockCount - 32);
  return (
    <>
      {firstBlock > 0 ? <FullTextSnapshot text={text} /> : null}
      {Object.entries(text.groups).map(([key, blocks]) =>
        Number(key) < Math.floor(firstBlock / textGroupSize) ? null : (
          <TextGroup
            key={key}
            blocks={blocks}
            firstBlock={Number(key) === Math.floor(firstBlock / textGroupSize) ? firstBlock : 0}
            tailBlock={animate && Number(key) === lastGroup ? lastBlock : null}
            tailOffset={animate && Number(key) === lastGroup ? text.tailOffset : 0}
          />
        ),
      )}
    </>
  );
});

const TextGroup = memo(function TextGroup({
  blocks,
  firstBlock,
  tailBlock,
  tailOffset,
}: {
  blocks: Readonly<Record<string, string>>;
  firstBlock: number;
  tailBlock: number | null;
  tailOffset: number;
}) {
  return Object.entries(blocks).map(([key, text]) =>
    Number(key) < firstBlock ? null : (
      <TextBlock key={key} text={text} revealFrom={Number(key) === tailBlock ? tailOffset : null} />
    ),
  );
});

const TextBlock = memo(function TextBlock({
  text,
  revealFrom,
}: {
  text: string;
  revealFrom: number | null;
}) {
  if (revealFrom === null) return <span>{text}</span>;
  const tail = text.slice(revealFrom);
  const words = [...tail.matchAll(/\S+\s*|\s+/g)];
  // Unusually dense whitespace must not create a span per character. The
  // animation is transient; sealed blocks contain one ordinary text node.
  const tokens = words.length <= 64 ? words : [{ 0: tail, index: 0 }];
  return (
    <span>
      {text.slice(0, revealFrom)}
      {tokens.map((token) => (
        <span
          key={revealFrom + token.index}
          className="animate-token-in motion-reduce:animate-none"
          style={{ animationDelay: `${Math.round((token.index / tail.length) * 140)}ms` }}
        >
          {token[0]}
        </span>
      ))}
    </span>
  );
});

/** Plain text while code is changing; syntax highlighting belongs to settled output. */
export function StreamingCodeBlock({ code, copy = false }: { code: StreamText; copy?: boolean }) {
  const preRef = useRef<HTMLPreElement>(null);
  const pinnedRef = useRef(true);
  useLayoutEffect(() => {
    const element = preRef.current;
    if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [code]);
  return (
    <div className="relative">
      {copy ? (
        <Button
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2 z-10"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard.writeText(sliceText(code)).then(
              () => toast.success("Copied"),
              () => toast.error("Failed to copy to clipboard"),
            );
          }}
        >
          <CopyIcon />
        </Button>
      ) : null}
      <pre
        ref={preRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
        className="max-h-80 overflow-y-auto overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-amber-50 px-4 py-3 font-mono text-xs leading-relaxed text-foreground dark:bg-amber-950/20"
      >
        <StreamingText text={code} />
        <StreamingCursor className="bg-amber-600" />
      </pre>
    </div>
  );
}

export function StreamingCursor({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "ml-px inline-block h-3.5 w-[7px] animate-caret-blink bg-muted-foreground/40 align-[-2px]",
        className,
      )}
    />
  );
}
