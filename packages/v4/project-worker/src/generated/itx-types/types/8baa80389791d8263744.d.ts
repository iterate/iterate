import { z } from "./66f12fdbe94056929e4c";
import type { NativeWorkerCode } from "./79e3a3f04d71acac885e";
export declare const BuildOptions: z.ZodObject<{
    entryPoint: z.ZodString;
    target: z.ZodOptional<z.ZodString>;
    minify: z.ZodOptional<z.ZodBoolean>;
    sourcemap: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const BundleInput: z.ZodObject<{
    files: z.ZodRecord<z.ZodString, z.ZodString>;
    options: z.ZodObject<{
        entryPoint: z.ZodString;
        target: z.ZodOptional<z.ZodString>;
        minify: z.ZodOptional<z.ZodBoolean>;
        sourcemap: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type BundleInput = z.infer<typeof BundleInput>;
export declare const RepositoryBuildInput: z.ZodObject<{
    source: z.ZodObject<{
        repo: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
    options: z.ZodObject<{
        entryPoint: z.ZodString;
        target: z.ZodOptional<z.ZodString>;
        minify: z.ZodOptional<z.ZodBoolean>;
        sourcemap: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type RepositoryBuildInput = z.infer<typeof RepositoryBuildInput>;
export declare const BuildInput: z.ZodUnion<readonly [z.ZodObject<{
    files: z.ZodRecord<z.ZodString, z.ZodString>;
    options: z.ZodObject<{
        entryPoint: z.ZodString;
        target: z.ZodOptional<z.ZodString>;
        minify: z.ZodOptional<z.ZodBoolean>;
        sourcemap: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    source: z.ZodObject<{
        repo: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
    options: z.ZodObject<{
        entryPoint: z.ZodString;
        target: z.ZodOptional<z.ZodString>;
        minify: z.ZodOptional<z.ZodBoolean>;
        sourcemap: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
}, z.core.$strict>]>;
export type BuildInput = z.infer<typeof BuildInput>;
export type BuildResult = {
    status: "rejected";
    diagnostics: string[];
} | {
    status: "built";
    code: NativeWorkerCode;
    diagnostics: string[];
    key: string;
    cache: "hit" | "miss";
};
export type CheckDiagnostic = {
    file?: string;
    line?: number;
    column?: number;
    code: number;
    message: string;
};
export type CheckResult = {
    status: "checked";
    diagnostics: CheckDiagnostic[];
} | {
    status: "rejected";
    diagnostics: CheckDiagnostic[];
};
