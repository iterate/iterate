import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { dockerDeploymentOptsSchema } from "@iterate-com/shared/jonasland/deployment/docker-deployment-manifest.ts";
import {
  flyDeploymentOptsSchema,
  flyProviderOptsSchema,
} from "@iterate-com/shared/jonasland/deployment/fly-deployment-manifest.ts";
import { DockerDeploymentConfig, FlyDeploymentConfig } from "@/deployment-config.ts";
import { orpc, orpcClient } from "@/lib/orpc.ts";
import { createDeploymentSchema } from "@/server/db/schema.ts";

const DOCKER_DEFAULTS = {
  image: "jonasland-sandbox:local",
  env: {
    DOCKER_HOST_SYNC_ENABLED: "true",
  },
} as const;

type Provider = "docker" | "fly";

type FormValues = {
  provider: Provider;
  slug: string;
  image: string;
  flyApiToken: string;
  flyApiBaseUrl: string;
  flyOrgSlug: string;
  flyRegion: string;
  flyMachineCpus: string;
  flyMachineMemoryMb: string;
  jsonOverrides: string;
};

type ConfigRemainder = {
  providerOpts: Record<string, unknown>;
  opts: Record<string, unknown>;
};

export const Route = createFileRoute("/_app/deployments/new")({
  component: NewDeployment,
});

function NewDeployment() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [configRemainder, setConfigRemainder] = useState(() =>
    createDefaultConfigRemainder("docker"),
  );

  const form = useForm({
    defaultValues: createDefaultValues("docker", "", createDefaultConfigRemainder("docker")),
    onSubmit: async ({ value }) => {
      setSubmitError(null);

      try {
        await orpcClient.deployments.create({
          provider: value.provider,
          slug: value.slug,
          opts: stringifyConfig(buildConfigFromValues(value, configRemainder)),
        });
        queryClient.invalidateQueries({ queryKey: orpc.deployments.list.key() });
        navigate({ to: "/deployments/$slug", params: { slug: value.slug } });
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : String(error));
      }
    },
  });

  const generatedJsonOverrides = stringifyConfig(
    buildConfigFromValues(form.state.values, configRemainder),
  );

  function replaceConfigFields(nextValues: FormValues) {
    form.setFieldValue("image", nextValues.image);
    form.setFieldValue("flyApiToken", nextValues.flyApiToken);
    form.setFieldValue("flyApiBaseUrl", nextValues.flyApiBaseUrl);
    form.setFieldValue("flyOrgSlug", nextValues.flyOrgSlug);
    form.setFieldValue("flyRegion", nextValues.flyRegion);
    form.setFieldValue("flyMachineCpus", nextValues.flyMachineCpus);
    form.setFieldValue("flyMachineMemoryMb", nextValues.flyMachineMemoryMb);
    form.setFieldValue("jsonOverrides", nextValues.jsonOverrides);
  }

  function syncStructuredField<K extends Exclude<keyof FormValues, "provider" | "jsonOverrides">>(
    name: K,
    nextValue: FormValues[K],
  ) {
    setSubmitError(null);
    const nextValues = { ...form.state.values, [name]: nextValue };
    const currentConfig = parseProviderConfig(
      form.state.values.provider,
      form.state.values.jsonOverrides,
    );
    const nextRemainder = currentConfig
      ? extractConfigRemainder(form.state.values.provider, currentConfig)
      : configRemainder;

    if (currentConfig) {
      setConfigRemainder(nextRemainder);
    }

    form.setFieldValue(
      "jsonOverrides",
      stringifyConfig(buildConfigFromValues(nextValues, nextRemainder)),
    );
  }

  function handleProviderChange(nextProvider: Provider) {
    setSubmitError(null);
    const nextRemainder = createDefaultConfigRemainder(nextProvider);
    setConfigRemainder(nextRemainder);
    replaceConfigFields(createDefaultValues(nextProvider, form.state.values.slug, nextRemainder));
  }

  function handleJsonOverridesChange(nextJson: string, provider: Provider) {
    setSubmitError(null);
    form.setFieldValue("jsonOverrides", nextJson);

    const parsedConfig = parseProviderConfig(provider, nextJson);
    if (!parsedConfig) return;

    const nextRemainder = extractConfigRemainder(provider, parsedConfig);
    setConfigRemainder(nextRemainder);
    replaceConfigFields(
      hydrateValuesFromConfig({
        slug: form.state.values.slug,
        provider,
        config: parsedConfig,
        configRemainder: nextRemainder,
        jsonOverrides: nextJson,
      }),
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-4 text-2xl font-bold">New Deployment</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
        className="space-y-6"
      >
        <FieldGroup>
          <form.Field name="provider">
            {(field) => {
              const isInvalid = shouldShowFieldError(
                form.state.submissionAttempts,
                field.state.meta,
              );

              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor="provider">Provider</FieldLabel>
                  <Select
                    name={field.name}
                    value={field.state.value}
                    onValueChange={(value) => {
                      field.handleChange(value as Provider);
                      handleProviderChange(value as Provider);
                    }}
                  >
                    <SelectTrigger id="provider" aria-invalid={isInvalid}>
                      <SelectValue placeholder="Select provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="docker">Docker</SelectItem>
                      <SelectItem value="fly">Fly.io</SelectItem>
                    </SelectContent>
                  </Select>
                  <FieldDescription>Where this deployment will run.</FieldDescription>
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              );
            }}
          </form.Field>

          <form.Field
            name="slug"
            validators={{
              onChange: createDeploymentSchema.shape.slug,
              onSubmit: createDeploymentSchema.shape.slug,
            }}
          >
            {(field) => {
              const isInvalid = shouldShowFieldError(
                form.state.submissionAttempts,
                field.state.meta,
              );

              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Slug</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => {
                      field.handleChange(e.target.value);
                      syncStructuredField("slug", e.target.value);
                    }}
                    aria-invalid={isInvalid}
                    placeholder="my-deployment"
                    autoComplete="off"
                  />
                  <FieldDescription>
                    Unique identifier. Lowercase letters, numbers, and hyphens.
                  </FieldDescription>
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              );
            }}
          </form.Field>
        </FieldGroup>

        <form.Subscribe selector={(state) => state.values.provider}>
          {(provider) => (
            <div className="space-y-4">
              <form.Field
                name="image"
                validators={{
                  onChange: provider === "docker" ? DockerImageField : FlyImageField,
                  onSubmit: provider === "docker" ? DockerImageField : FlyImageField,
                }}
              >
                {(field) => {
                  const isInvalid = shouldShowFieldError(
                    form.state.submissionAttempts,
                    field.state.meta,
                  );

                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Image</FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => {
                          field.handleChange(e.target.value);
                          syncStructuredField("image", e.target.value);
                        }}
                        aria-invalid={isInvalid}
                        placeholder={
                          provider === "docker"
                            ? "jonasland-sandbox:local"
                            : "registry.fly.io/my-app:latest"
                        }
                        autoComplete="off"
                      />
                      <FieldDescription>
                        {provider === "docker"
                          ? "Docker image to run locally."
                          : "Docker image to deploy on Fly."}
                      </FieldDescription>
                      {isInvalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  );
                }}
              </form.Field>

              {provider === "fly" && (
                <>
                  <form.Field
                    name="flyApiToken"
                    validators={{
                      onChange: FlyApiTokenField,
                      onSubmit: FlyApiTokenField,
                    }}
                  >
                    {(field) => {
                      const isInvalid = shouldShowFieldError(
                        form.state.submissionAttempts,
                        field.state.meta,
                      );

                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>Fly API Token</FieldLabel>
                          <Input
                            id={field.name}
                            name={field.name}
                            type="password"
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => {
                              field.handleChange(e.target.value);
                              syncStructuredField("flyApiToken", e.target.value);
                            }}
                            aria-invalid={isInvalid}
                            placeholder="FlyV1 fm2_..."
                            autoComplete="off"
                          />
                          <FieldDescription>
                            Required. Org or deploy token with FlyV1 prefix.
                          </FieldDescription>
                          {isInvalid && <FieldError errors={field.state.meta.errors} />}
                        </Field>
                      );
                    }}
                  </form.Field>

                  <form.Field
                    name="flyApiBaseUrl"
                    validators={{
                      onChange: FlyApiBaseUrlField,
                      onSubmit: FlyApiBaseUrlField,
                    }}
                  >
                    {(field) => {
                      const isInvalid = shouldShowFieldError(
                        form.state.submissionAttempts,
                        field.state.meta,
                      );

                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>Fly API Base URL</FieldLabel>
                          <Input
                            id={field.name}
                            name={field.name}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => {
                              field.handleChange(e.target.value);
                              syncStructuredField("flyApiBaseUrl", e.target.value);
                            }}
                            aria-invalid={isInvalid}
                            placeholder="https://api.fly.io"
                            autoComplete="off"
                          />
                          <FieldDescription>
                            Optional override for the Fly API endpoint.
                          </FieldDescription>
                          {isInvalid && <FieldError errors={field.state.meta.errors} />}
                        </Field>
                      );
                    }}
                  </form.Field>

                  <form.Field
                    name="flyOrgSlug"
                    validators={{
                      onChange: FlyOrgSlugField,
                      onSubmit: FlyOrgSlugField,
                    }}
                  >
                    {(field) => {
                      const isInvalid = shouldShowFieldError(
                        form.state.submissionAttempts,
                        field.state.meta,
                      );

                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>Org Slug</FieldLabel>
                          <Input
                            id={field.name}
                            name={field.name}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => {
                              field.handleChange(e.target.value);
                              syncStructuredField("flyOrgSlug", e.target.value);
                            }}
                            aria-invalid={isInvalid}
                            placeholder="iterate"
                            autoComplete="off"
                          />
                          <FieldDescription>Optional Fly organization slug.</FieldDescription>
                          {isInvalid && <FieldError errors={field.state.meta.errors} />}
                        </Field>
                      );
                    }}
                  </form.Field>

                  <form.Field
                    name="flyRegion"
                    validators={{
                      onChange: FlyRegionField,
                      onSubmit: FlyRegionField,
                    }}
                  >
                    {(field) => {
                      const isInvalid = shouldShowFieldError(
                        form.state.submissionAttempts,
                        field.state.meta,
                      );

                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>Region</FieldLabel>
                          <Input
                            id={field.name}
                            name={field.name}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => {
                              field.handleChange(e.target.value);
                              syncStructuredField("flyRegion", e.target.value);
                            }}
                            aria-invalid={isInvalid}
                            placeholder="lhr"
                            autoComplete="off"
                          />
                          <FieldDescription>Optional Fly region code.</FieldDescription>
                          {isInvalid && <FieldError errors={field.state.meta.errors} />}
                        </Field>
                      );
                    }}
                  </form.Field>

                  <div className="grid grid-cols-2 gap-4">
                    <form.Field
                      name="flyMachineCpus"
                      validators={{
                        onChange: FlyMachineCpusField,
                        onSubmit: FlyMachineCpusField,
                      }}
                    >
                      {(field) => {
                        const isInvalid = shouldShowFieldError(
                          form.state.submissionAttempts,
                          field.state.meta,
                        );

                        return (
                          <Field data-invalid={isInvalid}>
                            <FieldLabel htmlFor={field.name}>CPUs</FieldLabel>
                            <Input
                              id={field.name}
                              name={field.name}
                              type="number"
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(e) => {
                                field.handleChange(e.target.value);
                                syncStructuredField("flyMachineCpus", e.target.value);
                              }}
                              aria-invalid={isInvalid}
                              placeholder="4"
                            />
                            {isInvalid && <FieldError errors={field.state.meta.errors} />}
                          </Field>
                        );
                      }}
                    </form.Field>

                    <form.Field
                      name="flyMachineMemoryMb"
                      validators={{
                        onChange: FlyMachineMemoryMbField,
                        onSubmit: FlyMachineMemoryMbField,
                      }}
                    >
                      {(field) => {
                        const isInvalid = shouldShowFieldError(
                          form.state.submissionAttempts,
                          field.state.meta,
                        );

                        return (
                          <Field data-invalid={isInvalid}>
                            <FieldLabel htmlFor={field.name}>Memory (MB)</FieldLabel>
                            <Input
                              id={field.name}
                              name={field.name}
                              type="number"
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(e) => {
                                field.handleChange(e.target.value);
                                syncStructuredField("flyMachineMemoryMb", e.target.value);
                              }}
                              aria-invalid={isInvalid}
                              placeholder="4096"
                            />
                            {isInvalid && <FieldError errors={field.state.meta.errors} />}
                          </Field>
                        );
                      }}
                    </form.Field>
                  </div>
                </>
              )}

              <form.Field
                name="jsonOverrides"
                validators={{
                  onChange: makeJsonOverridesField(provider, generatedJsonOverrides),
                  onSubmit: makeJsonOverridesField(provider, generatedJsonOverrides),
                }}
              >
                {(field) => {
                  const isInvalid = shouldShowFieldError(
                    form.state.submissionAttempts,
                    field.state.meta,
                  );

                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>JSON Overrides</FieldLabel>
                      <Textarea
                        id={field.name}
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => {
                          field.handleChange(e.target.value);
                          handleJsonOverridesChange(e.target.value, provider);
                        }}
                        aria-invalid={isInvalid}
                        className="min-h-[100px] font-mono text-sm"
                        placeholder="{}"
                      />
                      <FieldDescription>
                        Edit the full config as JSON. Valid keys you add here are preserved across
                        structured edits.
                      </FieldDescription>
                      {isInvalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  );
                }}
              </form.Field>
            </div>
          )}
        </form.Subscribe>

        {submitError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {submitError}
          </div>
        )}

        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Creating..." : "Create Deployment"}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </div>
  );
}

const DockerImageField = makeOptionalStringField((value) =>
  dockerDeploymentOptsSchema.pick({ image: true }).safeParse(value === "" ? {} : { image: value }),
);

const FlyImageField = makeOptionalStringField((value) =>
  flyDeploymentOptsSchema.pick({ image: true }).safeParse(value === "" ? {} : { image: value }),
);

const FlyApiTokenField = z.string().superRefine((value, ctx) => {
  addZodIssues(
    ctx,
    flyProviderOptsSchema.pick({ flyApiToken: true }).safeParse({ flyApiToken: value }),
  );
});

const FlyApiBaseUrlField = makeOptionalStringField((value) =>
  flyProviderOptsSchema
    .pick({ flyApiBaseUrl: true })
    .safeParse(value === "" ? {} : { flyApiBaseUrl: value }),
);

const FlyOrgSlugField = makeOptionalStringField((value) =>
  flyDeploymentOptsSchema
    .pick({ flyOrgSlug: true })
    .safeParse(value === "" ? {} : { flyOrgSlug: value }),
);

const FlyRegionField = makeOptionalStringField((value) =>
  flyDeploymentOptsSchema
    .pick({ flyRegion: true })
    .safeParse(value === "" ? {} : { flyRegion: value }),
);

const FlyMachineCpusField = makeOptionalNumberField((value) =>
  flyDeploymentOptsSchema
    .pick({ flyMachineCpus: true })
    .safeParse(value === "" ? {} : { flyMachineCpus: Number(value) }),
);

const FlyMachineMemoryMbField = makeOptionalNumberField((value) =>
  flyDeploymentOptsSchema
    .pick({ flyMachineMemoryMb: true })
    .safeParse(value === "" ? {} : { flyMachineMemoryMb: Number(value) }),
);

function createDefaultValues(
  provider: Provider,
  slug: string,
  configRemainder: ConfigRemainder,
): FormValues {
  const values: FormValues = {
    provider,
    slug,
    image: provider === "docker" ? DOCKER_DEFAULTS.image : "",
    flyApiToken: "",
    flyApiBaseUrl: "",
    flyOrgSlug: "",
    flyRegion: "",
    flyMachineCpus: "",
    flyMachineMemoryMb: "",
    jsonOverrides: "",
  };

  return {
    ...values,
    jsonOverrides: stringifyConfig(buildConfigFromValues(values, configRemainder)),
  };
}

function createDefaultConfigRemainder(provider: Provider): ConfigRemainder {
  if (provider === "docker") {
    return {
      providerOpts: {},
      opts: {
        env: DOCKER_DEFAULTS.env,
      },
    };
  }

  return {
    providerOpts: {},
    opts: {},
  };
}

function buildConfigFromValues(values: FormValues, configRemainder: ConfigRemainder) {
  if (values.provider === "docker") {
    return {
      providerOpts: { ...configRemainder.providerOpts },
      opts: {
        ...configRemainder.opts,
        ...(values.image === "" ? {} : { image: values.image }),
      },
    };
  }

  return {
    providerOpts: {
      ...configRemainder.providerOpts,
      ...(values.flyApiToken === "" ? {} : { flyApiToken: values.flyApiToken }),
      ...(values.flyApiBaseUrl === "" ? {} : { flyApiBaseUrl: values.flyApiBaseUrl }),
    },
    opts: {
      ...configRemainder.opts,
      ...(values.image === "" ? {} : { image: values.image }),
      ...(values.flyOrgSlug === "" ? {} : { flyOrgSlug: values.flyOrgSlug }),
      ...(values.flyRegion === "" ? {} : { flyRegion: values.flyRegion }),
      ...(values.flyMachineCpus === "" ? {} : { flyMachineCpus: Number(values.flyMachineCpus) }),
      ...(values.flyMachineMemoryMb === ""
        ? {}
        : { flyMachineMemoryMb: Number(values.flyMachineMemoryMb) }),
    },
  };
}

function extractConfigRemainder(
  provider: Provider,
  config: z.infer<typeof DockerDeploymentConfig> | z.infer<typeof FlyDeploymentConfig>,
): ConfigRemainder {
  if (provider === "docker") {
    const dockerConfig = config as z.infer<typeof DockerDeploymentConfig>;
    return {
      providerOpts: { ...dockerConfig.providerOpts },
      opts: omitKeys(dockerConfig.opts, ["image"]),
    };
  }

  const flyConfig = config as z.infer<typeof FlyDeploymentConfig>;
  return {
    providerOpts: omitKeys(flyConfig.providerOpts, ["flyApiToken", "flyApiBaseUrl"]),
    opts: omitKeys(flyConfig.opts, [
      "image",
      "flyOrgSlug",
      "flyRegion",
      "flyMachineCpus",
      "flyMachineMemoryMb",
    ]),
  };
}

function parseProviderConfig(provider: Provider, value: string) {
  const jsonResult = createDeploymentSchema.shape.opts.safeParse(value);
  if (!jsonResult.success) return null;

  const providerResult =
    provider === "docker"
      ? DockerDeploymentConfig.safeParse(jsonResult.data)
      : FlyDeploymentConfig.safeParse(jsonResult.data);

  if (!providerResult.success) return null;
  return providerResult.data;
}

function hydrateValuesFromConfig(params: {
  slug: string;
  provider: Provider;
  config: z.infer<typeof DockerDeploymentConfig> | z.infer<typeof FlyDeploymentConfig>;
  configRemainder: ConfigRemainder;
  jsonOverrides: string;
}): FormValues {
  if (params.provider === "docker") {
    const dockerConfig = params.config as z.infer<typeof DockerDeploymentConfig>;
    return {
      ...createDefaultValues(params.provider, params.slug, params.configRemainder),
      image: dockerConfig.opts.image ?? DOCKER_DEFAULTS.image,
      jsonOverrides: params.jsonOverrides,
    };
  }

  const flyConfig = params.config as z.infer<typeof FlyDeploymentConfig>;
  return {
    ...createDefaultValues(params.provider, params.slug, params.configRemainder),
    image: flyConfig.opts.image ?? "",
    flyApiToken: flyConfig.providerOpts.flyApiToken,
    flyApiBaseUrl: flyConfig.providerOpts.flyApiBaseUrl ?? "",
    flyOrgSlug: flyConfig.opts.flyOrgSlug ?? "",
    flyRegion: flyConfig.opts.flyRegion ?? "",
    flyMachineCpus:
      flyConfig.opts.flyMachineCpus == null ? "" : String(flyConfig.opts.flyMachineCpus),
    flyMachineMemoryMb:
      flyConfig.opts.flyMachineMemoryMb == null ? "" : String(flyConfig.opts.flyMachineMemoryMb),
    jsonOverrides: params.jsonOverrides,
  };
}

function stringifyConfig(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function makeJsonOverridesField(provider: Provider, generatedValue: string) {
  return z.string().superRefine((value, ctx) => {
    const jsonResult = createDeploymentSchema.shape.opts.safeParse(value);
    if (!jsonResult.success) {
      addZodIssues(ctx, jsonResult);
      return;
    }

    if (value === generatedValue) return;

    const providerResult =
      provider === "docker"
        ? DockerDeploymentConfig.safeParse(jsonResult.data)
        : FlyDeploymentConfig.safeParse(jsonResult.data);

    addZodIssues(ctx, providerResult);
  });
}

function makeOptionalStringField(parse: (value: string) => SafeParseResult) {
  return z.string().superRefine((value, ctx) => {
    addZodIssues(ctx, parse(value));
  });
}

function makeOptionalNumberField(parse: (value: string) => SafeParseResult) {
  return z.string().superRefine((value, ctx) => {
    addZodIssues(ctx, parse(value));
  });
}

type SafeParseResult =
  | { success: true }
  | { success: false; error: { issues: Array<{ message: string }> } };

function addZodIssues(ctx: z.RefinementCtx, result: SafeParseResult) {
  if (result.success) return;

  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: "custom",
      message: issue.message,
    });
  }
}

function omitKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function shouldShowFieldError(
  submissionAttempts: number,
  meta: {
    isTouched?: boolean;
    isValid: boolean;
  },
) {
  return (submissionAttempts > 0 || meta.isTouched) && !meta.isValid;
}
