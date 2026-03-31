declare module "@lydell/node-pty" {
  export interface IDisposable {
    dispose(): void;
  }

  export interface IExitEvent {
    exitCode: number;
    signal?: number;
  }

  export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  }

  export interface IPty {
    write(data: string): void;
    kill(signal?: string): void;
    resize(cols: number, rows: number): void;
    onData(listener: (data: string) => void): IDisposable;
    onExit(listener: (event: IExitEvent) => void): IDisposable;
  }

  export function spawn(file: string, args: string[], options: IPtyForkOptions): IPty;
}

declare module "@xterm/headless/lib-headless/xterm-headless.js" {
  export interface TerminalOptions {
    scrollback?: number;
    cols?: number;
    rows?: number;
  }

  export class Terminal {
    constructor(options?: TerminalOptions);
    loadAddon(addon: object): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    dispose(): void;
  }

  const XTermHeadless: {
    Terminal: typeof Terminal;
  };

  export default XTermHeadless;
}
