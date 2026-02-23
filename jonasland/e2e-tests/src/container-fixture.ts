import { decodeDockerMultiplexedStream, dockerApi, dockerApiRaw } from "./docker-api.ts";

export interface StartedContainer {
  id: string;
  hostPorts: Record<string, number>;
}

export async function startSandboxContainer(params: {
  image: string;
  name: string;
  env?: string[];
}): Promise<StartedContainer> {
  const hostPorts: Record<string, number> = {
    "4646/tcp": 14646,
    "8500/tcp": 18500,
    "2019/tcp": 12019,
    "80/tcp": 18080,
    "443/tcp": 18443,
  };

  const exposedPorts = {
    "4646/tcp": {},
    "8500/tcp": {},
    "2019/tcp": {},
    "80/tcp": {},
    "443/tcp": {},
  };

  const hostConfig = {
    CapAdd: ["NET_ADMIN", "SYS_ADMIN"],
    CgroupnsMode: "host",
    Binds: ["/sys/fs/cgroup:/sys/fs/cgroup:rw"],
    PortBindings: {
      "4646/tcp": [{ HostPort: String(hostPorts["4646/tcp"]) }],
      "8500/tcp": [{ HostPort: String(hostPorts["8500/tcp"]) }],
      "2019/tcp": [{ HostPort: String(hostPorts["2019/tcp"]) }],
      "80/tcp": [{ HostPort: String(hostPorts["80/tcp"]) }],
      "443/tcp": [{ HostPort: String(hostPorts["443/tcp"]) }],
    },
    ExtraHosts: ["host.docker.internal:host-gateway"],
  };

  const createResponse = await dockerApi<{ Id: string }>({
    method: "POST",
    endpoint: `/containers/create?name=${encodeURIComponent(params.name)}`,
    body: {
      Image: params.image,
      Env: params.env ?? [],
      ExposedPorts: exposedPorts,
      HostConfig: hostConfig,
    },
  });

  await dockerApi({
    method: "POST",
    endpoint: `/containers/${createResponse.Id}/start`,
    body: {},
  });

  return { id: createResponse.Id, hostPorts };
}

export async function stopAndRemoveContainer(containerId: string): Promise<void> {
  await dockerApi({
    method: "POST",
    endpoint: `/containers/${containerId}/stop?t=3`,
    body: {},
  }).catch(() => {});
  await dockerApi({ method: "DELETE", endpoint: `/containers/${containerId}?force=1` }).catch(
    () => {},
  );
}

export async function getContainerLogs(containerId: string): Promise<string> {
  const bytes = await dockerApiRaw({
    method: "GET",
    endpoint: `/containers/${containerId}/logs?stdout=true&stderr=true&timestamps=true`,
  });
  return decodeDockerMultiplexedStream(bytes);
}
