export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type WorkerSource =
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

type WorkerRefBase = {
  path: string;
  props?: Record<string, JsonValue>;
  source: WorkerSource;
};

export type StatelessWorkerRef = WorkerRefBase & {
  type: "stateless";
  entrypoint?: string;
};

export type StatefulWorkerRef = WorkerRefBase & {
  type: "stateful";
  className: string;
  durableWorkerKey: string;
};

export type WorkerRef = StatelessWorkerRef | StatefulWorkerRef;

export interface WorkerCollection {
  get<T = unknown>(ref: WorkerRef): T;
}
