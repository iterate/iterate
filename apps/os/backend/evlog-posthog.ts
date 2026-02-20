import type { WideEvent } from "evlog";
import {
  sendPostHogException,
  type PostHogRequestContext,
  type PostHogUserContext,
} from "./lib/posthog.ts";

const appStage =
  process.env.VITE_APP_STAGE ?? process.env.APP_STAGE ?? process.env.NODE_ENV ?? "development";

type PostHogEnv = {
  POSTHOG_PUBLIC_KEY?: string;
  VITE_APP_STAGE?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function toPostHogRequestContext(event: WideEvent): PostHogRequestContext {
  const request = isRecord(event.request) ? event.request : {};
  const id = asString(request.id) ?? asString(event.requestId) ?? "unknown";
  const method = asString(request.method) ?? asString(event.method) ?? "UNKNOWN";
  const path = asString(request.path) ?? asString(event.path) ?? "unknown";
  const status = asNumber(event.status) ?? asNumber(request.status) ?? 500;
  const duration = asNumber(event.duration) ?? asNumber(request.duration) ?? 0;
  const waitUntil = event.waitUntil === true || request.waitUntil === true;
  const parentRequestId = asString(event.parentRequestId) ?? asString(request.parentRequestId);
  const trpcProcedure = asString(event.trpcProcedure) ?? asString(request.trpcProcedure);
  const url = asString(event.url) ?? asString(request.url);

  return {
    id,
    method,
    path,
    status,
    duration,
    waitUntil,
    ...(parentRequestId ? { parentRequestId } : {}),
    ...(trpcProcedure ? { trpcProcedure } : {}),
    ...(url ? { url } : {}),
  };
}

function toPostHogUserContext(event: WideEvent): PostHogUserContext {
  const user = isRecord(event.user) ? event.user : {};
  return {
    id: asString(user.id) ?? asString(event.userId) ?? "anonymous",
    email: asString(user.email) ?? asString(event.userEmail) ?? "unknown",
  };
}

export async function reportRequestErrorToPostHog(input: {
  env: PostHogEnv;
  error: Error;
  event: WideEvent;
}): Promise<void> {
  const apiKey = input.env.POSTHOG_PUBLIC_KEY;
  if (!apiKey) return;

  const request = toPostHogRequestContext(input.event);
  const user = toPostHogUserContext(input.event);

  await sendPostHogException({
    apiKey,
    distinctId: user.id,
    errors: [input.error],
    request,
    user,
    environment: input.env.VITE_APP_STAGE ?? appStage,
    lib: "evlog-worker",
  });
}
