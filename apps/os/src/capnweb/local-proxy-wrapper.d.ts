export const LOCAL_PROXY_CALLER_MARK: "__localProxyCaller";

type LocalProxyCallInput = { args: unknown[]; path: string[] };
type LocalProxyCall = (input: LocalProxyCallInput) => unknown;

export function localProxyCaller(call: LocalProxyCall): {
  __localProxyCaller: true;
  call: LocalProxyCall;
};

export function isLocalProxyCaller(
  value: unknown,
): value is { __localProxyCaller: true; call: LocalProxyCall };

export function callLocalProxyCaller(
  value: { __localProxyCaller: true; call: LocalProxyCall },
  input: LocalProxyCallInput,
): unknown;

export function liftLocalProxies<T>(value: T): T;
