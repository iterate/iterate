import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Field, FieldLabel, FieldGroup, FieldDescription } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import { Button } from "@iterate-com/ui/components/button";
import { useState } from "react";
import { DockerDeploymentOptsForm, FlyDeploymentOptsForm } from "./-provider-opts-forms.tsx";
import { orpc, orpcClient } from "@/lib/orpc.ts";

const DOCKER_DEFAULTS: Record<string, unknown> = { image: "jonasland-sandbox:local" };
const FLY_DEFAULTS: Record<string, unknown> = { image: "", flyApiToken: "" };

export const Route = createFileRoute("/_app/deployments/new")({
  component: NewDeployment,
});

function NewDeployment() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [provider, setProvider] = useState<"docker" | "fly" | "">("");
  const [slug, setSlug] = useState("");
  const [opts, setOpts] = useState<Record<string, unknown>>(DOCKER_DEFAULTS);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleProviderChange(next: "docker" | "fly") {
    setProvider(next);
    setOpts(next === "docker" ? { ...DOCKER_DEFAULTS } : { ...FLY_DEFAULTS });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!provider || !slug) return;

    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const normalizedOpts =
        provider === "docker"
          ? {
              providerOpts: {},
              opts,
            }
          : splitFlyOpts(opts);
      await orpcClient.deployments.create({
        provider,
        slug,
        opts: JSON.stringify(normalizedOpts),
      });
      queryClient.invalidateQueries({ queryKey: orpc.deployments.list.key() });
      navigate({ to: "/deployments/$slug", params: { slug } });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-4 text-2xl font-bold">New Deployment</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="provider">Provider</FieldLabel>
            <Select
              name="provider"
              value={provider}
              onValueChange={(v) => handleProviderChange(v as "docker" | "fly")}
            >
              <SelectTrigger id="provider">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="docker">Docker</SelectItem>
                <SelectItem value="fly">Fly.io</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>Where this deployment will run.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="slug">Slug</FieldLabel>
            <Input
              id="slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="my-deployment"
              autoComplete="off"
            />
            <FieldDescription>
              Unique identifier. Lowercase letters, numbers, and hyphens.
            </FieldDescription>
          </Field>
        </FieldGroup>

        {provider === "docker" && <DockerDeploymentOptsForm value={opts} onChange={setOpts} />}

        {provider === "fly" && <FlyDeploymentOptsForm value={opts} onChange={setOpts} />}

        {submitError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {submitError}
          </div>
        )}

        <Button type="submit" disabled={!provider || !slug || isSubmitting}>
          {isSubmitting ? "Creating..." : "Create Deployment"}
        </Button>
      </form>
    </div>
  );
}

function splitFlyOpts(value: Record<string, unknown>) {
  const { flyApiToken, flyApiBaseUrl, ...opts } = value;
  return {
    providerOpts: {
      ...(typeof flyApiToken === "string" && flyApiToken.length > 0 ? { flyApiToken } : {}),
      ...(typeof flyApiBaseUrl === "string" && flyApiBaseUrl.length > 0 ? { flyApiBaseUrl } : {}),
    },
    opts,
  };
}
