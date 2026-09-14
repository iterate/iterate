import { Button } from "@iterate-com/ui/components/button";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";

export function DocumentError({
  workspacePath,
  path,
  message,
  onRetry,
}: {
  workspacePath: string;
  path: string;
  message: string;
  /** Load the document again without leaving the page. */
  onRetry?: () => void;
}) {
  return (
    <div className="relative grid min-h-svh place-items-center bg-muted/20 px-6">
      <SidebarTrigger className="absolute top-3 left-3 md:hidden" />
      <div className="w-full max-w-xl rounded-2xl border bg-background p-8 shadow-sm">
        <p className="text-xs font-medium tracking-wide text-destructive uppercase">
          Could not open document
        </p>
        <h1 className="mt-2 break-all font-mono text-sm">{path}</h1>
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{workspacePath}</p>
        <p className="mt-5 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">{message}</p>
        {onRetry === undefined ? null : (
          <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
