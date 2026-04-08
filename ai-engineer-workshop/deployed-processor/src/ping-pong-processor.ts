import { defineProcessor } from "ai-engineer-workshop/runtime";

export function createPingPongProcessor() {
  return defineProcessor<Record<string, never>>(() => ({
    slug: "ping-pong",
    initialState: {},
    reduce: ({ state }) => state,
    afterAppend: async ({ append, event }) => {
      if (!eventContainsPing(event)) {
        return;
      }

      await append({
        event: {
          type: "pong",
          payload: {
            sourceOffset: event.offset,
          },
        },
      });
    },
  }));
}

function eventContainsPing(event: { type: string; payload: unknown }) {
  if (event.type === "https://events.iterate.com/events/stream/subscription/configured") {
    return false;
  }

  if (event.type.toLowerCase().includes("ping")) {
    return true;
  }

  return collectPingableStrings(event.payload).some((value) =>
    value.toLowerCase().includes("ping"),
  );
}

function collectPingableStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return value.includes("://") ? [] : [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPingableStrings(item));
  }

  if (value != null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      key === "callbackUrl" ||
      key === "jsonataFilter" ||
      key === "jsonataTransform" ||
      key === "slug"
        ? []
        : collectPingableStrings(item),
    );
  }

  return [];
}
