import type { ReactNode } from "react";
import { Button } from "./button.tsx";
import { Spinner } from "./spinner.tsx";

type ErrorFallbackProps = {
  error: unknown;
  reset: () => void;
  secondaryAction?: ReactNode;
};

type NotFoundFallbackProps = {
  action?: ReactNode;
  [key: string]: unknown;
};

export function DefaultPendingComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner className="size-8" />
    </div>
  );
}

export function DefaultNotFoundComponent({ action }: NotFoundFallbackProps = {}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist.
        </p>
      </div>
      {action}
    </div>
  );
}

export function DefaultErrorComponent({ error, reset, secondaryAction }: ErrorFallbackProps) {
  const message = error instanceof Error ? error.message : "An unexpected error occurred";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={reset}>
          Try again
        </Button>
        {secondaryAction}
      </div>
    </div>
  );
}
