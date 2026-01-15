import { useState, type FormEvent } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { KeyRound, Copy, CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../../lib/trpc.tsx";
import { EmptyState } from "../../../components/empty-state.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Field, FieldGroup, FieldLabel, FieldSet } from "../../../components/ui/field.tsx";
import { Input } from "../../../components/ui/input.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card.tsx";
export const Route = createFileRoute(
  "/_auth/orgs/$organizationSlug/projects/$projectSlug/access-tokens",
)({
  beforeLoad: async ({ context, params }) => {
    // Preload access tokens to avoid suspense
    await context.queryClient.ensureQueryData(
      trpc.accessToken.list.queryOptions({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
      }),
    );
  },
  component: ProjectAccessTokensPage,
});

function ProjectAccessTokensPage() {
  const params = useParams({
    from: "/_auth/orgs/$organizationSlug/projects/$projectSlug/access-tokens",
  });
  const [name, setName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: tokens } = useSuspenseQuery(
    trpc.accessToken.list.queryOptions({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
    }),
  );

  const createToken = useMutation({
    mutationFn: async (tokenName: string) => {
      return trpcClient.accessToken.create.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        name: tokenName,
      });
    },
    onSuccess: (data) => {
      setName("");
      setNewToken(data.token);
      toast.success("Access token created!");
    },
    onError: (error) => {
      toast.error("Failed to create access token: " + error.message);
    },
  });

  const revokeToken = useMutation({
    mutationFn: async (tokenId: string) => {
      return trpcClient.accessToken.revoke.mutate({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        id: tokenId,
      });
    },
    onSuccess: () => {
      toast.success("Access token revoked!");
    },
    onError: (error) => {
      toast.error("Failed to revoke access token: " + error.message);
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      createToken.mutate(name.trim());
    }
  };

  const handleCopyToken = async () => {
    if (newToken) {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Token copied to clipboard!");
    }
  };

  const handleDismissToken = () => {
    setNewToken(null);
    setCopied(false);
  };

  return (
    <div className="p-4 space-y-6">
      {newToken && (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader>
            <CardTitle className="text-amber-900">Save your token</CardTitle>
            <CardDescription className="text-amber-800">
              This token will only be shown once. Make sure to copy it now as you won't be able to
              see it again.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input value={newToken} readOnly className="font-mono text-sm bg-white" />
              <Button onClick={handleCopyToken} variant="outline">
                {copied ? <CheckCheck className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <Button onClick={handleDismissToken} variant="outline" size="sm">
              I've saved it
            </Button>
          </CardContent>
        </Card>
      )}

      <form onSubmit={handleSubmit}>
        <FieldGroup>
          <FieldSet>
            <Field>
              <FieldLabel htmlFor="token-name">Token name</FieldLabel>
              <Input
                id="token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My API Token"
                disabled={createToken.isPending}
                autoFocus
              />
            </Field>
          </FieldSet>
          <Field orientation="horizontal">
            <Button type="submit" disabled={!name.trim() || createToken.isPending}>
              {createToken.isPending ? "Creating..." : "Create token"}
            </Button>
          </Field>
        </FieldGroup>
      </form>

      {tokens && tokens.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((token) => (
              <TableRow key={token.id}>
                <TableCell className="font-medium">{token.name}</TableCell>
                <TableCell>
                  {token.revokedAt ? (
                    <Badge variant="outline" className="text-muted-foreground">
                      Revoked
                    </Badge>
                  ) : (
                    <Badge variant="default">Active</Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(token.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleDateString() : "Never"}
                </TableCell>
                <TableCell>
                  {!token.revokedAt && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => revokeToken.mutate(token.id)}
                      disabled={revokeToken.isPending}
                    >
                      Revoke
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyState
          icon={<KeyRound className="h-12 w-12" />}
          title="No access tokens"
          description="Create tokens to access this project programmatically."
        />
      )}
    </div>
  );
}
