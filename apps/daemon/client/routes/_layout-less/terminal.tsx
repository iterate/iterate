import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod/v4";
import { useCallback } from "react";
import { XtermTerminal } from "@/components/xterm-terminal.tsx";

const TerminalParams = z.object({
  command: z.string().optional(),
  autorun: z.boolean().optional(),
  ptyId: z.string().optional(),
});

export const Route = createFileRoute("/_layout-less/terminal")({
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
    <div className="h-screen w-screen overflow-hidden p-4">
      <XtermTerminal
        initialCommand={{ command, autorun }}
        ptyId={ptyId}
        onParamsChange={handleParamsChange}
      />
    </div>
  );
}
