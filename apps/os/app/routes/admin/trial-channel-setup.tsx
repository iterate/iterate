import { useState } from "react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, CheckCircle2 } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "../../components/ui/field.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { useTRPC } from "../../lib/trpc.ts";
import type { Route } from "./+types/trial-channel-setup.ts";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Trial Channel Setup - Admin - Iterate" },
    { name: "description", content: "Manually create trial Slack Connect channels" },
  ];
}

export default function TrialChannelSetupPage() {
  const trpc = useTRPC();
  const { data: allEstates } = useSuspenseQuery(trpc.admin.listAllEstates.queryOptions());

  const [userEmail, setUserEmail] = useState("");
  const [userName, setUserName] = useState("");
  const [createNewEstate, setCreateNewEstate] = useState(true);
  const [existingEstateId, setExistingEstateId] = useState("");
  const [estateName, setEstateName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [lastCreatedChannel, setLastCreatedChannel] = useState<{
    channelName: string;
    estateId: string;
  } | null>(null);

  const createChannelMutation = useMutation({
    ...trpc.admin.createTrialSlackChannel.mutationOptions({}),
    onSuccess: (data) => {
      toast.success(`Trial channel created: #${data.channelName}`);
      setLastCreatedChannel({
        channelName: data.channelName,
        estateId: data.estateId,
      });
      // Reset form
      setUserEmail("");
      setUserName("");
      setEstateName("");
      setOrganizationName("");
      setCreateNewEstate(true);
      setExistingEstateId("");
    },
    onError: (error) => {
      toast.error(`Failed to create trial channel: ${error.message}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!userEmail) {
      toast.error("User email is required");
      return;
    }

    if (!createNewEstate && !existingEstateId) {
      toast.error("Please select an existing estate or create a new one");
      return;
    }

    createChannelMutation.mutate({
      userEmail,
      userName: userName || undefined,
      createNewEstate,
      existingEstateId: createNewEstate ? undefined : existingEstateId,
      estateName: createNewEstate && estateName ? estateName : undefined,
      organizationName: createNewEstate && organizationName ? organizationName : undefined,
    });
  };

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Trial Channel Setup (Admin)</h1>
        <p className="text-muted-foreground mt-2">
          Manually create Slack Connect trial channels for users
        </p>
      </div>

      {lastCreatedChannel && (
        <Card className="border-green-500/50 bg-green-50 dark:bg-green-950/20">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5" />
              <div className="flex-1">
                <div className="font-medium text-green-900 dark:text-green-100">
                  Channel created successfully
                </div>
                <div className="text-sm text-green-700 dark:text-green-300 mt-1">
                  Channel:{" "}
                  <code className="bg-green-100 dark:bg-green-900/50 px-1 py-0.5 rounded">
                    #{lastCreatedChannel.channelName}
                  </code>
                  {" • "}
                  Estate:{" "}
                  <code className="bg-green-100 dark:bg-green-900/50 px-1 py-0.5 rounded">
                    {lastCreatedChannel.estateId}
                  </code>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Create Trial Channel</CardTitle>
          <CardDescription>
            This will create a Slack Connect channel in iterate's workspace and set up routing to a
            user's estate.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <FieldSet>
                <Field>
                  <FieldLabel htmlFor="user-email">User Email *</FieldLabel>
                  <Input
                    id="user-email"
                    type="email"
                    placeholder="user@example.com"
                    value={userEmail}
                    onChange={(e) => setUserEmail(e.target.value)}
                    required
                  />
                  <FieldDescription>
                    Email address to send the Slack Connect invite to. Must be associated with a
                    Slack account.
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="user-name">User Name</FieldLabel>
                  <Input
                    id="user-name"
                    type="text"
                    placeholder="John Doe"
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                  />
                  <FieldDescription>
                    Optional. Used for naming the organization and estate. Defaults to email prefix
                    if not provided.
                  </FieldDescription>
                </Field>

                <Field orientation="horizontal">
                  <Checkbox
                    id="create-new-estate"
                    checked={createNewEstate}
                    onCheckedChange={(checked) => setCreateNewEstate(checked === true)}
                  />
                  <FieldLabel htmlFor="create-new-estate" className="font-normal">
                    Create new organization and estate
                  </FieldLabel>
                </Field>

                {createNewEstate ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor="organization-name">Organization Name</FieldLabel>
                      <Input
                        id="organization-name"
                        type="text"
                        placeholder="John Doe's Organization"
                        value={organizationName}
                        onChange={(e) => setOrganizationName(e.target.value)}
                      />
                      <FieldDescription>
                        Optional. Defaults to "{userName || userEmail}'s Organization"
                      </FieldDescription>
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="estate-name">Estate Name</FieldLabel>
                      <Input
                        id="estate-name"
                        type="text"
                        placeholder="John Doe's Estate"
                        value={estateName}
                        onChange={(e) => setEstateName(e.target.value)}
                      />
                      <FieldDescription>
                        Optional. Defaults to "{userName || userEmail}'s Estate"
                      </FieldDescription>
                    </Field>
                  </>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="existing-estate">Existing Estate</FieldLabel>
                    <Select value={existingEstateId} onValueChange={setExistingEstateId}>
                      <SelectTrigger id="existing-estate">
                        <SelectValue placeholder="Select an estate..." />
                      </SelectTrigger>
                      <SelectContent>
                        {allEstates.map((estate) => (
                          <SelectItem key={estate.id} value={estate.id}>
                            <div className="flex flex-col items-start">
                              <span>{estate.name}</span>
                              <span className="text-xs text-muted-foreground">
                                {estate.organizationName}
                              </span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      Select an existing estate to route the trial channel to
                    </FieldDescription>
                  </Field>
                )}

                <div className="pt-4">
                  <Button type="submit" disabled={createChannelMutation.isPending} size="lg">
                    {createChannelMutation.isPending ? (
                      <>Creating Channel...</>
                    ) : (
                      <>
                        <Plus className="mr-2 h-4 w-4" />
                        Create Trial Channel
                      </>
                    )}
                  </Button>
                </div>
              </FieldSet>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      <Card variant="muted">
        <CardHeader>
          <CardTitle>What This Does</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            1. <strong>Creates a channel</strong> in iterate's Slack workspace with name{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              trial-
              {userEmail ? userEmail.replace(/@/g, "-").replace(/\./g, "-") : "user-example-com"}
            </code>
          </p>
          <p>
            2. <strong>Sends Slack Connect invite</strong> to the specified email address
          </p>
          <p>
            3. <strong>Creates routing override</strong> so webhooks from that channel route to the
            user's estate
          </p>
          {createNewEstate && (
            <p>
              4. <strong>Creates new organization and estate</strong> owned by the user
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
