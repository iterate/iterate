import { useState } from "react";
import { AlertCircleIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import type { ErrorFeedItem } from "@/reducers/messages-reducer.ts";

export function HarnessErrorAlert({ error }: { error: ErrorFeedItem }) {
  const [expanded, setExpanded] = useState(false);
  const timeStr = new Date(error.timestamp).toLocaleTimeString();

  return (
    <Alert variant="destructive" className="my-2 bg-destructive/10 border-destructive/50">
      <AlertCircleIcon />
      <AlertTitle className="flex items-center gap-2">
        <span>Pi Harness Error</span>
        {error.context && (
          <span className="font-mono text-xs bg-destructive/20 px-1.5 py-0.5 rounded">
            {error.context}
          </span>
        )}
        <span className="ml-auto text-xs font-normal opacity-70">{timeStr}</span>
      </AlertTitle>
      <AlertDescription>
        <p className="font-medium">{error.message}</p>
        {error.stack && (
          <div className="mt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-auto p-0 text-xs text-destructive/80 hover:text-destructive"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <ChevronDownIcon className="size-3 mr-1" />
              ) : (
                <ChevronRightIcon className="size-3 mr-1" />
              )}
              Stack trace
            </Button>
            {expanded && (
              <pre className="mt-2 text-xs font-mono bg-destructive/10 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                {error.stack}
              </pre>
            )}
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
