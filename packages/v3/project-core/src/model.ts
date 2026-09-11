import { z } from "zod";

export class Fault extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(`${code}: ${message}`);
  }
}

/** Expected failures cross native RPC as data; exception brands do not survive transport. */
export type NativeFailure = { code: string; message: string; status: number };
export type NativeResult<T> =
  | { result: T; error?: never }
  | { error: NativeFailure; result?: never };

export function expectedFailure(error: unknown): NativeFailure {
  if (error instanceof Fault)
    return { code: error.code, message: error.message, status: error.status };
  if (error instanceof z.ZodError)
    return { code: "VALIDATION", message: error.message, status: 400 };
  throw error;
}

export function httpError({ code, message, status }: NativeFailure) {
  return Response.json({ error: { code, message } }, { status });
}

export function address(project: string, path = "/", base = "/") {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(project)) throw new Fault("PROJECT", "Invalid project name");
  const segments: string[] = [];
  for (const part of `${path.startsWith("/") ? "" : base}/${path}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") segments.pop();
    else {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(part)) throw new Fault("PATH", "Invalid context path");
      segments.push(part);
    }
  }
  if (segments.length > 32) throw new Fault("PATH", "Context path is too deep");
  if (`${project}/${segments.join("/")}`.length > 256)
    throw new Fault("PATH", "Context address exceeds 256 characters");
  return { project, path: `/${segments.join("/")}`, name: `${project}/${segments.join("/")}` };
}

export const ModulesSchema = z
  .record(z.string().min(1).max(200), z.string())
  .refine(
    (modules) => typeof modules["main.js"] === "string" && Object.keys(modules).length <= 32,
    "A source needs main.js and at most 32 modules",
  );
export const Source = z.union([
  z.strictObject({ modules: ModulesSchema }),
  z.strictObject({ repo: z.string().min(1).max(80), revision: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export type Source = z.infer<typeof Source>;
export const WorkerMount = z.strictObject({
  kind: z.literal("worker"),
  source: Source,
  exportName: z.string().optional(),
});
export const Target = z.discriminatedUnion("kind", [
  WorkerMount,
  z.strictObject({ kind: z.literal("client"), key: z.uuid() }),
  z.strictObject({
    kind: z.literal("context"),
    path: z.string(),
    member: z.array(z.string()).max(16),
  }),
]);
export type Target = z.infer<typeof Target>;
export const Mount = z.strictObject({
  match: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/),
  target: Target.nullable(),
});
export const Processor = z.strictObject({
  source: Source,
  exportName: z.string().optional(),
  consumes: z.array(z.string()).max(32),
  afterOffset: z.number().int().nonnegative(),
});
export const Trust = z.strictObject({
  keys: z.array(z.string().regex(/^ed25519:[A-Za-z0-9_-]{43}$/)).max(64),
  minLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  minSigners: z.number().int().min(1).max(16).default(1),
});
export type Trust = z.infer<typeof Trust>;
export const Read = z.strictObject({
  afterOffset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(128).default(128),
});

export function methodPath(path: readonly string[]) {
  if (
    !path.length ||
    path.length > 24 ||
    path.some(
      (part) =>
        !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(part) ||
        ["constructor", "prototype", "__proto__", "then"].includes(part),
    )
  )
    throw new Fault("METHOD", "Invalid method path");
  return path;
}
