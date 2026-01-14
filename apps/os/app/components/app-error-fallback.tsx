import { Button } from "./ui/button.tsx";

export function AppErrorFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <div className="text-lg font-semibold">Something went wrong</div>
        <div className="text-sm text-muted-foreground">
          An unexpected error occurred. Please try reloading the page.
        </div>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    </div>
  );
}
