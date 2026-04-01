import { forwardCodemodeRequest } from "./lib/codemode-secret-injection.ts";

export default {
  async fetch(request: Request, env: Pick<Env, "DB">) {
    const startedAt = Date.now();
    console.log("[codemode-outbound]", request.method, request.url);

    try {
      const response = await forwardCodemodeRequest({
        db: env.DB,
        request,
      });

      console.log(
        "[codemode-outbound]",
        request.method,
        request.url,
        response.status,
        `${Date.now() - startedAt}ms`,
      );

      return response;
    } catch (error) {
      console.error("[codemode-outbound]", request.method, request.url, error);

      return Response.json(
        {
          error: "forward_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 502 },
      );
    }
  },
};
