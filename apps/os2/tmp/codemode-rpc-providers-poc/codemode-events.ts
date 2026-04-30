export const CodemodeEventType = {
  toolProviderRegistered: "events.iterate.com/codemode/tool-provider-registered",
  scriptExecutionRequested: "events.iterate.com/codemode/script-execution-requested",
  scriptExecutionSucceeded: "events.iterate.com/codemode/script-execution-succeeded",
  scriptExecutionFailed: "events.iterate.com/codemode/script-execution-failed",
  toolFunctionCallRequested: "events.iterate.com/codemode/tool-function-call-requested",
  toolFunctionCallSucceeded: "events.iterate.com/codemode/tool-function-call-succeeded",
  toolFunctionCallFailed: "events.iterate.com/codemode/tool-function-call-failed",
  logEmitted: "events.iterate.com/codemode/log-emitted",
} as const;

export type CodemodeEventType = (typeof CodemodeEventType)[keyof typeof CodemodeEventType];

export function createCallId() {
  return `call_${crypto.randomUUID()}`;
}
