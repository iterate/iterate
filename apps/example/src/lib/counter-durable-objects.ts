import { z } from "zod";

export const COUNTER_DURABLE_OBJECT_CLASS_NAME = "ExampleCounter";
export const COUNTER_DURABLE_OBJECT_NAMESPACE_SLUG = "counters";

const CounterDimensionSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, numbers, and dashes.");

export const CreateCounterFormValues = z.object({
  scope: CounterDimensionSchema,
  variant: CounterDimensionSchema,
});

export type CreateCounterFormValues = z.infer<typeof CreateCounterFormValues>;

export type CounterInitParams = CreateCounterFormValues & {
  name: string;
};

export type CounterExplorerLinks = {
  kv: string;
  kvJson: string;
  sql: string;
  sqlEndpoint: string;
};

export type CounterState = CounterInitParams & {
  count: number;
  updatedAt: string | null;
  publicPath: string;
  explorerLinks: CounterExplorerLinks;
};

export function buildCounterInitParams(input: CreateCounterFormValues): CounterInitParams {
  return {
    ...input,
    name: `${input.scope}-${input.variant}`,
  };
}

export function buildCounterPublicPath(name: string) {
  return `/durable-objects/${COUNTER_DURABLE_OBJECT_NAMESPACE_SLUG}/by-name/${encodeURIComponent(name)}`;
}

export function buildCounterExplorerLinks(publicPath: string): CounterExplorerLinks {
  return {
    kv: `${publicPath}/__kv`,
    kvJson: `${publicPath}/__kv/json`,
    sql: `${publicPath}/__outerbase`,
    sqlEndpoint: `${publicPath}/__outerbase/sql`,
  };
}
