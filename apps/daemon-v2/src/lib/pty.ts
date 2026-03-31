import type { WebSocketHooks } from "nitro/h3";

export interface PtyDisposable {
  dispose(): void;
}

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: { exitCode: number }) => void): PtyDisposable;
}

export type PtyHooks = Partial<WebSocketHooks>;
export type PtyHookFactory = (request: Request) => PtyHooks;
