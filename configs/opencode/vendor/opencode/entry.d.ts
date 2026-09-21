// Hand-written types for the prebundled `@opencode/sdk/workerd` next to this
// file (see vendor/README.md for how the bundle is produced). Only the part
// of opencode's client surface the template uses is declared; the real
// package ships thousands of lines of generated types that would drag
// @opencode/* into the monorepo's dependency graph for a proof of concept.

export namespace OpenCodeWorkerd {
  type ModelRef = { providerID: string; id: string };

  type SessionInfo = {
    id: string;
    title: string;
    time: { created: number; updated: number };
  };

  type AssistantContent =
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "tool"; tool: string; state: { status: string; [key: string]: unknown } };

  /** Only the two message kinds the template reads; opencode has several more. */
  type SessionMessage =
    | { type: "user"; id: string; time: { created: number }; text: string }
    | {
        type: "assistant";
        id: string;
        time: { created: number; completed?: number };
        agent: string;
        model: ModelRef;
        content: AssistantContent[];
        finish?: string;
        error?: { name: string; message?: string; [key: string]: unknown };
      };

  interface Interface {
    server: { info(): Promise<{ version: string; pid: number; urls: string[] }> };
    sessions: {
      create(input?: {
        title?: string | null;
        agent?: string | null;
        model?: ModelRef | null;
        location?: { directory: string } | null;
      }): Promise<SessionInfo>;
      list(input?: { limit?: number }): Promise<{ data: SessionInfo[] } | SessionInfo[]>;
      get(input: { sessionID: string }): Promise<SessionInfo>;
      prompt(input: {
        sessionID: string;
        text: string;
      }): Promise<{ id: string; sessionID: string }>;
      wait(input: { sessionID: string }): Promise<void>;
    };
    message: {
      list(input: {
        sessionID: string;
        order?: "asc" | "desc";
        limit?: number;
      }): Promise<{ data: SessionMessage[] }>;
    };
    model: {
      list(): Promise<unknown>;
    };
    provider: {
      list(): Promise<unknown>;
    };
    close(): Promise<void>;
  }

  interface CreateOptions {
    /** The Durable Object's storage — opencode's database lives in its SQLite. */
    storage: DurableObjectStorage;
    /** opencode.json content, minus plugins (those are passed as objects). */
    config?: Record<string, unknown>;
    /** models.dev catalog: the bundled snapshot is always the floor. */
    models?: { fetch?: boolean; snapshot?: boolean };
    plugins?: unknown[];
    log?: { level?: "debug" | "info" | "warn" | "error"; write?: (entry: unknown) => void };
  }

  function create(options: CreateOptions): Promise<Interface>;
}
