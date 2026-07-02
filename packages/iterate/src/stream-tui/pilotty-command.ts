export type StreamTuiPilottySpawnArgs = {
  sessionName: string;
  cwd: string;
  projectId: string;
  agentPath: string;
};

export function buildStreamTuiPilottySpawnArgs(args: StreamTuiPilottySpawnArgs) {
  return [
    "spawn",
    "--name",
    args.sessionName,
    "--cwd",
    args.cwd,
    "node",
    "packages/iterate/bin/iterate.js",
    "chat",
    "--project",
    args.projectId,
    "--agent-path",
    args.agentPath,
  ];
}
