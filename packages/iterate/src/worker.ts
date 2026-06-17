import { WorkerEntrypoint } from "cloudflare:workers";
import { defineIterateProjectEntrypoint } from "./worker-shared.ts";

export type {
  IterateProjectEnv,
  IterateProjectEventInput,
  IterateProjectStreams,
  IterateStreamAppendInput,
} from "./worker-shared.ts";

const IterateProjectEntrypointBase = defineIterateProjectEntrypoint(WorkerEntrypoint);

export class IterateProjectEntrypoint extends IterateProjectEntrypointBase {}
