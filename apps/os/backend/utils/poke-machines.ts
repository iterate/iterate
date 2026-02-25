/**
 * Re-export pushEnvToRunningMachines as the public API for pushing env updates to machines.
 * All callers that previously used `pokeRunningMachinesToRefresh` should use this —
 * the function signature is compatible (db, projectId, env).
 */
export { pushEnvToRunningMachines as pokeRunningMachinesToRefresh } from "../services/machine-setup.ts";
