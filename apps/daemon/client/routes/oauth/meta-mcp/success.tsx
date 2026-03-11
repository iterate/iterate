import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2Icon, CircleAlertIcon } from "lucide-react";
import { z } from "zod/v4";
import { Button } from "@/components/ui/button.tsx";

const MetaMcpOAuthSuccessSearch = z.object({
  status: z.enum(["success", "error"]).catch("success"),
  serverId: z.string().optional(),
  message: z.string().optional(),
});

export const Route = createFileRoute("/oauth/meta-mcp/success")({
  validateSearch: MetaMcpOAuthSuccessSearch,
  component: MetaMcpOAuthSuccessPage,
});

function MetaMcpOAuthSuccessPage() {
  const { status, serverId, message } = Route.useSearch();
  const isSuccess = status === "success";

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(196,138,56,0.14),_transparent_38%),linear-gradient(180deg,_#fbf7ef_0%,_#f1e7d7_100%)] p-4">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md items-center justify-center">
        <div className="w-full rounded-[28px] border border-black/10 bg-white/85 p-6 shadow-[0_24px_80px_rgba(63,41,13,0.12)] backdrop-blur">
          <div className="mb-4 flex items-center gap-3 text-sm font-medium text-[#81552a]">
            {isSuccess ? (
              <CheckCircle2Icon className="size-5 text-[#2f855a]" />
            ) : (
              <CircleAlertIcon className="size-5 text-[#c53030]" />
            )}
            <span>Meta MCP</span>
          </div>

          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#9b6a3d]">
              OAuth
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-[#23180f]">
              {isSuccess ? "Authorization complete." : "Authorization failed."}
            </h1>
            <p className="text-sm leading-6 text-[#5b4531]">
              {message ??
                (isSuccess
                  ? "Meta MCP saved the OAuth connection. You can close this tab and continue in the daemon."
                  : "Meta MCP could not complete the OAuth flow. Start the authorization flow again.")}
            </p>
            {serverId ? (
              <div className="rounded-2xl border border-black/10 bg-[#f7f1e7] px-4 py-3 text-sm text-[#5b4531]">
                Connected server: <span className="font-medium text-[#23180f]">{serverId}</span>
              </div>
            ) : null}
          </div>

          <div className="mt-6 flex gap-3">
            <Button asChild className="flex-1">
              <Link to="/">Back to daemon</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
