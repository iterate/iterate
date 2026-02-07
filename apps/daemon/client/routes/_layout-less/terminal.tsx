import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod/v4";
import { useCallback, useEffect, useState } from "react";
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

/**
 * Track the visual viewport height so the terminal resizes when the iOS
 * keyboard opens. Safari doesn't support interactive-widget=resizes-content,
 * so dvh alone won't shrink when the keyboard appears. The visualViewport
 * API is the standard workaround.
 */
function useVisualViewportHeight() {
  const [height, setHeight] = useState<string>("100dvh");

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setHeight(`${vv.height}px`);
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return height;
}

function TerminalPage() {
  const { command, autorun, ptyId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const height = useVisualViewportHeight();

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
    <div
      className="w-screen overflow-hidden bg-[#1e1e1e] p-1"
      style={{
        height,
        paddingTop: "max(4px, env(safe-area-inset-top))",
        paddingLeft: "max(4px, env(safe-area-inset-left))",
        paddingRight: "max(4px, env(safe-area-inset-right))",
        paddingBottom: "max(4px, env(safe-area-inset-bottom))",
      }}
    >
      <XtermTerminal
        initialCommand={{ command, autorun }}
        ptyId={ptyId}
        onParamsChange={handleParamsChange}
      />
    </div>
  );
}
