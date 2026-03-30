import { useCallback } from "react";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { Terminal } from "@iterate-com/ui/components/terminal";
import { z } from "zod/v4";

const TerminalParams = z.object({
  command: z.string().optional(),
  autorun: z.boolean().optional(),
  ptyId: z.string().optional(),
});

export const Route = createFileRoute("/_app/terminal")({
  staticData: {
    breadcrumb: "Terminal",
  },
  validateSearch: TerminalParams,
  component: TerminalPage,
});

function TerminalPage() {
  const { command, autorun, ptyId } = Route.useSearch();
  const navigate = Route.useNavigate();

  const handleParamsChange = useCallback(
    (params: { ptyId?: string; clearCommand?: boolean }) => {
      navigate({
        search: (prev) => {
          const next = { ...prev };

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
    <div className="flex min-h-0 flex-1 overflow-hidden bg-[#1e1e1e] p-1">
      <ClientOnly fallback={<div className="flex min-h-0 flex-1 bg-[#1e1e1e]" />}>
        <div className="flex min-h-0 flex-1">
          <Terminal
            wsPath="/api/pty"
            initialCommand={{ command, autorun }}
            ptyId={ptyId}
            onParamsChange={handleParamsChange}
          />
        </div>
      </ClientOnly>
    </div>
  );
}
