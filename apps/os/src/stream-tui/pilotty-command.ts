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
    "pnpm",
    "--dir",
    "apps/os",
    "cli",
    "stream-tui",
    "--project-slug-or-id",
    args.projectSlugOrId,
    "--stream-path",
    args.streamPath,
  ];
}
