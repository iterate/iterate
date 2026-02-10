type AgentLifecycleEvent =
  | { type: "ack"; agentPath: string }
  | { type: "status"; agentPath: string; status: string }
  | { type: "unack"; agentPath: string };

type AgentLifecycleListener = (event: AgentLifecycleEvent) => void;

const listenersByAgentPath = new Map<string, Set<AgentLifecycleListener>>();

export function publishAgentLifecycleEvent(event: AgentLifecycleEvent): void {
  const listeners = listenersByAgentPath.get(event.agentPath);
  if (!listeners || listeners.size === 0) return;
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribeAgentLifecycle(
  agentPath: string,
  listener: AgentLifecycleListener,
): () => void {
  const listeners = listenersByAgentPath.get(agentPath) ?? new Set<AgentLifecycleListener>();
  listeners.add(listener);
  listenersByAgentPath.set(agentPath, listeners);

  return () => {
    const current = listenersByAgentPath.get(agentPath);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listenersByAgentPath.delete(agentPath);
    }
  };
}

export type { AgentLifecycleEvent };
