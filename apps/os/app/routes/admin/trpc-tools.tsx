import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { TrpcToolsSection, type ProcedureInputs } from "../../components/trpc-procedure-form.tsx";

export const Route = createFileRoute("/_auth/admin/trpc-tools")({
  component: TrpcToolsPage,
});

function TrpcToolsPage() {
  const { data: procedures } = useSuspenseQuery(trpc.admin.allProcedureInputs.queryOptions());

  // Execute a procedure via the trpcClient
  const executeProcedure = useCallback(
    async (path: string, type: "query" | "mutation", data: Record<string, unknown>) => {
      // Traverse the nested path (e.g., "admin.createOrganization" -> trpcClient.admin.createOrganization)
      const pathParts = path.split(".");

      let procedure: any = trpcClient;
      for (const part of pathParts) {
        procedure = procedure[part];
      }

      if (type === "mutation") {
        return procedure.mutate(data);
      } else if (type === "query") {
        return procedure.query(data);
      } else {
        throw new Error(`Unsupported procedure type: ${type}`);
      }
    },
    [],
  );

  return (
    <div className="p-4">
      <TrpcToolsSection
        procedures={procedures as Array<[string, ProcedureInputs]>}
        executeProcedure={executeProcedure}
        initialSearch="admin."
        title="All tRPC Procedures"
      />
    </div>
  );
}
