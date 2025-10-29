import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "../../../lib/trpc.ts";
import { Button } from "../../../components/ui/button.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";

type OnboardingConfirmOrgStepProps = {
  organizationId: string;
  organizationName: string;
  onComplete: () => void;
};

export function OnboardingConfirmOrgStep({
  organizationId,
  organizationName,
  onComplete,
}: OnboardingConfirmOrgStepProps) {
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

  return (
    <OnboardingStepLayout
      stepText="Step 1 of 2"
      title="Confirm your organization name"
      description="This will be shown to your team members. You can change it later in settings."
    >
      <form
        className="w-full max-w-md space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (name.trim() !== organizationName) {
            await updateOrg.mutateAsync({ organizationId, name: name.trim() });
          }
          onComplete();
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={updateOrg.isPending}
          placeholder="Your Organization Name"
          autoFocus
        />

        <div className="flex justify-end">
          <Button type="submit" disabled={updateOrg.isPending || !name.trim()}>
            Continue
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </form>
    </OnboardingStepLayout>
  );
}
