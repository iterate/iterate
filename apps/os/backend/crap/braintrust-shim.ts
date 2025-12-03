export const permalink = (..._args: unknown[]) => "nope";
type Logger = {
  startSpan: (..._args: unknown[]) => Span;
};
export const initLogger = (..._args: unknown[]) => ({}) as Logger;
export const init = (..._args: unknown[]) => ({}) as Logger;
export type Span = {
  log: Function;
  end: Function;
  flush: Function;
  export: Function;
  startSpan: (...args: unknown[]) => Span;
};
export const startSpan = (..._args: unknown[]): Span =>
  ({
    log: (..._args: unknown[]) => {},
    end: () => {},
    flush: () => {},
    export: () => "nope",
    startSpan: (..._args: unknown[]) => startSpan(..._args),
  }) as Span;
