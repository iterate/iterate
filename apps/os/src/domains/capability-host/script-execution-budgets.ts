// Reserve time after worker execution for the capability host to durably
// journal the one terminal settlement for its script obligation.
export const SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS = 15_000;

// Sessionless sandbox exec can spend up to six seconds terminating and
// verifying a process group after its command timeout. Keep a larger reserve
// for that cleanup plus Workers RPC propagation.
export const SCRIPT_EXTERNAL_CLEANUP_GRACE_MS = 15_000;

// Time for an already-committed completion to traverse the processor before
// the public RPC gives up. This never extends the execution deadline.
export const SCRIPT_COMPLETION_OBSERVATION_GRACE_MS = 15_000;
