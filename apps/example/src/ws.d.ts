declare module "@lydell/node-pty" {
  export interface IPty {
    onData(listener: (data: string) => void): void;
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
  }

  export function spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cwd: string;
      env: Record<string, string>;
    },
  ): IPty;
}

declare module "@xterm/headless/lib-headless/xterm-headless.js";
