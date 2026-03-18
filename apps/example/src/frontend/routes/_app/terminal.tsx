import { useCallback } from "react";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Terminal } from "@iterate-com/ui/components/terminal";

const TerminalParams = z.object({
  command: z.string().optional(),
  autorun: z.boolean().optional(),
  ptyId: z.string().optional(),
});

export const Route = createFileRoute("/_app/terminal")({
  validateSearch: TerminalParams,
  component: TerminalPage,
});

function TerminalPage() {
  const { command, autorun, ptyId } = Route.useSearch();
  const navigate = Route.useNavigate();

  const updateParams = useCallback(
    (params: { ptyId?: string; clearCommand?: boolean }) => {
      navigate({
        search: (previous) => {
          const next = { ...previous };

          if (params.ptyId) {
            next.ptyId = params.ptyId;
          }

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
    <div className="flex min-h-full flex-1 flex-col">
      <div className="flex-1 overflow-hidden bg-[#1e1e1e]">
        <ClientOnly fallback={<div className="h-full w-full bg-[#1e1e1e]" />}>
          <div className="h-full w-full">
            <Terminal
              initialCommand={{ command, autorun }}
              ptyId={ptyId}
              onParamsChange={updateParams}
            />
          </div>
        </ClientOnly>
      </div>
    </div>
  );
}
