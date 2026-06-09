import { RpcTarget } from "cloudflare:workers";

import type { FakeStreamDurableObject } from "./durable-object.ts";

type FakeEventInput = {
  payload: Record<string, string>;
  type: string;
};

type FakeEventRecord = FakeEventInput & {
  offset: number;
};

type FakePrototypeEnv = Env & {
  FAKE_STREAM: DurableObjectNamespace<FakeStreamDurableObject>;
};

type FakeCapabilityAuth =
  | {
      type: "admin-api-secret";
    }
  | {
      projects: string[];
      type: "iterate-auth";
      userId: string;
    };

export class FakeIterateCapability extends RpcTarget {
  constructor(
    private readonly input: {
      auth: FakeCapabilityAuth;
      env: FakePrototypeEnv;
    },
  ) {
    super();
  }

  get projects() {
    return new FakeProjectsCapability(this.input);
  }
}

export class FakeProjectsCapability extends RpcTarget {
  constructor(
    private readonly input: {
      auth: FakeCapabilityAuth;
      env: FakePrototypeEnv;
    },
  ) {
    super();
  }

  get(projectId: string) {
    if (
      this.input.auth.type !== "admin-api-secret" &&
      !this.input.auth.projects.includes(projectId)
    ) {
      throw new Error(`Missing project authority for ${projectId}`);
    }

    return new FakeProjectCapability({
      auth: this.input.auth,
      env: this.input.env,
      projectId,
    });
  }
}

export class FakeProjectCapability extends RpcTarget {
  constructor(
    private readonly input: {
      auth: FakeCapabilityAuth;
      env: FakePrototypeEnv;
      projectId: string;
    },
  ) {
    super();
  }

  get streams() {
    return new FakeProjectStreamsCapability({
      auth: this.input.auth,
      env: this.input.env,
      namespace: this.input.projectId,
    });
  }

  describe() {
    return { id: this.input.projectId };
  }
}

export class FakeProjectStreamsCapability extends RpcTarget {
  constructor(
    private readonly input: {
      auth: FakeCapabilityAuth;
      env: FakePrototypeEnv;
      namespace: string;
    },
  ) {
    super();
  }

  get(path: string) {
    return new FakeStreamCapability({
      auth: this.input.auth,
      env: this.input.env,
      namespace: this.input.namespace,
      path,
    });
  }
}

export class FakeStreamCapability extends RpcTarget {
  constructor(
    private readonly input: {
      auth: FakeCapabilityAuth;
      env: FakePrototypeEnv;
      namespace: string;
      path: string;
    },
  ) {
    super();
  }

  append(event: FakeEventInput): Promise<FakeEventRecord> {
    return this.stream().append(event);
  }

  describe() {
    return {
      namespace: this.input.namespace,
      path: this.input.path,
    };
  }

  read(): Promise<FakeEventRecord[]> {
    return this.stream().read();
  }

  private stream() {
    return this.input.env.FAKE_STREAM.getByName(`${this.input.namespace}:${this.input.path}`);
  }
}
