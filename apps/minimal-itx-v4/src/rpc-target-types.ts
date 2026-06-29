export type CfExecutionContext = {
  exports: ExecutionContext["exports"];
};

type RpcTargetResult<T> =
  | T
  | Promise<T>
  | (T extends object ? RpcTargetImplementation<T> : never)
  | (T extends object ? Promise<RpcTargetImplementation<T>> : never);

export type RpcTargetImplementation<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => RpcTargetResult<Awaited<Result>>
    : RpcTargetResult<T[K]>;
};
