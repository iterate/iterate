export function isProjectStreamFeedPending(input: {
  agentFeed: boolean;
  agentUiState: object | null;
  connectionStatus: string;
}): boolean {
  // Agent state is replayed separately from the transport subscription. The
  // socket can report "subscribed" one paint before that replay arrives; keep
  // the loading surface during that gap instead of flashing an empty feed.
  // Once an agent snapshot exists, keep showing it through reconnects.
  if (input.agentFeed) return input.agentUiState === null;
  return input.connectionStatus !== "subscribed";
}
