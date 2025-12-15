import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, useMemo, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "../../../../components/ui/button.tsx";
import { Input } from "../../../../components/ui/input.tsx";
import { Card, CardContent } from "../../../../components/ui/card.tsx";
import { Alert, AlertDescription } from "../../../../components/ui/alert.tsx";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../../components/ui/field.tsx";
import { useTRPC } from "../../../../lib/trpc.ts";
import { useInstallationId } from "../../../../hooks/use-installation.ts";
import { AgentDurableObjectInfo } from "../../../../../backend/auth/oauth-state-schemas.ts";
import { MCPParam } from "../../../../../backend/agent/tool-schemas.ts";

export const Route = createFileRoute(
  "/_auth.layout/$organizationId/$installationId/integrations/mcp-params",
)({
  component: MCPParams,
  validateSearch: z.object({
    serverUrl: z.string(),
    mode: z.enum(["personal", "company"]),
    connectionKey: z.string(),
    requiredParams: z.array(MCPParam),
    agentDurableObject: AgentDurableObjectInfo.optional(),
    integrationSlug: z.string(),
    finalRedirectUrl: z.string().optional(),
  }),
  head: () => ({
    meta: [
      {
        title: "Configure MCP Server",
      },
      {
        name: "description",
        content: "Configure authentication parameters for MCP server connection",
      },
    ],
  }),
});

function MCPParams() {
  const navigate = Route.useNavigate();
  const searchParams = Route.useSearch();
  const {
    serverUrl,
    mode,
    connectionKey,
    requiredParams,
    agentDurableObject: durableObject,
    integrationSlug,
    finalRedirectUrl,
  } = searchParams;

  const installationId = useInstallationId();
  const trpc = useTRPC();
  const router = useRouter();

  const initialValues = useMemo(() => {
    const values: Record<string, string> = {};
    requiredParams.forEach((param) => {
      // Prefill authorization fields with 'Bearer '
      values[param.key] = param.key.toLowerCase().includes("authorization") ? "Bearer " : "";
    });
    return values;
  }, [requiredParams]);
  const [error, setError] = useState<string | null>(null);

  const [formValues, setFormValues] = useState<Record<string, string>>(initialValues);

  const firstAuthInputRef = useRef<HTMLInputElement>(null);

  // Track hydration state - button is disabled until JS is ready
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => {
    setIsHydrated(true);
  }, []);

  // Focus the first authorization input field on mount
  useEffect(() => {
    const firstAuthParam = requiredParams.find((param) =>
      param.key.toLowerCase().includes("authorization"),
    );
    if (firstAuthParam && firstAuthInputRef.current) {
      firstAuthInputRef.current.focus();
    }
  }, [requiredParams]);

  const { mutateAsync: saveParams, isPending } = useMutation(
    trpc.integrations.saveMCPConnectionParams.mutationOptions({}),
  );

  const { mutateAsync: reconnect } = useMutation(
    trpc.integrations.reconnectMCPServer.mutationOptions({}),
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Check if all required fields are filled
    const missingFields = requiredParams.filter((param) => !formValues[param.key]?.trim());
    if (missingFields.length > 0) {
      setError(
        `Please fill in all required fields: ${missingFields.map((p) => p.description).join(", ")}`,
      );
      return;
    }

    try {
      await saveParams({
        installationId,
        connectionKey,
        params: requiredParams.map((param) => ({
          key: param.key,
          value: formValues[param.key],
          type: param.type,
        })),
      });

      if (durableObject) {
        await reconnect({
          installationId,
          agentDurableObject: durableObject,
          serverUrl,
          mode: mode as "personal" | "company",
          integrationSlug,
          requiresParams: requiredParams,
        });
      }
      if (finalRedirectUrl) {
        window.location.href = finalRedirectUrl;
      } else {
        window.location.href = "/";
      }
    } catch (err) {
      setError("Failed to save parameters. Please try again.");
      console.error("Error saving MCP params:", err);
    }
  };

  const handleValueChange = (key: string, value: string) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  };

  // Show error if required parameters are missing
  if (!serverUrl || requiredParams.length === 0) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>
            Missing required configuration parameters. This page should be accessed through the MCP
            connection flow.
          </AlertDescription>
        </Alert>
        <div className="mt-4">
          <Button
            onClick={() =>
              router.history.canGoBack() ? router.history.back() : navigate({ to: "/" })
            }
          >
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8 max-w-2xl">
        <h1 className="text-3xl font-bold mb-2">Configure MCP Server</h1>
        <p className="text-muted-foreground text-lg">
          Enter the required authentication parameters for {serverUrl}
        </p>
      </div>

      <Card className="max-w-2xl">
        <CardContent>
          <form onSubmit={handleSubmit} action="javascript:void(0)" method="POST">
            <FieldSet>
              <FieldLegend>Authentication Parameters</FieldLegend>
              <FieldDescription>
                These parameters will be securely stored and used to authenticate with the MCP
                server.
              </FieldDescription>
              <FieldGroup>
                {requiredParams.map((param, index) => {
                  const isFirstAuth =
                    param.key.toLowerCase().includes("authorization") &&
                    requiredParams
                      .slice(0, index)
                      .every((p) => !p.key.toLowerCase().includes("authorization"));

                  return (
                    <Field key={param.key}>
                      <FieldLabel>{param.description}</FieldLabel>
                      <Input
                        ref={isFirstAuth ? firstAuthInputRef : undefined}
                        type="text"
                        placeholder={param.placeholder}
                        value={formValues[param.key] || ""}
                        onChange={(e) => handleValueChange(param.key, e.target.value)}
                        disabled={isPending}
                      />
                      <FieldDescription
                        className={
                          param.key.toLowerCase().includes("authorization") &&
                          formValues[param.key]?.trim() &&
                          !formValues[param.key].startsWith("Bearer ")
                            ? "text-destructive"
                            : ""
                        }
                      >
                        {param.key.toLowerCase().includes("authorization") &&
                        formValues[param.key]?.trim() &&
                        !formValues[param.key].startsWith("Bearer ")
                          ? 'Unless you know what you\'re doing, you want this field to start with "Bearer "'
                          : param.type === "header"
                            ? "This will be sent as 'Authorization' HTTP header and should almost always start with 'Bearer'"
                            : param.type === "query_param"
                              ? "This will be added to the server URL as a query parameter"
                              : ""}
                      </FieldDescription>
                    </Field>
                  );
                })}

                {error && (
                  <div className="bg-destructive/15 text-destructive px-3 py-2 rounded-md text-sm">
                    {error}
                  </div>
                )}

                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      router.history.canGoBack() ? router.history.back() : navigate({ to: "/" })
                    }
                    disabled={isPending}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!isHydrated || isPending} className="flex-1">
                    {!isHydrated ? "Loading..." : isPending ? "Saving..." : "Save and Connect"}
                  </Button>
                </div>
              </FieldGroup>
            </FieldSet>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
