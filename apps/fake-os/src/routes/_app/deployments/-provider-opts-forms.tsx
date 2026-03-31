import { Field, FieldLabel, FieldDescription } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { Switch } from "@iterate-com/ui/components/switch";
import { Textarea } from "@iterate-com/ui/components/textarea";

export interface ProviderOptsFormProps {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

function set(prev: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  if (value === "" || value === undefined) {
    const { [key]: _, ...rest } = prev;
    return rest;
  }
  return { ...prev, [key]: value };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): string {
  return typeof value === "number" ? String(value) : "";
}

export function DockerDeploymentOptsForm({ value, onChange }: ProviderOptsFormProps) {
  const hostSyncEnabled = readHostSyncEnabled(value);

  return (
    <div className="space-y-4">
      <Field>
        <FieldLabel>Image</FieldLabel>
        <Input
          value={str(value.image)}
          onChange={(e) => onChange(set(value, "image", e.target.value))}
          placeholder="jonasland-sandbox:local"
          autoComplete="off"
        />
        <FieldDescription>Required. e.g. jonasland-sandbox:local, nginx:latest</FieldDescription>
      </Field>

      <Field>
        <div className="flex items-center justify-between gap-4 rounded-lg border bg-card px-3 py-2">
          <div className="space-y-1">
            <FieldLabel>Host Sync</FieldLabel>
            <FieldDescription>
              When on, the container mounts your host checkout so sandbox code changes are visible
              immediately. When off, it uses only the baked image contents.
            </FieldDescription>
          </div>
          <Switch
            checked={hostSyncEnabled}
            onCheckedChange={(checked) => onChange(setDockerHostSyncEnabled(value, checked))}
            aria-label="Toggle Docker host sync"
          />
        </div>
      </Field>

      <JsonOverrideTextarea value={value} onChange={onChange} />
    </div>
  );
}

export function FlyDeploymentOptsForm({ value, onChange }: ProviderOptsFormProps) {
  return (
    <div className="space-y-4">
      <Field>
        <FieldLabel>Image</FieldLabel>
        <Input
          value={str(value.image)}
          onChange={(e) => onChange(set(value, "image", e.target.value))}
          placeholder="registry.fly.io/my-app:latest"
          autoComplete="off"
        />
        <FieldDescription>Required. Docker image to deploy on Fly.</FieldDescription>
      </Field>

      <Field>
        <FieldLabel>Fly API Token</FieldLabel>
        <Input
          type="password"
          value={str(value.flyApiToken)}
          onChange={(e) => onChange(set(value, "flyApiToken", e.target.value))}
          placeholder="FlyV1 fm2_..."
          autoComplete="off"
        />
        <FieldDescription>Required. Org or deploy token with FlyV1 prefix.</FieldDescription>
      </Field>

      <Field>
        <FieldLabel>Org Slug</FieldLabel>
        <Input
          value={str(value.flyOrgSlug)}
          onChange={(e) => onChange(set(value, "flyOrgSlug", e.target.value))}
          placeholder="iterate"
          autoComplete="off"
        />
        <FieldDescription>Defaults to "iterate".</FieldDescription>
      </Field>

      <Field>
        <FieldLabel>Region</FieldLabel>
        <Input
          value={str(value.flyRegion)}
          onChange={(e) => onChange(set(value, "flyRegion", e.target.value))}
          placeholder="lhr"
          autoComplete="off"
        />
        <FieldDescription>Fly region code. Defaults to "lhr".</FieldDescription>
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field>
          <FieldLabel>CPUs</FieldLabel>
          <Input
            type="number"
            value={num(value.flyMachineCpus)}
            onChange={(e) =>
              onChange(
                set(value, "flyMachineCpus", e.target.value ? Number(e.target.value) : undefined),
              )
            }
            placeholder="4"
          />
        </Field>

        <Field>
          <FieldLabel>Memory (MB)</FieldLabel>
          <Input
            type="number"
            value={num(value.flyMachineMemoryMb)}
            onChange={(e) =>
              onChange(
                set(
                  value,
                  "flyMachineMemoryMb",
                  e.target.value ? Number(e.target.value) : undefined,
                ),
              )
            }
            placeholder="4096"
          />
        </Field>
      </div>

      <JsonOverrideTextarea value={value} onChange={onChange} />
    </div>
  );
}

function JsonOverrideTextarea({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <Field>
      <FieldLabel>JSON Overrides</FieldLabel>
      <Textarea
        value={JSON.stringify(value, null, 2)}
        onChange={(e) => {
          try {
            const parsed = JSON.parse(e.target.value);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              onChange(parsed as Record<string, unknown>);
            }
          } catch {
            // let them keep typing until it's valid
          }
        }}
        className="min-h-[100px] font-mono text-sm"
        placeholder="{}"
      />
      <FieldDescription>
        Edit the full config as JSON. Changes here override the fields above.
      </FieldDescription>
    </Field>
  );
}

function readHostSyncEnabled(value: Record<string, unknown>): boolean {
  const env = value.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return true;
  }

  return (env as Record<string, unknown>).DOCKER_HOST_SYNC_ENABLED !== "false";
}

function setDockerHostSyncEnabled(
  value: Record<string, unknown>,
  checked: boolean,
): Record<string, unknown> {
  const env =
    value.env && typeof value.env === "object" && !Array.isArray(value.env)
      ? (value.env as Record<string, unknown>)
      : {};

  return {
    ...value,
    env: {
      ...env,
      DOCKER_HOST_SYNC_ENABLED: checked ? "true" : "false",
    },
  };
}
