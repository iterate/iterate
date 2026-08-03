/** A bounded shell command submitted to an agent-owned Cloudflare Computer. */
export type ComputerExecInput = {
  /** Shell command interpreted by the selected Cloudflare Computer backend. */
  command: string;
  /** Absolute cwd; defaults to the birth certificate's workingDirectory. */
  cwd?: string;
  /** Bounded execution timeout; defaults to the Computer configuration. */
  timeoutMs?: number;
};

/** The terminal shell and filesystem-sync result of a Computer execution. */
export type ComputerExecResult = {
  executionId: string;
  exitCode: number;
  stderr: string;
  stdout: string;
  syncStatus: "complete" | "pending";
};

/** Options for reading a UTF-8 file through Cloudflare Computer. */
export type ComputerReadFileOptions = { encoding?: "utf8" };
/** Options that bound a Cloudflare Computer directory listing. */
export type ComputerReaddirOptions = { limit?: number };
/** Options controlling Cloudflare Computer filesystem text search. */
export type ComputerGrepOptions = { ignoreCase?: boolean };
/** Options controlling Cloudflare Computer file creation and permissions. */
export type ComputerWriteFileOptions = { mode?: number; exclusive?: boolean };
/** Options controlling Cloudflare Computer directory creation. */
export type ComputerMkdirOptions = { recursive?: boolean; mode?: number };
/** Options controlling Cloudflare Computer filesystem removal. */
export type ComputerRmOptions = { recursive?: boolean; force?: boolean };

/** RPC-safe metadata returned for a Cloudflare Computer filesystem entry. */
export type ComputerStatResult = {
  name: string;
  inode: number;
  mode: number;
  mtime: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

/** RPC-safe directory-entry metadata returned by Cloudflare Computer. */
export type ComputerDirentResult = {
  name: string;
  parentPath: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

/** A filesystem entry found by Cloudflare Computer's recursive search. */
export type ComputerFoundEntry = { path: string; type: "file" | "dir" };
/** A matching line returned by Cloudflare Computer's text search. */
export type ComputerGrepMatch = { path: string; line: number; text: string };

/** JSON-compatible value accepted and returned by Cloudflare Computer runtimes. */
export type ComputerRuntimeValue =
  | null
  | boolean
  | number
  | string
  | ComputerRuntimeValue[]
  | { [key: string]: ComputerRuntimeValue };

/** Options for starting a detached Cloudflare Computer runtime execution. */
export type ComputerRuntimeExecOptions = {
  id?: string;
  backend?: string;
  cwd?: string;
  encoding?: "utf8";
  input?: ComputerRuntimeValue;
  env?: Record<string, string>;
  stdin?: Uint8Array | string;
  timeoutMs?: number;
};

/** Options for reconnecting to a detached Cloudflare Computer execution. */
export type ComputerRuntimeGetOptions = {
  backend?: string;
  encoding?: "utf8";
  resume?: "tail" | "full" | number;
};

/** Options for signalling a detached Cloudflare Computer execution. */
export type ComputerRuntimeKillOptions = {
  backend?: string;
  /** One of SIGTERM, SIGKILL, SIGINT, or SIGHUP. */
  signal?: string;
};

/** The completed process and filesystem-sync result from a Computer runtime. */
export type ComputerRuntimeResult = {
  status: "completed" | "failed" | "cancelled";
  exitCode: number;
  stdout: string | Uint8Array;
  stderr: string | Uint8Array;
  value?: ComputerRuntimeValue;
  pushed: number;
  pulled: number;
  skipped: {
    path: string;
    mountRoot: string;
    op: "write" | "delete";
    reason: "read-only";
  }[];
  sync:
    | {
        status: "complete";
        applied: number;
        skipped: {
          path: string;
          mountRoot: string;
          op: "write" | "delete";
          reason: "read-only";
        }[];
      }
    | {
        status: "pending";
        applied: number;
        skipped: {
          path: string;
          mountRoot: string;
          op: "write" | "delete";
          reason: "read-only";
        }[];
        error: string;
      };
};

/** Input for invoking Git's command-line interface inside a Computer. */
export type ComputerGitCliInput = {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
};

/** Standard streams and exit status returned by a Computer CLI operation. */
export type ComputerCliResult = { stdout: string; stderr: string; exitCode: number };

/** Complete metadata for an artifact repository, including its Git remote. */
export type ComputerArtifactRepoInfo = {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  source: string | null;
  readOnly: boolean;
  remote: string;
};

/** Summary metadata for an artifact repository. */
export type ComputerArtifactRepoSummary = Omit<ComputerArtifactRepoInfo, "remote">;

/** Repository details and initial credentials returned when creating an artifact. */
export type ComputerArtifactCreateResult = {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  remote: string;
  token: string;
  tokenExpiresAt: string;
};

/** Metadata and lifecycle state for an artifact access token. */
export type ComputerArtifactToken = {
  id: string;
  scope: "read" | "write";
  state: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
};

/** A newly created artifact token including its one-time plaintext value. */
export type ComputerArtifactCreatedToken = {
  id: string;
  plaintext: string;
  scope: "read" | "write";
  expiresAt: string;
};

/** A paginated collection of artifact access tokens. */
export type ComputerArtifactTokenList = {
  tokens: ComputerArtifactToken[];
  total: number;
};

/** Input for invoking the Artifacts command-line interface. */
export type ComputerArtifactsCliInput = {
  argv: string[];
  env?: Record<string, string>;
};
