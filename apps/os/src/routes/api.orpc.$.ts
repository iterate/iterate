import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@clerk/tanstack-react-start/server";
import { isAdminApiSecretRequest } from "~/orpc/auth.ts";
import { orpcRpcHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/orpc/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        const clerkAuth = isAdminApiSecretRequest(context, request) ? undefined : await auth();
        const { matched, response } = await orpcRpcHandler.handle(request, {
          prefix: "/api/orpc",
          context: {
            ...context,
            auth: clerkAuth,
            rawRequest: request,
          },
        });

        if (matched && response) return response;
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});
