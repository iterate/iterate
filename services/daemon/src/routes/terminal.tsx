import { useCallback, useEffect, useState } from "react";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { Terminal } from "@iterate-com/ui/components/terminal";
import { z } from "zod/v4";

const TerminalParams = z.object({
  command: z.string().optional(),
  autorun: z.boolean().optional(),
  ptyId: z.string().optional(),
});

export const Route = createFileRoute("/terminal")({
  validateSearch: TerminalParams,
  component: TerminalPage,
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
      <ClientOnly fallback={<div className="h-full w-full bg-[#1e1e1e]" />}>
        <Terminal
          initialCommand={{ command, autorun }}
          ptyId={ptyId}
          onParamsChange={handleParamsChange}
        />
      </ClientOnly>
    </div>
  );
}
