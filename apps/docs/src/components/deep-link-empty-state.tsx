import { FileTextIcon } from "lucide-react";

export function DeepLinkEmptyState() {
  return (
    <main className="grid min-h-svh place-items-center bg-muted/20 px-6">
      <div className="w-full max-w-lg rounded-2xl border bg-background p-8 shadow-sm">
        <div className="mb-5 flex size-10 items-center justify-center rounded-xl bg-foreground text-background">
          <FileTextIcon aria-hidden className="size-5" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Open a workspace document</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Docs has no file browser. Its links point directly at one existing Markdown or HTML file
          in one existing workspace.
        </p>
        <div className="mt-5 rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
          ?workspace=/workspaces/agents/reviewer
          <br />
          &amp;path=review.md
        </div>
      </div>
    </main>
  );
}
