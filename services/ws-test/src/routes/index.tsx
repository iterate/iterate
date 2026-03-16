import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { z } from "zod/v4";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Terminal } from "@iterate-com/ui/components/terminal";
import { orpc } from "@/lib/orpc.ts";

const TerminalParams = z.object({
  command: z.string().optional(),
  autorun: z.boolean().optional(),
  ptyId: z.string().optional(),
});

export const Route = createFileRoute("/")({
  validateSearch: TerminalParams,
  component: IndexPage,
});

function readPingResult(data: unknown) {
  if (!data || typeof data !== "object") {
    return null;
  }

  if ("json" in data && data.json && typeof data.json === "object") {
    const payload = data.json as { message?: unknown; serverTime?: unknown };
    if (typeof payload.message === "string" && typeof payload.serverTime === "string") {
      return {
        message: payload.message,
        serverTime: payload.serverTime,
      };
    }
  }

  const payload = data as { message?: unknown; serverTime?: unknown };
  if (typeof payload.message === "string" && typeof payload.serverTime === "string") {
    return {
      message: payload.message,
      serverTime: payload.serverTime,
    };
  }

  return null;
}

function useVisualViewportHeight() {
  const [height, setHeight] = useState("100dvh");

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = () => setHeight(`${viewport.height}px`);
    update();

    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);

    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  return height;
}

function IndexPage() {
  const { command, autorun, ptyId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data, isPending, error } = useQuery(orpc.ping.queryOptions({ input: {} }));
  const ping = readPingResult(data);
  const height = useVisualViewportHeight();

  const handleParamsChange = useCallback(
    (params: { ptyId?: string; clearCommand?: boolean }) => {
      navigate({
        search: (previous) => {
          const next = { ...previous };
          if (params.ptyId) next.ptyId = params.ptyId;
          if (params.clearCommand) {
            delete next.command;
            delete next.autorun;
          }
          return next;
        },
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <div
      className="bg-background"
      style={{
        height,
        paddingTop: "max(8px, env(safe-area-inset-top))",
        paddingLeft: "max(8px, env(safe-area-inset-left))",
        paddingRight: "max(8px, env(safe-area-inset-right))",
        paddingBottom: "max(8px, env(safe-area-inset-bottom))",
      }}
    >
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-3 md:flex-row">
        <div className="flex w-full flex-col gap-3 md:max-w-sm">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle>ws-test terminal</CardTitle>
                  <CardDescription>
                    TanStack Start SPA with Hono backend fallthrough and a PTY websocket at{" "}
                    <code>/api/pty/ws</code>.
                  </CardDescription>
                </div>
                <Badge variant="secondary">pty</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                className="w-full"
                onClick={() =>
                  navigate({
                    search: {
                      command: "printf 'hello from ws-test'",
                      autorun: true,
                      ptyId,
                    },
                    replace: true,
                  })
                }
              >
                Run hello
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() =>
                  navigate({
                    search: {
                      command: "pwd",
                      autorun: true,
                      ptyId,
                    },
                    replace: true,
                  })
                }
              >
                Run pwd
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() =>
                  navigate({
                    search: {
                      command: "ls",
                      autorun: true,
                      ptyId,
                    },
                    replace: true,
                  })
                }
              >
                Run ls
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>oRPC health</CardTitle>
              <CardDescription>
                HTTP procedure wired through <code>GET /api/rpc/ping</code>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {isPending ? <p>Loading...</p> : null}
              {error ? <p className="text-destructive">{String(error)}</p> : null}
              {ping ? (
                <>
                  <p>
                    <span className="font-medium">Message:</span> {ping.message}
                  </p>
                  <p>
                    <span className="font-medium">Server time:</span> {ping.serverTime}
                  </p>
                </>
              ) : null}
              <p>
                <span className="font-medium">Session:</span> {ptyId ?? "new shell"}
              </p>
              <p>
                <span className="font-medium">Initial command:</span> {command ?? "none"}
              </p>
              <p>
                <span className="font-medium">Autorun:</span> {autorun ? "true" : "false"}
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className="min-h-0 min-w-0 flex-1 overflow-hidden p-1">
          <ClientOnly fallback={<div className="h-full w-full rounded-md bg-[#1e1e1e]" />}>
            <Terminal
              initialCommand={{ command, autorun }}
              ptyId={ptyId}
              onParamsChange={handleParamsChange}
            />
          </ClientOnly>
        </Card>
      </div>
    </div>
  );
}
