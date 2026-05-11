import { ORPCError } from "@orpc/client";
import { ValidationError } from "@orpc/contract";
import { z } from "zod";

function formatIssuePath(path: readonly unknown[] | undefined): string {
  if (!path?.length) {
    return "input";
  }

  return path.map(String).join(".");
}

function formatStandardIssues(
  issues: readonly { path?: readonly unknown[]; message?: string }[],
): string {
  return issues
    .map((issue) => {
      const where = formatIssuePath(issue.path);
      const detail = issue.message?.trim() ? issue.message : "Invalid value";
      return `${where}: ${detail}`;
    })
    .join("\n");
}

function issuesFromOrpcData(
  data: unknown,
): readonly { path?: readonly unknown[]; message?: string }[] | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  if ("issues" in data && Array.isArray((data as { issues: unknown }).issues)) {
    return (data as { issues: { path?: readonly unknown[]; message?: string }[] }).issues;
  }

  return null;
}

/**
 * Human-readable message for failed mutations (oRPC validation, Zod parse, etc.).
 */
export function formatClientError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return z.prettifyError(error);
  }

  if (ORPCError[Symbol.hasInstance](error)) {
    const orpc = error as ORPCError<string, unknown>;

    if (orpc.cause instanceof ValidationError) {
      return formatStandardIssues(orpc.cause.issues);
    }

    const fromData = issuesFromOrpcData(orpc.data);
    if (fromData?.length) {
      return formatStandardIssues(fromData);
    }

    if (typeof orpc.message === "string" && orpc.message.trimStart().startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(orpc.message);
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every((item) => typeof item === "object" && item !== null)
        ) {
          return formatStandardIssues(parsed as { path?: readonly unknown[]; message?: string }[]);
        }
      } catch {
        // fall through
      }
    }

    return orpc.message;
  }

  return error instanceof Error ? error.message : String(error);
}
