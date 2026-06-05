import { newWorkersRpcResponse } from "capnweb";
import type { AppConfig } from "~/app.ts";
import { authenticateAdminApiSecret } from "~/auth/middleware.ts";
import type { IterateContext } from "./iterate-context.ts";

export const PROJECT_CAPNWEB_PATH = "/__iterate/capnweb";

export function isProjectCapnwebRequest(request: Request) {
  return new URL(request.url).pathname === PROJECT_CAPNWEB_PATH;
}

export async function handleProjectCapnwebFetch(input: {
  config: AppConfig;
  getContext: () => IterateContext | Promise<IterateContext>;
  request: Request;
}) {
  if (!isProjectCapnwebRequest(input.request)) return null;

  const principal = authenticateAdminApiSecret({ config: input.config }, input.request);
  if (!principal) return new Response("Unauthorized", { status: 401 });

  return newWorkersRpcResponse(input.request, await input.getContext());
}
