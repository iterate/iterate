import { DurableObject } from "cloudflare:workers";

type FakeEventInput = {
  payload: Record<string, string>;
  type: string;
};

type FakeEventRecord = FakeEventInput & {
  offset: number;
};

type FakeProjectEnv = Env & {
  FAKE_STREAM: DurableObjectNamespace<FakeStreamDurableObject>;
};

export class FakeProjectDurableObject extends DurableObject<FakeProjectEnv> {
  async appendInternalProjectEvent(event: FakeEventInput): Promise<{ appended: FakeEventRecord }> {
    return {
      appended: await this.env.FAKE_STREAM.getByName(`${this.projectId}:/`).append(event),
    };
  }

  private get projectId() {
    return this.ctx.id.name!;
  }
}

export class FakeStreamDurableObject extends DurableObject<Env> {
  async append(event: FakeEventInput): Promise<FakeEventRecord> {
    const events = await this.read();
    const record = {
      ...event,
      offset: events.length,
    };
    await this.ctx.storage.put("events", [...events, record]);
    return record;
  }

  async read(): Promise<FakeEventRecord[]> {
    return (await this.ctx.storage.get<FakeEventRecord[]>("events")) ?? [];
  }
}
