export type StreamTuiPilottySpawnArgs = {
  sessionName: string;
  cwd: string;
  projectSlugOrId: string;
  streamPath: string;
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
    "--project-slug-or-id",
    args.projectSlugOrId,
    "--stream-path",
    args.streamPath,
  ];
}
