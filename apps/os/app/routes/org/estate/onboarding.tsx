import { useState } from "react";
import { redirect, useLoaderData, useNavigate } from "react-router";
import { ArrowRight } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../backend/db/client.ts";
import * as schema from "../../../../backend/db/schema.ts";
import { isEstateOnboardingRequired } from "../../../../backend/onboarding-utils.ts";
import { Button } from "../../../components/ui/button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { Card, CardContent } from "../../../components/ui/card.tsx";
import { useTRPC } from "../../../lib/trpc.ts";

export async function loader({
  params,
}: {
  params: { organizationId?: string; estateId?: string };
}) {
  const { estateId, organizationId } = params;
  if (!estateId || !organizationId) throw redirect("/");

  const db = getDb();
  const required = await isEstateOnboardingRequired(db, estateId);
  if (!required) throw redirect(`/${organizationId}/${estateId}`);

  const organization = await db.query.organization.findFirst({
    where: eq(schema.organization.id, organizationId),
  });
  if (!organization) throw new Error("Organization not found");

  return { organization, estateId, organizationId } as const;
}

function ConfirmOrgNameStep({
  organizationId,
  estateId,
  organizationName,
  onComplete,
}: {
  organizationId: string;
  estateId: string;
  organizationName: string;
  onComplete: () => void;
}) {
  const trpc = useTRPC();
  const [name, setName] = useState(organizationName);

  const updateOrg = useMutation(
    trpc.organization.updateName.mutationOptions({
      onSuccess: () => {
        toast.success("Organization name updated");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const completeStep = useMutation(
    trpc.estate.completeUserOnboardingStep.mutationOptions({
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Confirm your organization name</h2>
        <p className="text-muted-foreground">
          This will be shown to your team members. You can change it later in settings.
        </p>
      </div>

      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (name.trim() !== organizationName) {
            await updateOrg.mutateAsync({ organizationId, name: name.trim() });
          }
          await completeStep.mutateAsync(
            { estateId, step: "confirm_org_name" },
            { onSuccess: onComplete },
          );
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={updateOrg.isPending || completeStep.isPending}
          placeholder="Your Organization Name"
          autoFocus
        />

        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={updateOrg.isPending || completeStep.isPending || !name.trim()}
          >
            Continue
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </form>
    </div>
  );
}

// No other user steps for now

export default function EstateOnboarding() {
  const { organization, estateId, organizationId } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const handleOnboardingComplete = () => {
    navigate(`/${organizationId}/${estateId}`);
  };

  const stepComponent = (
    <ConfirmOrgNameStep
      organizationId={organizationId}
      estateId={estateId}
      organizationName={organization.name}
      onComplete={handleOnboardingComplete}
    />
  );

  return (
    <div className="min-h-screen flex items-center justify-center p-4 md:p-8">
      <Card className="w-full max-w-2xl">
        <CardContent className="p-8 md:p-12">
          <div className="mb-8">
            <h1 className="text-3xl font-semibold">Complete your setup</h1>
          </div>
          {stepComponent}
        </CardContent>
      </Card>
    </div>
  );
}
