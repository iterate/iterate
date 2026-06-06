export const LOCAL_PROXY_CALLER_MARK: "__localProxyCaller";

type LocalProxyCallInput = { args: unknown[]; path: string[] };
type LocalProxyCall =
  | ((input: LocalProxyCallInput) => unknown)
  | {
      call?(input: LocalProxyCallInput): unknown;
      invoke?(input: LocalProxyCallInput): unknown;
    };

export function localProxyCaller(call: LocalProxyCall): {
  __localProxyCaller: true;
  call: LocalProxyCall;
};

export function liftLocalProxies<T>(value: T): T;
