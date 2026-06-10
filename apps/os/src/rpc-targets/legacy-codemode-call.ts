/**
 * The wire shape of the retired codemode function-call dispatch. Capability
 * entrypoints keep accepting it while callers migrate to the itx path-call
 * (`call({ path, args })`); new code should never construct one.
 */
export type ExecuteCodemodeFunctionCallInput = {
  args: unknown[];
  codemodeSessionCapability?: unknown;
  functionCallId: string;
  functionPath: string[];
  invocationKind: "rpc";
  path: string[];
  providerPath: string[];
  scriptExecutionId?: string;
};
