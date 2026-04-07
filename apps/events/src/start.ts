import { createMiddleware, createStart } from "@tanstack/react-start";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-iterate-project, authorization",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, POST, DELETE, PATCH, OPTIONS",
};

const corsMiddleware = createMiddleware().server(async ({ request, next }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const result = await next();

  if ("response" in result && result.response) {
    for (const [header, value] of Object.entries(corsHeaders)) {
      result.response.headers.set(header, value);
    }
  }

  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [corsMiddleware],
}));
