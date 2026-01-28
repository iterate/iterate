// Type stubs for optional SDK packages
// These packages are lazily loaded at runtime

declare module "@anthropic-ai/claude-agent-sdk" {
  export function query(opts: {
    prompt: string;
    options: {
      model?: string;
      resume?: string;
      workingDirectory?: string;
      allowedTools?: string[];
    };
  }): AsyncIterable<{
    type: string;
    subtype?: string;
    session_id?: string;
  }>;
}

declare module "@openai/codex-sdk" {
  interface CodexThread {
    id: string;
    run(prompt: string): Promise<unknown>;
  }

  export class Codex {
    constructor(opts: { workingDirectory: string });
    startThread(): CodexThread;
    resumeThread(threadId: string): CodexThread;
  }
}
