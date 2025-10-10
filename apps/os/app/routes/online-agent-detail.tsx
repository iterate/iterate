import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, Link } from "react-router";
import { ArrowLeft, Clock, Upload, X } from "lucide-react";
import { useAgent } from "agents/react";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { trpcClient, useTRPC } from "../lib/trpc.ts";
import { Button } from "../components/ui/button.tsx";
import { useEstateId } from "../hooks/use-estate.ts";
import { Card } from "../components/ui/card.tsx";
import { Label } from "../components/ui/label.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Input } from "../components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";
import { Drawer, DrawerContent } from "../components/ui/drawer.tsx";

// AI elements imports
import {
  AgentDetailRenderer,
  type AgentDetailDataGetters,
  type AgentDetailActions,
} from "../components/agent-detail-renderer.tsx";
import type {
  AgentCoreEvent,
  AugmentedCoreReducedState,
} from "../../backend/agent/agent-core-schemas.ts";
import type { SlackSliceEvent } from "../../backend/agent/slack-slice.ts";

type AgentEvent = AgentCoreEvent | SlackSliceEvent;

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

function JsonSchemaFormField({
  name,
  schema,
  value,
  onChange,
  required = false,
}: {
  name: string;
  schema: any;
  value: any;
  onChange: (value: any) => void;
  required?: boolean;
}) {
  const { type, description, enum: enumValues, default: defaultValue } = schema;

  const handleChange = (newValue: any) => {
    // Convert string inputs to appropriate types
    if (type === "number" || type === "integer") {
      const numValue = parseFloat(newValue);
      onChange(isNaN(numValue) ? undefined : numValue);
    } else if (type === "boolean") {
      onChange(newValue === "true" || newValue === true);
    } else {
      onChange(newValue || undefined);
    }
  };

  if (enumValues && Array.isArray(enumValues)) {
    // Enum/Select field
    const UNSET_VALUE = "__UNSET__";
    return (
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {name} {required && <span className="text-red-500">*</span>}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
        <Select
          value={value?.toString() || UNSET_VALUE}
          onValueChange={(v) => handleChange(v === UNSET_VALUE ? undefined : v)}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select an option..." />
          </SelectTrigger>
          <SelectContent>
            {!required && (
              <SelectItem value={UNSET_VALUE}>
                <span className="text-muted-foreground">None</span>
              </SelectItem>
            )}
            {enumValues.map((option) => (
              <SelectItem key={option} value={option.toString()}>
                {option.toString()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (type === "boolean") {
    // Boolean/Checkbox field
    return (
      <div className="space-y-2">
        <div className="flex items-center space-x-2">
          <Checkbox
            id={name}
            checked={value === true}
            onCheckedChange={(checked) => handleChange(checked)}
          />
          <Label htmlFor={name} className="text-sm font-medium">
            {name} {required && <span className="text-red-500">*</span>}
          </Label>
        </div>
        {description && <p className="text-xs text-muted-foreground ml-6">{description}</p>}
      </div>
    );
  }

  if (type === "string" && (schema.maxLength > 100 || !schema.maxLength)) {
    // Large text area
    return (
      <div className="space-y-2">
        <Label htmlFor={name} className="text-sm font-medium">
          {name} {required && <span className="text-red-500">*</span>}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
        <Textarea
          id={name}
          value={value || ""}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={defaultValue?.toString() || ""}
          className="min-h-[80px]"
        />
      </div>
    );
  }

  // Default: Input field for strings, numbers, etc.
  return (
    <div className="space-y-2">
      <Label htmlFor={name} className="text-sm font-medium">
        {name} {required && <span className="text-red-500">*</span>}
      </Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <Input
        id={name}
        type={type === "number" || type === "integer" ? "number" : "text"}
        value={value?.toString() || ""}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={defaultValue?.toString() || ""}
        step={type === "number" ? "any" : undefined}
      />
    </div>
  );
}

function ToolCallInjector({
  estateId,
  agentInstanceName,
  agentClassName,
  reducedState,
  onClose,
}: {
  estateId: string;
  agentInstanceName: string;
  agentClassName: "IterateAgent" | "SlackAgent";
  reducedState: any;
  onClose: () => void;
}) {
  const [selectedToolIndex, setSelectedToolIndex] = useState<number | null>(null);
  const [formData, setFormData] = useState<Record<string, any>>({});
  const [triggerLLMRequest, setTriggerLLMRequest] = useState(true);

  const trpc = useTRPC();

  const injectToolCallMutation = useMutation(
    trpc.agents.injectToolCall.mutationOptions({
      onSuccess: () => {
        onClose();
      },
      onError: (error) => {
        console.error("Failed to inject tool call:", error);
      },
    }),
  );

  // Extract function tools from reduced state
  const availableTools = useMemo((): ToolDefinition[] => {
    if (!reducedState?.runtimeTools) {
      return [];
    }

    return reducedState.runtimeTools
      .filter((tool: any) => tool.type === "function")
      .map(
        (tool: any): ToolDefinition => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || {},
        }),
      );
  }, [reducedState]);

  const selectedTool = selectedToolIndex !== null ? availableTools[selectedToolIndex] : null;

  const handleExecuteTool = async () => {
    if (!selectedTool) {
      return;
    }

    // Filter out undefined values and clean the form data
    const cleanedFormData = Object.fromEntries(
      Object.entries(formData).filter(([, value]) => value !== undefined && value !== ""),
    );

    injectToolCallMutation.mutate({
      estateId,
      agentInstanceName,
      agentClassName,
      toolName: selectedTool.name,
      args: cleanedFormData,
      triggerLLMRequest,
    });
  };

  // Reset form data when tool changes
  useEffect(() => {
    if (selectedTool) {
      const initialData: Record<string, any> = {};
      const params = selectedTool.parameters;

      if (params?.properties) {
        Object.entries(params.properties).forEach(([key, schema]: [string, any]) => {
          if (schema.default !== undefined) {
            initialData[key] = schema.default;
          }
        });
      }

      setFormData(initialData);
    }
  }, [selectedTool]);

  useEffect(() => {
    if (availableTools.length > 0 && selectedToolIndex === null) {
      setSelectedToolIndex(0);
    }
  }, [availableTools.length, selectedToolIndex]);

  return (
    <div className="py-4">
      <h2 className="text-lg font-semibold mb-4">Inject Tool Call</h2>

      {availableTools.length === 0 ? (
        <p className="text-sm text-muted-foreground">No function tools available for injection.</p>
      ) : (
        <div className="flex gap-4 h-[calc(80vh-12rem)]">
          {/* Tool selector */}
          <Card className="w-80 flex-shrink-0 p-0 flex flex-col">
            <div className="p-4 flex flex-col h-full">
              <h3 className="font-medium mb-3 flex-shrink-0">Available Tools</h3>
              <div className="space-y-1 flex-1 overflow-y-auto pr-2">
                {availableTools.map((tool, index) => (
                  <button
                    key={tool.name}
                    onClick={() => setSelectedToolIndex(index)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedToolIndex === index
                        ? "bg-primary/10 border-primary"
                        : "hover:bg-muted/50 border-border"
                    }`}
                  >
                    <div className="font-medium text-sm">{tool.name}</div>
                    {tool.description && (
                      <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {tool.description}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          {/* Tool configuration */}
          <Card className="flex-1 p-0">
            <div className="p-4 h-full flex flex-col">
              {selectedTool ? (
                <>
                  <h3 className="font-medium mb-3">{selectedTool.name}</h3>
                  {selectedTool.description && (
                    <p className="text-sm text-muted-foreground mb-4">{selectedTool.description}</p>
                  )}

                  <div className="flex-1 flex flex-col min-h-0">
                    {(() => {
                      const params = selectedTool.parameters;

                      // Check if there are any parameters
                      if (!params?.properties || Object.keys(params.properties).length === 0) {
                        return (
                          <div className="flex-1 flex items-center justify-center text-center py-8">
                            <div>
                              <p className="text-sm text-muted-foreground">
                                This tool does not require any parameters.
                              </p>
                            </div>
                          </div>
                        );
                      }

                      const requiredFields = params.required || [];

                      return (
                        <div className="space-y-4 flex-1 overflow-y-auto pr-2">
                          <div className="text-sm font-medium text-muted-foreground mb-3">
                            Parameters
                          </div>
                          {Object.entries(params.properties).map(
                            ([fieldName, fieldSchema]: [string, any]) => (
                              <JsonSchemaFormField
                                key={fieldName}
                                name={fieldName}
                                schema={fieldSchema}
                                value={formData[fieldName]}
                                onChange={(value) => {
                                  setFormData((prev) => ({
                                    ...prev,
                                    [fieldName]: value,
                                  }));
                                }}
                                required={requiredFields.includes(fieldName)}
                              />
                            ),
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  <div className="mt-4 pt-4 border-t flex-shrink-0">
                    <div className="flex items-center space-x-2 mb-4">
                      <Checkbox
                        id="trigger-llm"
                        checked={triggerLLMRequest}
                        onCheckedChange={(checked) => setTriggerLLMRequest(checked as boolean)}
                      />
                      <Label htmlFor="trigger-llm" className="text-sm">
                        Trigger LLM request after tool execution
                      </Label>
                    </div>

                    <div className="flex gap-2 justify-end">
                      <Button variant="outline" onClick={onClose}>
                        Cancel
                      </Button>
                      <Button
                        onClick={handleExecuteTool}
                        disabled={injectToolCallMutation.isPending}
                      >
                        {injectToolCallMutation.isPending && (
                          <Clock className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Execute Tool
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-muted-foreground">Select a tool to configure</p>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// Parallel Tool Group Component (similar to old project)

// Core event renderer component

// Expandable system prompt alert

// Pause/Resume Button Component

// Simple File Upload Component
function FileUploadDialog({
  estateId,
  agentInstanceName,
  agentClassName,
  onClose,
}: {
  estateId: string;
  agentInstanceName: string;
  agentClassName: "IterateAgent" | "SlackAgent";
  onClose: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Map<File, number>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const trpc = useTRPC();
  const addEventsMutation = useMutation(trpc.agents.addEvents.mutationOptions({}));

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    setFiles((prev) => [...prev, ...selectedFiles]);
  };

  const removeFile = (fileToRemove: File) => {
    setFiles((prev) => prev.filter((f) => f !== fileToRemove));
  };

  const handleUpload = async () => {
    if (files.length === 0) {
      return;
    }

    setUploading(true);
    const uploadedFiles: Array<{
      file: File;
      iterateId: string;
      openAIFileId?: string;
      uploadedFileData?: {
        filename: string;
        fileSize?: number;
        mimeType?: string;
      };
    }> = [];

    try {
      // Upload each file
      for (const file of files) {
        const xhr = new XMLHttpRequest();

        await new Promise<void>((resolve, reject) => {
          xhr.upload.addEventListener("progress", (event) => {
            if (event.lengthComputable) {
              const progress = (event.loaded / event.total) * 100;
              setUploadProgress((prev) => new Map(prev).set(file, Math.min(progress, 95)));
            }
          });

          xhr.addEventListener("load", () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const uploadedFile = JSON.parse(xhr.responseText) as {
                  id: string;
                  filename: string;
                  status: string;
                  fileSize?: number;
                  mimeType?: string;
                  openAIFileId?: string;
                };

                uploadedFiles.push({
                  file,
                  iterateId: uploadedFile.id,
                  openAIFileId: uploadedFile.openAIFileId,
                  uploadedFileData: {
                    filename: uploadedFile.filename,
                    fileSize: uploadedFile.fileSize,
                    mimeType: uploadedFile.mimeType,
                  },
                });

                setUploadProgress((prev) => new Map(prev).set(file, 100));
                resolve();
              } catch {
                reject(new Error("Failed to parse upload response"));
              }
            } else {
              reject(new Error(`Upload failed: ${xhr.statusText}`));
            }
          });

          xhr.addEventListener("error", () => {
            reject(new Error("Network error during upload"));
          });

          // Use the existing upload endpoint with estate ID
          xhr.open(
            "POST",
            `/api/estate/${estateId}/files?filename=${encodeURIComponent(file.name)}`,
          );
          xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
          xhr.send(file);
        });
      }

      // Create file sharing events
      const fileEvents = uploadedFiles.map(
        ({ file, iterateId, openAIFileId, uploadedFileData }) => ({
          type: "CORE:FILE_SHARED" as const,
          data: {
            direction: "from-user-to-agent" as const,
            iterateFileId: iterateId,
            originalFilename: uploadedFileData?.filename || file.name,
            mimeType: uploadedFileData?.mimeType || file.type,
            size: uploadedFileData?.fileSize || file.size,
            openAIFileId,
          },
        }),
      );

      // Submit the file sharing events
      await addEventsMutation.mutateAsync({
        estateId,
        agentInstanceName,
        agentClassName,
        events: fileEvents,
      });

      console.log(
        `Shared ${fileEvents.length} file${fileEvents.length > 1 ? "s" : ""} with the agent`,
      );
      onClose();
    } catch (error) {
      console.error("Error uploading files:", error);
    } finally {
      setUploading(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) {
      return "0 B";
    }
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / 1024 ** i).toFixed(1)} ${sizes[i]}`;
  };

  return (
    <div className="py-4">
      <h2 className="text-lg font-semibold mb-4">Upload Files</h2>

      <div className="space-y-4">
        {/* File input area */}
        <div
          className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center cursor-pointer hover:border-muted-foreground/50 transition-colors"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm font-medium">Click to browse files</p>
          <p className="text-xs text-muted-foreground mt-1">
            Support for images, documents, and other file types
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>

        {/* File list */}
        {files.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Selected Files ({files.length})</h3>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {files.map((file, index) => {
                const progress = uploadProgress.get(file) || 0;
                return (
                  <div key={index} className="flex items-center gap-2 p-2 border rounded">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{file.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatFileSize(file.size)} • {file.type || "Unknown type"}
                      </div>
                      {uploading && progress > 0 && (
                        <div className="w-full bg-muted rounded-full h-1 mt-1">
                          <div
                            className="bg-primary h-1 rounded-full transition-all"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      )}
                    </div>
                    {!uploading && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeFile(file)}
                        className="h-6 w-6 p-0"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <Button variant="outline" onClick={onClose} disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={files.length === 0 || uploading}>
            {uploading ? (
              <>
                <Clock className="mr-2 h-4 w-4 animate-spin" />
                Uploading...
              </>
            ) : (
              `Upload ${files.length} file${files.length !== 1 ? "s" : ""}`
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const params = useParams();
  const { agentClassName, durableObjectName } = params;
  const estateId = useEstateId();
  const trpc = useTRPC();

  if (
    !(agentClassName === "IterateAgent" || agentClassName === "SlackAgent") ||
    !durableObjectName
  ) {
    throw new Error("Invalid agent class name or durable object name");
  }

  // State management
  const [showToolInjector, setShowToolInjector] = useState(false);
  const [showFileUpload, setShowFileUpload] = useState(false);
  const [isWebsocketConnected, setIsWebsocketConnected] = useState(false);

  // Get initial events
  const { data: initialEvents } = useSuspenseQuery(
    trpc.agents.getEvents.queryOptions({
      estateId,
      agentInstanceName: durableObjectName,
      agentClassName,
    }),
  );

  const [events, setEvents] = useState<AgentEvent[]>(initialEvents as unknown as AgentEvent[]);

  // Connect to agent via WebSocket
  const agentConnection = useAgent({
    agent: "why-is-this-required-I-don't-need-to-use-it",
    basePath: `api/agents/${estateId}/${agentClassName}/${durableObjectName}`,
    onMessage: (message) => {
      const messageData = JSON.parse(message.data);
      if (messageData.type === "events_added") {
        setEvents(messageData.events);
      }
    },
  });

  // Check WebSocket connection status
  useEffect(() => {
    const checkConnectionStatus = () => {
      if (agentConnection && agentConnection.readyState === WebSocket.OPEN) {
        setIsWebsocketConnected(true);
      } else {
        setIsWebsocketConnected(false);
      }
    };

    checkConnectionStatus();
    const interval = setInterval(checkConnectionStatus, 1000);
    return () => clearInterval(interval);
  }, [agentConnection]);

  // Mutations
  const addEventsMutation = useMutation(trpc.agents.addEvents.mutationOptions({}));

  // Get initial reduced state (with suspense for initial load)
  const { data: initialReducedState } = useSuspenseQuery(
    trpc.agents.getReducedStateAtEventIndex.queryOptions({
      estateId,
      agentInstanceName: durableObjectName,
      agentClassName,
      eventIndex: initialEvents.length - 1,
    }),
  );

  // Get current reduced state (without suspense, updates as events come in)
  const { data: reducedState } = useQuery(
    trpc.agents.getReducedStateAtEventIndex.queryOptions(
      {
        estateId,
        agentInstanceName: durableObjectName,
        agentClassName,
        eventIndex: events.length - 1,
      },
      {
        initialData: initialReducedState,
        enabled: events.length > initialEvents.length,
      },
    ),
  );

  // Get Braintrust permalink
  const { data: braintrustPermalinkResult } = useQuery(
    trpc.agents.getBraintrustPermalink.queryOptions({
      estateId,
      agentInstanceName: durableObjectName,
      agentClassName,
    }),
  );

  // Handle pause/resume agent

  // Handle cancel LLM request

  // Handle event click for details - now uses filteredEvents index

  // Copy events as JSON

  // Check if agent is thinking

  const exportTraceMutation = useMutation(
    trpc.agents.exportTrace.mutationOptions({
      onSuccess: async ({ downloadUrl }) => {
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = `agent-trace-${durableObjectName}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      },
      onError: (error) => {
        console.error("Failed to export trace:", error);
      },
    }),
  );

  const getters: AgentDetailDataGetters = {
    getFileUrl: (iterateFileId: string, disposition: "inline" | "attachment" = "inline") => {
      return `/api/files/${iterateFileId}${disposition === "attachment" ? "?disposition=attachment" : ""}`;
    },
    getReducedStateAtEventIndex: async (eventIndex: number) => {
      const result = await trpcClient.agents.getReducedStateAtEventIndex.query({
        estateId,
        agentInstanceName: durableObjectName,
        agentClassName,
        eventIndex,
      });
      return result as unknown as AugmentedCoreReducedState;
    },
    getBraintrustPermalink: async () => {
      return braintrustPermalinkResult?.permalink;
    },
  };

  const actions: AgentDetailActions = {
    onSendMessage: async ({ text, role }) => {
      const promptMessage = {
        type: "CORE:LLM_INPUT_ITEM" as const,
        data: {
          type: "message" as const,
          role: role,
          content: [
            {
              type: "input_text" as const,
              text: text || "",
            },
          ],
        },
        triggerLLMRequest: true,
      };

      await addEventsMutation.mutateAsync({
        estateId,
        agentInstanceName: durableObjectName,
        agentClassName,
        events: [promptMessage],
      });
    },
    onPauseResume: (e?: React.MouseEvent) => {
      e?.preventDefault();
      e?.stopPropagation();

      const isPaused = reducedState && reducedState.paused;

      try {
        const event = {
          type: isPaused ? "CORE:RESUME_LLM_REQUESTS" : "CORE:PAUSE_LLM_REQUESTS",
        } as const;

        addEventsMutation.mutate({
          estateId,
          agentInstanceName: durableObjectName,
          agentClassName,
          events: [event],
        });
      } catch (error) {
        console.error("Error toggling agent pause state:", error);
      }
    },
    onCancelLLMRequest: () => {
      try {
        const cancelEvent = {
          type: "CORE:LLM_REQUEST_CANCEL",
          data: {
            reason: "User requested cancellation",
          },
        } as const;

        addEventsMutation.mutate({
          estateId,
          agentInstanceName: durableObjectName,
          agentClassName,
          events: [cancelEvent],
        });
      } catch (error) {
        console.error("Error preparing cancel event:", error);
      }
    },
    onExport: async () => {
      await exportTraceMutation.mutateAsync({
        estateId,
        agentInstanceName: durableObjectName,
        agentClassName,
      });
    },
    onInjectToolCallClick: () => {
      setShowToolInjector(true);
    },
    onUploadFilesClick: () => {
      setShowFileUpload(true);
    },
  };

  const headerLeft = (
    <Link to={"/"}>
      <Button variant="ghost" size="sm">
        <ArrowLeft className="h-4 w-4 mr-2" />
        Back to Agents
      </Button>
    </Link>
  );

  return (
    <>
      <AgentDetailRenderer
        events={events}
        estateId={estateId}
        agentClassName={agentClassName}
        reducedState={reducedState as unknown as AugmentedCoreReducedState}
        isWebsocketConnected={isWebsocketConnected}
        getters={getters}
        actions={actions}
        headerLeft={headerLeft}
        isSendingMessage={addEventsMutation.isPending}
        isExporting={exportTraceMutation.isPending}
      />

      {/* Tool Injector Drawer */}
      <Drawer open={showToolInjector} onOpenChange={setShowToolInjector}>
        <DrawerContent className="h-[80vh] p-0">
          <div className="px-4 pb-4 h-full overflow-auto pr-6">
            <ToolCallInjector
              estateId={estateId}
              agentInstanceName={durableObjectName}
              agentClassName={agentClassName}
              reducedState={reducedState}
              onClose={() => setShowToolInjector(false)}
            />
          </div>
        </DrawerContent>
      </Drawer>

      {/* File Upload Drawer */}
      <Drawer open={showFileUpload} onOpenChange={setShowFileUpload}>
        <DrawerContent className="h-[80vh] p-0">
          <div className="px-4 pb-4 h-full overflow-auto pr-6">
            <FileUploadDialog
              estateId={estateId}
              agentInstanceName={durableObjectName}
              agentClassName={agentClassName}
              onClose={() => setShowFileUpload(false)}
            />
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
