import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { useState } from "react";
import {
  ShikiHighlighter as _ShikiHighlighter,
  createHighlighterCore,
  createJavaScriptRegexEngine,
} from "react-shiki/core";
import { cn } from "../../lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { useTheme } from "next-themes";

export type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  children?: ReactNode;
};

let ShikiHighlighter: React.ComponentType<ComponentProps<typeof _ShikiHighlighter>>;
if (import.meta.env.SSR) {
  ShikiHighlighter = ({ children, className }: ComponentProps<typeof _ShikiHighlighter>) => (
    <div className={cn("overflow-hidden", className)}>{children}</div>
  );
} else {
  const highlighter = await createHighlighterCore({
    themes: [
      await import("@shikijs/themes/one-dark-pro"),
      await import("@shikijs/themes/one-light"),
    ],
    // We are only using JSON for now
    langs: [await import("@shikijs/langs/json")],
    engine: createJavaScriptRegexEngine(),
  });

  ShikiHighlighter = (props: ComponentProps<typeof _ShikiHighlighter>) => (
    <_ShikiHighlighter highlighter={highlighter} {...props} />
  );
}

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const { resolvedTheme } = useTheme();
  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-md border bg-background text-foreground",
        className,
      )}
      {...props}
    >
      <div className="relative">
        <ShikiHighlighter
          theme={resolvedTheme === "dark" ? "one-dark-pro" : "one-light"}
          className="overflow-hidden"
          language={language}
          showLineNumbers={showLineNumbers}
        >
          {code}
        </ShikiHighlighter>
        {children && (
          <div className="absolute top-2 right-2 flex items-center gap-2">{children}</div>
        )}
      </div>
    </div>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
  code: string;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  code,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);

  const copyToClipboard = async () => {
    if (typeof window === "undefined" || !navigator.clipboard.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      onCopy?.();
      setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};
