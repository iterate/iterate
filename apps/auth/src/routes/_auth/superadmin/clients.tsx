import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Input } from "@iterate-com/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@iterate-com/ui";
import { Separator } from "@iterate-com/ui/components/separator";
import { Label } from "@iterate-com/ui";
import { toast } from "sonner";
import type { OAuthClientRecord } from "@iterate-com/auth-contract";
import { orpc } from "../../../utils/query.tsx";
import { InfoRow } from "../../../utils/info-row.tsx";

export const Route = createFileRoute("/_auth/superadmin/clients")({
  component: ClientsPage,
});

function ClientsPage() {
  const listClientsQuery = useQuery(orpc.superadmin.oauth.listClients.queryOptions());

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        <CreateClientForm />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">OAuth clients</CardTitle>
          </CardHeader>
          <Separator />
          <CardContent>
            {listClientsQuery.isPending ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : listClientsQuery.data?.length === 0 ? (
              <p className="text-sm text-muted-foreground">No OAuth clients yet.</p>
            ) : (
              <div className="space-y-3">
                {listClientsQuery.data?.map((client) => (
                  <ClientRow key={client.clientId} client={client} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CreateClientForm() {
  const [clientName, setClientName] = useState("");
  const [redirectURIs, setRedirectURIs] = useState("");
  const listClientsQuery = useQuery(orpc.superadmin.oauth.listClients.queryOptions());

  const createClientMutation = useMutation(
    orpc.superadmin.oauth.createClient.mutationOptions({
      onSuccess: () => {
        toast.success("OAuth client created");
        setClientName("");
        setRedirectURIs("");
        listClientsQuery.refetch();
      },
    }),
  );

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create OAuth client</CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="clientName">Client name</Label>
            <Input
              id="clientName"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="My App"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="redirectURIs">Redirect URIs (comma separated)</Label>
            <textarea
              id="redirectURIs"
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={redirectURIs}
              onChange={(e) => setRedirectURIs(e.target.value)}
              placeholder={"https://example.com/callback"}
            />
          </div>
          <Button
            className="w-full"
            disabled={createClientMutation.isPending || !clientName || !redirectURIs}
            onClick={() =>
              createClientMutation.mutate({
                clientName,
                redirectURIs: redirectURIs.split(",").map((uri) => uri.trim()),
              })
            }
          >
            {createClientMutation.isPending ? "Creating..." : "Create client"}
          </Button>
        </CardContent>
      </Card>

      {createClientMutation.data && (
        <Card className="border-green-500/50">
          <CardHeader>
            <CardTitle className="text-base">Client created</CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="space-y-2">
            <InfoRow label="Client ID" value={createClientMutation.data.clientId} selectable />
            <InfoRow
              label="Client secret"
              value={createClientMutation.data.clientSecret}
              selectable
            />
            <p className="text-xs text-muted-foreground">
              Copy the client secret now — it won't be shown again.
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function ClientRow({ client }: { client: Omit<OAuthClientRecord, "clientSecret"> }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{client.clientName}</p>
        <p className="truncate text-xs text-muted-foreground font-mono">
          Client ID: {client.clientId}
        </p>

        <p className="truncate text-xs text-muted-foreground font-mono">
          Redirect URIs: {client.redirectURIs.join(", ")}
        </p>
      </div>
    </div>
  );
}
