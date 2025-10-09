import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod/v4";
import { Button } from "../../../../components/ui/button.tsx";
import { Input } from "../../../../components/ui/input.tsx";
import { Card, CardContent } from "../../../../components/ui/card.tsx";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../../components/ui/field.tsx";
import { useTRPC } from "../../../../lib/trpc.ts";
import { useEstateId } from "../../../../hooks/use-estate.ts";
import { AgentDurableObjectInfo } from "../../../../../backend/auth/oauth-state-schemas.ts";
import { MCPParam } from "../../../../../backend/agent/tool-schemas.ts";

export function meta() {
  return [
    { title: "Configure MCP Server" },
    {
      name: "description",
      content: "Configure authentication parameters for MCP server connection",
    },
  ];
}

export default function MCPParams() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const estateId = useEstateId();
  const trpc = useTRPC();

  const serverUrl = searchParams.get("serverUrl") || "";
  const mode = searchParams.get("mode") || "personal";
  const connectionKey = searchParams.get("connectionKey") || "";
  const requiredParamsStr = searchParams.get("requiredParams") || "[]";
  const agentDurableObject = searchParams.get("agentDurableObject") || "{}";
  const integrationSlug = searchParams.get("integrationSlug") || "";
  const finalRedirectUrl = searchParams.get("finalRedirectUrl") || undefined;

  const requiredParams = useMemo(
    () => z.array(MCPParam).parse(JSON.parse(requiredParamsStr)),
    [requiredParamsStr],
  );
  const durableObject = useMemo(
    () => AgentDurableObjectInfo.parse(JSON.parse(agentDurableObject)),
    [agentDurableObject],
  );

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
        estateId,
        connectionKey,
        params: requiredParams.map((param) => ({
          key: param.key,
          value: formValues[param.key],
          type: param.type,
        })),
      });

      if (
        durableObject.durableObjectName &&
        durableObject.durableObjectId &&
        durableObject.className
      ) {
        await reconnect({
          estateId,
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
          <form onSubmit={handleSubmit}>
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
                    onClick={() => navigate(-1)}
                    disabled={isPending}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={isPending} className="flex-1">
                    {isPending ? "Saving..." : "Save and Connect"}
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
