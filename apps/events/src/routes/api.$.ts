import { createFileRoute } from "@tanstack/react-router";
import { AppendInput, StreamPath } from "@iterate-com/events-contract";
import jsonata from "jsonata";
import { z } from "zod";
import { orpcOpenApiHandler } from "~/orpc/handler.ts";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ context, request }) => {
        const transformedAppendResponse = await maybeHandleJsonataAppend({
          env: context.env,
          request,
        });
        if (transformedAppendResponse != null) {
          return transformedAppendResponse;
        }

        const { matched, response } = await orpcOpenApiHandler.handle(request, {
          prefix: "/api",
          context: {
            ...context,
            rawRequest: request,
          },
        });

        if (matched && response) return response;
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});

async function maybeHandleJsonataAppend(args: { env: Env; request: Request }) {
  const { env, request } = args;
  if (request.method !== "POST") {
    return null;
  }

  const url = new URL(request.url);
  const jsonataTransform = url.searchParams.get("jsonataTransform");
  if (jsonataTransform == null) {
    return null;
  }

  if (!url.pathname.startsWith("/api/streams/")) {
    return null;
  }

  const parsedPath = StreamPath.safeParse(url.pathname.slice("/api/streams".length));
  if (!parsedPath.success) {
    return errorResponse("invalid_stream_path", formatZodError(parsedPath.error), 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_json", "Request body must be valid JSON.", 400);
  }

  let transformed: unknown;
  try {
    const expression = jsonata(jsonataTransform);
    transformed = await expression.evaluate(body);
  } catch (error) {
    return errorResponse(
      "invalid_jsonata_transform",
      error instanceof Error ? error.message : String(error),
      400,
    );
  }

  const appendInput = buildAppendInput({
    path: parsedPath.data,
    transformed,
  });
  if (!appendInput.success) {
    return errorResponse("invalid_event_input", formatZodError(appendInput.error), 400);
  }

  const events = "events" in appendInput.data ? appendInput.data.events : [appendInput.data];
  const streamStub = env.STREAM.getByName(appendInput.data.path);
  const result = await streamStub.append({ events });

  return jsonResponse(result, 200);
}

function buildAppendInput(args: { path: string; transformed: unknown }) {
  const { path, transformed } = args;
  if (transformed && typeof transformed === "object" && "events" in transformed) {
    const candidate = transformed as { events?: unknown };
    return AppendInput.safeParse({
      path,
      events: Array.isArray(candidate.events)
        ? candidate.events.map((event) =>
            event != null && typeof event === "object" ? { ...event, path } : event,
          )
        : candidate.events,
    });
  }

  return AppendInput.safeParse(
    transformed != null && typeof transformed === "object" ? { ...transformed, path } : transformed,
  );
}

function errorResponse(error: string, message: string, status: number) {
  return jsonResponse({ error, message }, status);
}

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: {
      "access-control-allow-origin": "*",
    },
  });
}

function formatZodError(error: z.ZodError) {
  const issues = flattenIssues(error.issues);
  if (issues.length === 0) {
    return z.prettifyError(error);
  }

  return issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "input" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}

function flattenIssues(issues: readonly z.core.$ZodIssue[]) {
  const flattened: Array<{ path: readonly PropertyKey[]; message: string }> = [];

  for (const issue of issues) {
    if (issue.code === "invalid_union") {
      for (const nestedIssues of issue.errors) {
        flattened.push(...flattenIssues(nestedIssues));
      }
      continue;
    }

    flattened.push({
      path: issue.path,
      message: issue.message,
    });
  }

  return flattened;
}
