/**
 * Send one agent message without exposing the append result to a feed writer.
 *
 * `agent.message()` resolves to the committed event, but that single tail
 * event can arrive before earlier connection events. The ordered,
 * replay-capable event connection is therefore the only live feed authority; the
 * mutation owns send lifecycle and errors only, matching the browser chat.
 */
export async function sendAgentMessage(
  agent: { message(message: string): PromiseLike<unknown> },
  message: string,
): Promise<void> {
  await agent.message(message);
}
