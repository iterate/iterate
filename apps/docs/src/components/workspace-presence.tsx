import { authorColor } from "@iterate-com/workspace-documents/collab";

/** Everyone viewing this workspace surface, with your own session first. */
export function WorkspacePresence({
  self,
  clients,
}: {
  self: { clientId: string; name: string } | null;
  clients: { clientId: string; name: string }[];
}) {
  const everyone = self
    ? [self, ...clients.filter((client) => client.clientId !== self.clientId)]
    : clients;
  if (everyone.length === 0) return null;
  return (
    <div className="mr-1 flex items-center [&>span+span]:-ml-1.5">
      {everyone.slice(0, 6).map((client) => (
        <span
          key={client.clientId}
          title={client.name}
          style={{ borderColor: authorColor(client.clientId, 1) }}
          className="flex size-6 items-center justify-center rounded-full border-2 bg-background text-[10px] font-semibold uppercase"
        >
          {client.name.trim().slice(0, 1) || "?"}
        </span>
      ))}
      {everyone.length > 6 ? (
        <span className="pl-2 text-xs text-muted-foreground">+{everyone.length - 6}</span>
      ) : null}
    </div>
  );
}
