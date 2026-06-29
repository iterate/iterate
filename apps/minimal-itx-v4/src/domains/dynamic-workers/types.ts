export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DynamicWorkerSource =
  | {
      type: "inline";
      mainModule: string;
      modules: Record<string, string>;
    }
  | {
      type: "repo";
      repoPath: string;
      sourcePath: string;
    };

export type DynamicWorkerRef = {
  source: DynamicWorkerSource;
  cacheKey?: string;
  target:
    | {
        type: "worker-entrypoint";
        entrypoint?: string;
        props?: Record<string, JsonValue>;
      }
    | {
        type: "durable-object";
        className: string;
      };
};
