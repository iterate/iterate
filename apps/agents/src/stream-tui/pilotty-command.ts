export type StreamTuiPilottySpawnArgs = {
  sessionName: string;
  cwd: string;
  projectSlug: string;
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
    "apps/agents",
    "cli",
    "stream-tui",
    "--project-slug",
    args.projectSlug,
    "--stream-path",
    args.streamPath,
  ];
}
