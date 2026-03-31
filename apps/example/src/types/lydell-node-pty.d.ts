declare module "@lydell/node-pty" {
  export interface IDisposable {
    dispose(): void;
  }

  export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
  }

  export interface IPty {
    readonly onData: (listener: (data: string) => void) => IDisposable;
    readonly onExit: (
      listener: (event: { exitCode: number; signal?: number }) => void,
    ) => IDisposable;
    resize(columns: number, rows: number): void;
    write(data: string | Buffer): void;
    kill(signal?: string): void;
  }

  export function spawn(file: string, args: string[] | string, options: IPtyForkOptions): IPty;
}
