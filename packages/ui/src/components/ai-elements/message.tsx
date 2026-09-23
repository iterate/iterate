"use client";

import { cn } from "@iterate-com/ui/lib/utils";
import type {
  ComponentProps,
  ComponentType,
  HTMLAttributes,
  ReactNode,
} from "react";
import { Suspense, lazy, memo } from "react";
import type { StreamdownProps } from "streamdown";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant" | "system" | "tool";
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

type MarkdownCodeProps = ComponentProps<"code"> & {
  node?: {
    position?: {
      start?: { line?: number };
      end?: { line?: number };
    };
  };
};

function MessageMarkdownPre({ children }: ComponentProps<"pre">) {
  return children;
}

function MessageMarkdownCode({ children, className, node, ...props }: MarkdownCodeProps) {
  const singleLine = node?.position?.start?.line === node?.position?.end?.line;
  if (singleLine) {
    return (
      <code
        className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)}
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <div className="my-4 max-w-full overflow-hidden rounded-xl border bg-muted/30">
      <pre className="max-h-[60vh] overflow-auto p-4 text-sm leading-6">
        <code className={cn("font-mono", className)} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}

function PlainMessageResponse({ children, className }: StreamdownProps) {
  return (
    <div className={cn("size-full whitespace-pre-wrap break-words", className)}>
      {children}
    </div>
  );
}

const RichMessageResponse: ComponentType<StreamdownProps> = import.meta.env.SSR
  ? PlainMessageResponse
  : lazy(async (): Promise<{ default: ComponentType<StreamdownProps> }> => {
      const { Streamdown } = await import("streamdown");
      return { default: Streamdown as ComponentType<StreamdownProps> };
    });

export type MessageResponseProps = StreamdownProps & {
  /** Optional honest loading UI while the client-only Markdown renderer chunk loads. */
  loadingFallback?: ReactNode;
};

export const MessageResponse = memo(
  ({ className, components, loadingFallback, ...props }: MessageResponseProps) => (
    <Suspense
      fallback={loadingFallback ?? <PlainMessageResponse className={className} {...props} />}
    >
      <RichMessageResponse
        className={cn(
          "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className
        )}
        components={{
          code: MessageMarkdownCode,
          pre: MessageMarkdownPre,
          ...components,
        }}
        {...props}
      />
    </Suspense>
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.loadingFallback === nextProps.loadingFallback
);

MessageResponse.displayName = "MessageResponse";
