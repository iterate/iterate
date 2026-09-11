import { RpcTarget } from "capnweb";
import { z } from "zod";

/** A serializable subset of createWorker options; no callbacks or network resolution. */
export const BuildOptions = z.strictObject({
  entryPoint: z.string().min(1).max(240),
  target: z.string().optional(),
  minify: z.boolean().optional(),
  sourcemap: z.boolean().optional(),
});
export const BuildInput = z.strictObject({
  source: z.strictObject({ repo: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/) }),
  options: BuildOptions,
});
export type BuildInput = z.infer<typeof BuildInput>;
export const BuiltCode = z.strictObject({
  compatibilityDate: z.string(),
  compatibilityFlags: z.array(z.string()),
  mainModule: z.string(),
  modules: z.record(z.string(), z.string()),
});
export type BuildResult =
  | { status: "rejected"; diagnostics: string[] }
  | {
      status: "built";
      code: z.infer<typeof BuiltCode>;
      diagnostics: string[];
      key: string;
      cache: "hit" | "miss";
    };

/** Building yields inert code. Only the receiving context's load() grants authority. */
export abstract class BuilderTarget extends RpcTarget {
  abstract build(input: BuildInput): Promise<BuildResult>;
}

export class Builder extends BuilderTarget {
  #compile: (input: BuildInput) => Promise<BuildResult>;
  constructor(compile: (input: BuildInput) => Promise<BuildResult>) {
    super();
    this.#compile = compile;
  }
  override build(input: BuildInput) {
    return this.#compile(BuildInput.parse(input));
  }
}
