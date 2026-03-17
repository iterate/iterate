import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import confetti from "canvas-confetti";
import { useQuery } from "@tanstack/react-query";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { z } from "zod/v4";
import { Button } from "@iterate-com/ui/components/button";
import { Badge } from "@iterate-com/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Terminal } from "@iterate-com/ui/components/terminal";
import { orpc } from "@/frontend/lib/orpc.ts";

const TerminalParams = z.object({
  command: z.string().optional(),
  autorun: z.boolean().optional(),
  ptyId: z.string().optional(),
});

export const Route = createFileRoute("/")({
  validateSearch: TerminalParams,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(orpc.ping.queryOptions({ input: {} })),
  component: IndexPage,
});

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

function ConfettiDemo() {
  const [status, setStatus] = useState("connecting");
  const socketRef = useRef<WebSocket | null>(null);

  const wsUrl = useMemo(() => {
    const origin = new URL(window.location.origin);
    origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
    origin.pathname = "/api/confetti/ws";
    return origin.toString();
  }, []);

  useEffect(() => {
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setStatus("connected");
    });
    socket.addEventListener("close", () => {
      setStatus("disconnected");
    });
    socket.addEventListener("error", () => {
      setStatus("error");
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as
        | { type: "boom"; x: number; y: number }
        | { type: "error"; message: string };

      if (message.type === "boom") {
        confetti({
          particleCount: 150,
          spread: 70,
          origin: {
            x: message.x,
            y: message.y,
          },
        });
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [wsUrl]);

  const launchConfetti = useCallback((event: MouseEvent<HTMLButtonElement | HTMLDivElement>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const x = event.clientX / window.innerWidth;
    const y = event.clientY / window.innerHeight;
    socket.send(
      JSON.stringify({
        type: "launch",
        x,
        y,
      }),
    );
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>WebSocket confetti</CardTitle>
            <CardDescription>
              Click the launch area and the server will stream a confetti burst back over{" "}
              <code>/api/confetti/ws</code>.
            </CardDescription>
          </div>
          <Badge variant="secondary">{status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          onClick={launchConfetti}
          className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground"
        >
          Click anywhere in this panel to ask the server for a burst.
        </div>
        <Button className="w-full" onClick={launchConfetti}>
          Launch confetti
        </Button>
        <p className="text-xs text-muted-foreground">
          Random bursts also arrive every ~1.3 seconds while the socket is connected.
        </p>
      </CardContent>
    </Card>
  );
}

function IndexPage() {
  const { command, autorun, ptyId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data, isPending, error } = useQuery(orpc.ping.queryOptions({ input: {} }));
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
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-3 lg:grid lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="flex w-full flex-col gap-3">
          <Card>
            <CardHeader className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle>ws-test terminal</CardTitle>
                <Badge variant="secondary">pty</Badge>
              </div>
              <CardDescription>
                TanStack Start SPA shell in front, Hono backend behind <code>/api</code>, and a PTY
                websocket at <code>/api/pty/ws</code>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1">
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
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>oRPC health</CardTitle>
              <CardDescription>
                HTTP procedure wired through <code>GET /api/ping</code> and mirrored on{" "}
                <code>/api/orpc/ws</code>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {isPending ? <p>Loading...</p> : null}
              {error ? <p className="text-destructive">{String(error)}</p> : null}
              {data ? (
                <>
                  <p>
                    <span className="font-medium">Message:</span> {data.message}
                  </p>
                  <p>
                    <span className="font-medium">Server time:</span> {data.serverTime}
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

          <ClientOnly>
            <ConfettiDemo />
          </ClientOnly>
        </div>

        <Card className="min-h-0 min-w-0 flex-1 overflow-hidden border-0 bg-transparent shadow-none lg:p-0">
          <ClientOnly fallback={<div className="h-full w-full rounded-xl border bg-[#1e1e1e]" />}>
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
