import { WorkerEntrypoint } from "cloudflare:workers";

import { FakeIterateCapability } from "./capability.ts";

type FakeCapabilityAuth =
  | {
      type: "admin-api-secret";
    }
  | {
      projects: string[];
      type: "iterate-auth";
      userId: string;
    };

export type FakeIterateEntrypointProps = {
  auth: FakeCapabilityAuth;
};

export class FakeIterateEntrypoint extends WorkerEntrypoint<Env, FakeIterateEntrypointProps> {
  get context() {
    return new FakeIterateCapability({
      auth: this.ctx.props.auth,
      env: this.env,
    });
  }
}
