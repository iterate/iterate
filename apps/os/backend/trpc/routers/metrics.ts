import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { router, projectProtectedProcedure } from "../trpc.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";

const PROMETHEUS_QUERY_MAX_LENGTH = 2_000;
const PROMETHEUS_QUERY_RANGE_DEFAULT_SECONDS = 60 * 60;
const PROMETHEUS_QUERY_RANGE_MAX_SECONDS = 24 * 60 * 60;
const PROMETHEUS_QUERY_STEP_DEFAULT_SECONDS = 30;
const PROMETHEUS_QUERY_STEP_MIN_SECONDS = 5;
const PROMETHEUS_QUERY_STEP_MAX_SECONDS = 3_600;
const PROMETHEUS_FETCH_TIMEOUT_MS = 10_000;

type PrometheusSample = [number, string];
type PrometheusMetric = Record<string, string>;

type PrometheusMatrixResult = {
  metric: PrometheusMetric;
  values: PrometheusSample[];
};

type PrometheusVectorResult = {
  metric: PrometheusMetric;
  value: PrometheusSample;
};

type PrometheusData = {
  resultType: "matrix" | "vector" | "scalar" | "string";
  result: PrometheusMatrixResult[] | PrometheusVectorResult[] | PrometheusSample | string;
};

export type PrometheusResponse = {
  status: "success" | "error";
  data?: PrometheusData;
  errorType?: string;
  error?: string;
  warnings?: string[];
};

const QueryRangeInput = z.object({
  machineId: z.string(),
  query: z.string().trim().min(1).max(PROMETHEUS_QUERY_MAX_LENGTH),
  start: z.number().int().positive().optional(),
  end: z.number().int().positive().optional(),
  step: z
    .number()
    .int()
    .min(PROMETHEUS_QUERY_STEP_MIN_SECONDS)
    .max(PROMETHEUS_QUERY_STEP_MAX_SECONDS)
    .optional(),
});

const InstantQueryInput = z.object({
  machineId: z.string(),
  query: z.string().trim().min(1).max(PROMETHEUS_QUERY_MAX_LENGTH),
});

function parseFlyExternalId(externalId: string): { appName: string; machineId: string } | null {
  const separatorIndex = externalId.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === externalId.length - 1) return null;
  return {
    appName: externalId.slice(0, separatorIndex),
    machineId: externalId.slice(separatorIndex + 1),
  };
}

function getFlyMetricsConfig(
  env: Record<string, unknown>,
): { orgSlug: string; authHeader: string } | null {
  const orgSlugRaw =
    typeof env.FLY_METRICS_ORG_SLUG === "string"
      ? env.FLY_METRICS_ORG_SLUG
      : typeof env.FLY_ORG === "string"
        ? env.FLY_ORG
        : undefined;
  const tokenRaw =
    typeof env.FLY_METRICS_TOKEN === "string"
      ? env.FLY_METRICS_TOKEN
      : typeof env.FLY_API_TOKEN === "string"
        ? env.FLY_API_TOKEN
        : undefined;

  const orgSlug = orgSlugRaw?.trim();
  const token = tokenRaw?.trim();
  if (!orgSlug || !token) return null;

  return {
    orgSlug,
    authHeader: token.startsWith("FlyV1 ") ? token : `Bearer ${token}`,
  };
}

function normalizeRange(input: z.infer<typeof QueryRangeInput>): {
  start: number;
  end: number;
  step: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const end = input.end ?? now;
  const start = input.start ?? end - PROMETHEUS_QUERY_RANGE_DEFAULT_SECONDS;
  if (end <= start) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid query range: end must be greater than start",
    });
  }

  if (end - start > PROMETHEUS_QUERY_RANGE_MAX_SECONDS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Query range too large: max ${PROMETHEUS_QUERY_RANGE_MAX_SECONDS} seconds`,
    });
  }

  return {
    start,
    end,
    step: input.step ?? PROMETHEUS_QUERY_STEP_DEFAULT_SECONDS,
  };
}

function validateQuery(query: string, flyMachineId: string): void {
  if (query.includes(";") || query.includes("\n") || query.includes("\r")) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid query: semicolons and newlines are not allowed",
    });
  }

  const requiredSelector = `instance="${flyMachineId}"`;
  if (!query.includes(requiredSelector)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Query must include ${requiredSelector}`,
    });
  }
}

async function queryFlyPrometheus(params: {
  orgSlug: string;
  authHeader: string;
  path: "query" | "query_range";
  query: string;
  start?: number;
  end?: number;
  step?: number;
}): Promise<PrometheusResponse> {
  const searchParams = new URLSearchParams({ query: params.query });
  if (params.path === "query_range") {
    searchParams.set("start", String(params.start));
    searchParams.set("end", String(params.end));
    searchParams.set("step", String(params.step));
  }

  const url = `https://api.fly.io/prometheus/${params.orgSlug}/api/v1/${params.path}?${searchParams.toString()}`;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), PROMETHEUS_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: params.authHeader,
      },
      signal: abortController.signal,
    });

    const text = await response.text();
    let parsed: PrometheusResponse;
    try {
      parsed = JSON.parse(text) as PrometheusResponse;
    } catch {
      parsed = { status: "error", error: text || "Invalid upstream response" };
    }

    if (!response.ok) {
      logger.error("Fly metrics upstream error", {
        path: params.path,
        status: response.status,
        body: text.slice(0, 500),
      });
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: `Fly metrics request failed (${response.status})`,
      });
    }

    if (parsed.status === "error") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: parsed.error || parsed.errorType || "Fly metrics query failed",
      });
    }

    return parsed;
  } catch (error) {
    if (error instanceof TRPCError) {
      throw error;
    }

    logger.error("Fly metrics request exception", {
      path: params.path,
      error: String(error),
    });
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: "Failed to query Fly metrics",
    });
  } finally {
    clearTimeout(timeout);
  }
}

export const metricsRouter = router({
  queryRange: projectProtectedProcedure.input(QueryRangeInput).query(async ({ ctx, input }) => {
    const metricsConfig = getFlyMetricsConfig(ctx.env as Record<string, unknown>);
    if (!metricsConfig) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Fly metrics are not configured",
      });
    }

    const machine = await ctx.db.query.machine.findFirst({
      where: and(
        eq(schema.machine.id, input.machineId),
        eq(schema.machine.projectId, ctx.project.id),
      ),
    });
    if (!machine) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Machine not found" });
    }

    if (machine.type !== "fly") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Metrics proxy currently supports Fly machines only",
      });
    }

    const flyMachine = parseFlyExternalId(machine.externalId);
    if (!flyMachine) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Machine is missing a valid Fly external ID",
      });
    }

    validateQuery(input.query, flyMachine.machineId);
    const range = normalizeRange(input);

    return queryFlyPrometheus({
      orgSlug: metricsConfig.orgSlug,
      authHeader: metricsConfig.authHeader,
      path: "query_range",
      query: input.query,
      start: range.start,
      end: range.end,
      step: range.step,
    });
  }),

  instantQuery: projectProtectedProcedure.input(InstantQueryInput).query(async ({ ctx, input }) => {
    const metricsConfig = getFlyMetricsConfig(ctx.env as Record<string, unknown>);
    if (!metricsConfig) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Fly metrics are not configured",
      });
    }

    const machine = await ctx.db.query.machine.findFirst({
      where: and(
        eq(schema.machine.id, input.machineId),
        eq(schema.machine.projectId, ctx.project.id),
      ),
    });
    if (!machine) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Machine not found" });
    }

    if (machine.type !== "fly") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Metrics proxy currently supports Fly machines only",
      });
    }

    const flyMachine = parseFlyExternalId(machine.externalId);
    if (!flyMachine) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Machine is missing a valid Fly external ID",
      });
    }

    validateQuery(input.query, flyMachine.machineId);

    return queryFlyPrometheus({
      orgSlug: metricsConfig.orgSlug,
      authHeader: metricsConfig.authHeader,
      path: "query",
      query: input.query,
    });
  }),
});
