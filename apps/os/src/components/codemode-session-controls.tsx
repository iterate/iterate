import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Play, Plug, RotateCcw } from "lucide-react";
import type { StreamPath } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import {
  type CodemodeAdHocProviderFieldsValue,
  buildAdHocProviderInputs,
  createEmptyAdHocProviderFields,
  defaultCodemodeCode,
  hasAdHocProviderFields,
} from "~/domains/codemode/ad-hoc-provider-inputs.ts";
import { createBrowserOpenApiClient } from "~/orpc/client.ts";

export function CodemodeAdHocProviderFields({
  value,
  onChange,
}: {
  value: CodemodeAdHocProviderFieldsValue;
  onChange: (value: CodemodeAdHocProviderFieldsValue) => void;
}) {
  function update(patch: Partial<CodemodeAdHocProviderFieldsValue>) {
    onChange({ ...value, ...patch });
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="space-y-3 rounded-md border p-3">
        <p className="text-sm font-medium">Outbound MCP</p>
        <Field>
          <FieldLabel htmlFor="codemode-mcp-path">Context path</FieldLabel>
          <Input
            id="codemode-mcp-path"
            value={value.mcpPath}
            onChange={(event) => update({ mcpPath: event.target.value })}
            placeholder="mcp.cloudflareDocs"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="codemode-mcp-url">Server URL</FieldLabel>
          <Input
            id="codemode-mcp-url"
            value={value.mcpServerUrl}
            onChange={(event) => update({ mcpServerUrl: event.target.value })}
            placeholder="https://docs.mcp.cloudflare.com/mcp"
          />
        </Field>
        <Field>
          <FieldLabel>Headers</FieldLabel>
          <SourceCodeBlock
            code={value.mcpHeadersYaml}
            className="min-h-28"
            editable
            language="yaml"
            onChange={(mcpHeadersYaml) => update({ mcpHeadersYaml })}
          />
        </Field>
      </div>

      <div className="space-y-3 rounded-md border p-3">
        <p className="text-sm font-medium">OpenAPI</p>
        <Field>
          <FieldLabel htmlFor="codemode-openapi-path">Context path</FieldLabel>
          <Input
            id="codemode-openapi-path"
            value={value.openApiPath}
            onChange={(event) => update({ openApiPath: event.target.value })}
            placeholder="api.petstore"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="codemode-openapi-spec">Spec URL</FieldLabel>
          <Input
            id="codemode-openapi-spec"
            value={value.openApiSpecUrl}
            onChange={(event) => update({ openApiSpecUrl: event.target.value })}
            placeholder="https://petstore.swagger.io/v2/swagger.json"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="codemode-openapi-base">Base URL</FieldLabel>
          <Input
            id="codemode-openapi-base"
            value={value.openApiBaseUrl}
            onChange={(event) => update({ openApiBaseUrl: event.target.value })}
            placeholder="https://petstore.swagger.io/v2"
          />
        </Field>
        <Field>
          <FieldLabel>Headers</FieldLabel>
          <SourceCodeBlock
            code={value.openApiHeadersYaml}
            className="min-h-28"
            editable
            language="yaml"
            onChange={(openApiHeadersYaml) => update({ openApiHeadersYaml })}
          />
        </Field>
      </div>
    </div>
  );
}

export function ExistingCodemodeSessionControls({
  projectId,
  streamPath,
}: {
  projectId: string;
  streamPath: StreamPath;
}) {
  const [code, setCode] = useState(defaultCodemodeCode);
  const [providerFields, setProviderFields] = useState(createEmptyAdHocProviderFields);

  const runScript = useMutation({
    mutationFn: async () => {
      const providers = buildAdHocProviderInputs(providerFields);
      return await createBrowserOpenApiClient().project.codemode.executeScript({
        code,
        events: [],
        projectSlugOrId: projectId,
        providers,
        streamPath,
      });
    },
    onSuccess: () => toast.success("Script execution requested"),
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const appendProviders = useMutation({
    mutationFn: async () => {
      const providers = buildAdHocProviderInputs(providerFields);
      if (providers.length === 0) {
        throw new Error("Fill in an MCP server URL or OpenAPI URLs first.");
      }

      return await createBrowserOpenApiClient().project.codemode.createSession({
        events: [],
        projectSlugOrId: projectId,
        providers,
        streamPath,
      });
    },
    onSuccess: () => toast.success("Tool providers appended"),
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  function resetAdHocProviders() {
    setProviderFields(createEmptyAdHocProviderFields());
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Run script mode code</p>
            <p className="text-sm text-muted-foreground">
              Appends a script execution request to this codemode session.
            </p>
          </div>
          <Button
            type="button"
            onClick={() => runScript.mutate()}
            disabled={runScript.isPending || code.trim() === ""}
          >
            <Play className="size-4" />
            {runScript.isPending ? "Running..." : "Run script"}
          </Button>
        </div>

        <FieldGroup>
          <Field>
            <FieldLabel>Script</FieldLabel>
            <SourceCodeBlock
              code={code}
              className="min-h-52"
              editable
              language="typescript"
              onChange={setCode}
              onModEnter={() => runScript.mutate()}
            />
          </Field>
        </FieldGroup>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Ad-hoc tool providers</p>
            <p className="text-sm text-muted-foreground">
              Append outbound MCP or OpenAPI provider registrations to this session.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={resetAdHocProviders}>
              <RotateCcw className="size-4" />
              Reset
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => appendProviders.mutate()}
              disabled={appendProviders.isPending || !hasAdHocProviderFields(providerFields)}
            >
              <Plug className="size-4" />
              {appendProviders.isPending ? "Appending..." : "Append providers"}
            </Button>
          </div>
        </div>

        <CodemodeAdHocProviderFields value={providerFields} onChange={setProviderFields} />
        <FieldDescription>
          Provider headers are optional YAML objects. Run script also includes any filled provider
          forms before requesting execution.
        </FieldDescription>
      </div>
    </div>
  );
}
