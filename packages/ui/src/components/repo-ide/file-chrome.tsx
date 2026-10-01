import type { ReactNode } from "react";
import { LockIcon } from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { Tabs, TabsList, TabsTrigger } from "#/components/ui/tabs.tsx";

/** Shared editor-pane chrome: the path header, a status badge and an actions slot. */
export function FileChrome({
  path,
  suffix,
  readonly = false,
  status,
  leading,
  actions,
  children,
}: {
  path: string;
  /** vscode-style pseudo-file name: "(Index)", "(Working Tree)". */
  suffix?: string;
  readonly?: boolean;
  status?: "added" | "deleted" | "modified";
  /** Top-left slot before the path: the Code | Preview toggle lives here. */
  leading?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        {leading}
        <span className="min-w-0 truncate font-mono text-xs">
          {path}
          {suffix ? <span className="text-muted-foreground"> {suffix}</span> : null}
        </span>
        {readonly ? <LockIcon className="size-3 shrink-0 text-muted-foreground" /> : null}
        {status ? (
          <Badge
            variant={status === "deleted" ? "destructive" : "secondary"}
            className="text-[10px]"
          >
            {status}
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-1">{actions}</div>
      </div>
      {children}
    </div>
  );
}

/** The "Code | Preview" tab pair for previewable (markdown, html) files. */
export function CodePreviewToggle({
  preview,
  onChange,
}: {
  preview: boolean;
  onChange: (preview: boolean) => void;
}) {
  return (
    <Tabs
      value={preview ? "preview" : "code"}
      onValueChange={(value) => onChange(value === "preview")}
      className="shrink-0"
    >
      <TabsList className="h-7">
        <TabsTrigger value="code" className="px-2 text-xs">
          Code
        </TabsTrigger>
        <TabsTrigger value="preview" className="px-2 text-xs">
          Preview
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

export function EmptyPane({ label, spinner = false }: { label: string; spinner?: boolean }) {
  return (
    <div
      className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
      {...(spinner ? { "data-spinner": "true" } : {})}
    >
      {label}
    </div>
  );
}

export function ErrorPane({ message }: { message: string }) {
  return (
    <div role="alert" data-type="error" className="p-4 text-sm text-destructive">
      {message}
    </div>
  );
}
