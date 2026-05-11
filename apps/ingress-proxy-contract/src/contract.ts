import { oc } from "@orpc/contract";
import { internalContract } from "@iterate-com/shared/apps/internal-router-contract";
import { z } from "zod";

const rootHostChars = /^[a-z0-9._-]+$/;

function normalizeHostLikeInput(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";

  let host = trimmed;
  if (trimmed.startsWith("[")) {
    const endBracket = trimmed.indexOf("]");
    host = endBracket === -1 ? "" : trimmed.slice(1, endBracket);
  } else {
    const lastColon = trimmed.lastIndexOf(":");
    if (lastColon !== -1 && trimmed.indexOf(":") === lastColon) {
      host = trimmed.slice(0, lastColon);
    }
  }

  return host.replace(/\.$/, "");
}

function normalizeTargetUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("targetUrl must be a valid URL");
  }

  if (/^[/?#.]/.test(trimmed)) {
    throw new Error("targetUrl must be a valid URL");
  }

  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : /^(https?|wss?):/i.test(trimmed)
      ? trimmed.replace(/^([a-z][a-z\d+.-]*):/i, "$1://")
      : `https://${trimmed}`;
  const normalizedInput = withScheme
    .replace(/^ws:\/\//i, "http://")
    .replace(/^wss:\/\//i, "https://");

  const parsed = new URL(normalizedInput);
  if (!parsed.hostname) {
    throw new Error("targetUrl must be a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("targetUrl must use http or https");
  }

  return parsed.toString();
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

export const rootHostSchema = z
  .string()
  .trim()
  .transform(normalizeHostLikeInput)
  .refine((value) => value.length > 0, {
    message: "rootHost is required",
  })
  .refine((value) => !value.includes(".."), {
    message: "rootHost is invalid",
  })
  .refine((value) => !value.includes("__"), {
    message: "rootHost must not contain double underscore",
  })
  .refine((value) => !value.startsWith("*"), {
    message: "rootHost must not contain wildcards",
  })
  .refine((value) => value.includes("."), {
    message: "rootHost must include a dot",
  })
  .refine((value) => rootHostChars.test(value), {
    message: "rootHost is invalid",
  });

export const routeMetadataSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    if (!isJsonValue(value)) {
      context.addIssue({
        code: "custom",
        message: "metadata must be a JSON-serializable object",
      });
    }
  });

export const targetUrlSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    try {
      return normalizeTargetUrl(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "targetUrl must be a valid URL",
      });
      return z.NEVER;
    }
  });

export const IngressProxyRoute = z.object({
  id: z.string().min(1),
  rootHost: z.string().min(1),
  targetUrl: z.string().min(1),
  metadata: routeMetadataSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const UpsertRouteInput = z.object({
  rootHost: rootHostSchema,
  targetUrl: targetUrlSchema,
  metadata: IngressProxyRoute.shape.metadata.optional().default({}),
});

export const GetRouteInput = z.object({
  rootHost: rootHostSchema,
});

export const ListRoutesInput = z.object({
  limit: z.coerce.number().int().positive().max(100).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const ListRoutesOutput = z.object({
  routes: z.array(IngressProxyRoute),
  total: z.number().int().nonnegative(),
});

export const RemoveRouteInput = z.object({
  rootHost: rootHostSchema,
});

const RemoveRouteOutput = z.object({
  deleted: z.boolean(),
});

export const ingressProxyContract = oc.router({
  __internal: internalContract,
  routes: {
    upsert: oc
      .route({
        method: "PUT",
        path: "/routes/{rootHost}",
        tags: ["/routes"],
      })
      .input(UpsertRouteInput)
      .output(IngressProxyRoute),

    get: oc
      .route({
        method: "GET",
        path: "/routes/{rootHost}",
        tags: ["/routes"],
      })
      .input(GetRouteInput)
      .output(IngressProxyRoute),

    list: oc
      .route({
        method: "GET",
        path: "/routes",
        tags: ["/routes"],
      })
      .input(ListRoutesInput)
      .output(ListRoutesOutput),

    remove: oc
      .route({
        method: "DELETE",
        path: "/routes/{rootHost}",
        tags: ["/routes"],
      })
      .input(RemoveRouteInput)
      .output(RemoveRouteOutput),
  },
});

export type IngressProxyRoute = z.infer<typeof IngressProxyRoute>;
