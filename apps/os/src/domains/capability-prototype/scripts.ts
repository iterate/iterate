import type { RpcStub } from "capnweb";

import type { FakeIterateCapability } from "./capability.ts";

export type PrototypeScriptInput = {
  ctx: RpcStub<FakeIterateCapability>;
  env: {
    ITERATE: {
      context: Promise<RpcStub<FakeIterateCapability>> | RpcStub<FakeIterateCapability>;
    };
  };
  vars: {
    eventType: string;
    marker: string;
    projectId: string;
    streamPath: string;
  };
};

export type PrototypeScriptResult = {
  appended: {
    marker: string;
    projectId: string;
    source: string;
    streamPath: string;
    type: string;
  };
  project: {
    id: string;
  };
  readBack: Array<{
    marker: string;
    source: string;
    type: string;
  }>;
};

export type PrototypeScript = (input: PrototypeScriptInput) => Promise<PrototypeScriptResult>;

export const appendAndReadViaRoot: PrototypeScript = async ({ ctx, vars }) => {
  const project = ctx.projects.get(vars.projectId);
  const stream = project.streams.get(vars.streamPath);
  const appended = await stream.append({
    payload: { marker: vars.marker, source: "root-ctx" },
    type: vars.eventType,
  });
  const projectDescription = await project.describe();
  const streamDescription = await stream.describe();
  const readBack = await stream.read();

  return {
    appended: {
      marker: appended.payload.marker,
      projectId: projectDescription.id,
      source: appended.payload.source,
      streamPath: streamDescription.path,
      type: appended.type,
    },
    project: projectDescription,
    readBack: readBack.map((event) => ({
      marker: event.payload.marker,
      source: event.payload.source,
      type: event.type,
    })),
  };
};

export const appendAndReadViaDynamicWorkerEnv: PrototypeScript = async ({ env, vars }) => {
  const ctx = await env.ITERATE.context;
  const project = ctx.projects.get(vars.projectId);
  const stream = project.streams.get(vars.streamPath);
  const appended = await stream.append({
    payload: { marker: vars.marker, source: "dynamic-worker-env" },
    type: vars.eventType,
  });
  const projectDescription = await project.describe();
  const streamDescription = await stream.describe();
  const readBack = await stream.read();

  return {
    appended: {
      marker: appended.payload.marker,
      projectId: projectDescription.id,
      source: appended.payload.source,
      streamPath: streamDescription.path,
      type: appended.type,
    },
    project: projectDescription,
    readBack: readBack.map((event) => ({
      marker: event.payload.marker,
      source: event.payload.source,
      type: event.type,
    })),
  };
};
