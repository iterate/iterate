import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { Button } from "@iterate-com/ui/components/button";
import { useAuthClient } from "~/auth/client-context.ts";
import { liftLocalProxies } from "~/capnweb/local-proxy-wrapper.js";
import type { IterateContext } from "~/capnweb/iterate-context-capability.ts";

export const Route = createFileRoute("/_app/capnweb-repl")({
  staticData: {
    breadcrumb: "Capnweb REPL",
  },
  component: CapnwebReplPage,
});

function CapnwebReplPage() {
  const { session } = useAuthClient();
  const [code, setCode] = useState("await ctx.projects.list({ limit: 5 })");
  const [ctx, setCtx] = useState<RpcStub<IterateContext> | null>(null);
  const [status, setStatus] = useState("Connecting...");
  const [output, setOutput] = useState("");

  useEffect(() => {
    const wsUrl = new URL("/api/captnweb", window.location.href);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(wsUrl);
    const rpc = newWebSocketRpcSession<IterateContext>(socket);
    const lifted = liftLocalProxies(rpc) as RpcStub<IterateContext>;
    const globals = globalThis as typeof globalThis & {
      ctx?: RpcStub<IterateContext>;
      env?: object;
    };
    globals.ctx = lifted;
    globals.env = {};
    setCtx(lifted);
    setStatus("Connected");
    return () => {
      delete globals.ctx;
      delete globals.env;
      rpc[Symbol.dispose]?.();
      socket.close();
    };
  }, []);

  async function run() {
    if (!ctx) return;
    setStatus("Running...");
    try {
      const result = await evalInBrowser({ code, ctx });
      setOutput(formatResult(result));
      setStatus("Connected");
    } catch (error) {
      setOutput(error instanceof Error ? (error.stack ?? error.message) : String(error));
      setStatus("Connected");
    }
  }

  const scopes =
    session?.authenticated === true
      ? {
          organizations: session.session.organizations.map(({ id, role, slug }) => ({
            id,
            role,
            slug,
          })),
          projects: session.session.projects.map(({ id, organizationId, slug }) => ({
            id,
            organizationId,
            slug,
          })),
        }
      : null;

  return (
    <main className="flex h-full min-h-0 flex-col gap-4 p-4">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">Capnweb REPL</h1>
          <span className="text-sm text-muted-foreground">{status}</span>
        </div>
        <pre className="max-h-44 overflow-auto rounded-md border bg-muted p-3 text-xs">
          {JSON.stringify(scopes, null, 2)}
        </pre>
      </section>

      <section className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-2">
          <textarea
            className="min-h-72 flex-1 resize-none rounded-md border bg-background p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button className="self-start" disabled={!ctx || status === "Running..."} onClick={run}>
            Run
          </Button>
        </div>
        <pre className="min-h-72 overflow-auto rounded-md border bg-muted p-3 text-sm">
          {output || "Result appears here."}
        </pre>
      </section>
    </main>
  );
}

async function evalInBrowser(input: { code: string; ctx: RpcStub<IterateContext> }) {
  const env = {};
  return await compileBrowserReplFunction(input.code)(input.ctx, env);
}

function compileBrowserReplFunction(code: string) {
  try {
    // oxlint-disable-next-line no-new-func -- This page is explicitly a browser-local REPL.
    return new Function("ctx", "env", `return (async () => (${code}))()`) as ReplFunction;
  } catch {
    // oxlint-disable-next-line no-new-func -- Statement-mode fallback for the browser-local REPL.
    return new Function("ctx", "env", `return (async () => {${code}})()`) as ReplFunction;
  }
}

type ReplFunction = (ctx: RpcStub<IterateContext>, env: object) => Promise<unknown>;

function formatResult(result: unknown) {
  if (result === undefined) return "undefined";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
