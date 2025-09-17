import type { OpenAI } from "openai";
import type {
  ComputerTool,
  FileSearchTool,
  FunctionTool,
  Tool,
  WebSearchTool,
} from "openai/resources/responses/responses.mjs";
import { z } from "zod/v4";
import { createZodSchemaThatSatisfies } from "../utils/type-helpers.ts";

// These schemas are designed to match OpenAI's Responses API types
// See openai-responses-api-docs-playground.ts for comprehensive documentation
//
// 📚 RELATED FILES:
// • openai-responses-api-docs-playground.ts - Interactive examples and type exploration
// • agent-core-schemas.ts - Uses these schemas for event validation and state management
// • agent-core.ts - Runtime implementation that processes these schema types
//
// 🔄 USAGE IN AGENT CORE:
// These schemas validate OpenAI input/output items in the agent's event system:
// 1. ResponseInputItem - validates items sent TO OpenAI (user messages, tool outputs)
// 2. ResponseOutputItem - validates items received FROM OpenAI (assistant messages, tool calls)
// 3. Content schemas - validate the nested content within messages (text, images, files)
// 4. Tool call schemas - validate function calls and their execution results
//
// The agent core uses these for:
// - Event validation in CoreLLMInputItemEventSchema and CoreLLMOutputItemEventSchema
// - Type-safe parsing of OpenAI streaming responses
// - Ensuring conversation state consistency across turns
//
// ⚠️ INCONSISTENCIES SUMMARY:
// 1. Some schemas include custom fields not present in OpenAI types
// 2. Some schemas are entirely custom (MCP, custom tool outputs)
// 3. Some schemas are missing optional fields from OpenAI types
// 4. ImageGenerationCall schema structure doesn't match OpenAI's actual type
// 5. ResponseInputItem includes schemas that may not be valid input items
// 6. FileDownloadAnnotation is not a valid OpenAI annotation type

// ===========================================================================================
// Content Item Schemas (used within messages)
// ===========================================================================================

// Input content types
export const inputTextContentSchema =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseInputText>()(
    z.object({
      type: z.literal("input_text"),
      text: z.string(),
    }),
  );

export const inputImageContentSchema =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseInputImage>()(
    z.object({
      type: z.literal("input_image"),
      image_url: z.string().optional(),
      file_id: z.string().optional(),
      detail: z.enum(["auto", "low", "high"]),
    }),
  );

export const inputFileContentSchema =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseInputFile>()(
    z.object({
      type: z.literal("input_file"),
      file_id: z.string().optional(),
      file_data: z.string().optional(),
      filename: z.string().optional(),
    }),
  );

// Output content types
export const fileCitationAnnotationSchema =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseOutputText.FileCitation>()(
    z.object({
      type: z.literal("file_citation"),
      file_id: z.string(),
      filename: z.string(),
      index: z.number(),
    }),
  );

export const urlCitationAnnotationSchema =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseOutputText.URLCitation>()(
    z.object({
      type: z.literal("url_citation"),
      url: z.string(),
      title: z.string(),
      start_index: z.number(),
      end_index: z.number(),
    }),
  );

export const containerFileCitationAnnotationSchema =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseOutputText.ContainerFileCitation>()(
    z.object({
      type: z.literal("container_file_citation"),
      file_id: z.string(),
      filename: z.string(),
      container_id: z.string(),
      start_index: z.number(),
      end_index: z.number(),
    }),
  );

export const filePathAnnotationSchema =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseOutputText.FilePath>()(
    z.object({
      type: z.literal("file_path"),
      file_id: z.string(),
      index: z.number(),
    }),
  );

// Keep the FileDownloadAnnotation for backward compatibility but don't use it in OutputTextContentSchema
// ⚠️ INCONSISTENCY: FileDownloadAnnotation is not a valid OpenAI annotation type
// OpenAI only supports: FileCitation, URLCitation, ContainerFileCitation, FilePath
export const FileDownloadAnnotation = z.object({
  type: z.literal("file_download"),
  file_id: z.string(),
  filename: z.string(),
});

export const outputTextContentSchema =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseOutputText>()(
    z.object({
      type: z.literal("output_text"),
      text: z.string(),
      annotations: z.array(
        z.union([
          fileCitationAnnotationSchema,
          urlCitationAnnotationSchema,
          containerFileCitationAnnotationSchema,
          filePathAnnotationSchema,
        ]),
      ),
      // ⚠️ MISSING: logprobs field from OpenAI.Responses.ResponseOutputText (optional)
    }),
  );

export const refusalContentSchema =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseOutputRefusal>()(
    z.object({
      type: z.literal("refusal"),
      refusal: z.string(),
    }),
  );

// Combined content schemas
export const InputContent = z.discriminatedUnion("type", [
  inputTextContentSchema,
  inputImageContentSchema,
  inputFileContentSchema,
]);

export const OutputContent = z.discriminatedUnion("type", [
  outputTextContentSchema,
  refusalContentSchema,
]);

// ===========================================================================================
// Input Item Schemas (ResponseInputItem)
// ===========================================================================================

// Single message input schema that handles all input roles
export const MessageInput = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "system", "developer", "assistant"]),
  content: z.array(z.union([InputContent, OutputContent])),
  // Optional fields for assistant messages
  id: z.string().optional(),
  status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
});

// Tool output schemas (sent back to OpenAI after local execution)
export const FunctionCallOutput =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseInputItem.FunctionCallOutput>()(
    z.object({
      type: z.literal("function_call_output"),
      call_id: z.string(),
      output: z.string(),
    }),
  );

// Add screenshot schema before ComputerCallOutputSchema
export const responseComputerToolCallOutputScreenshotSchema =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseComputerToolCallOutputScreenshot>()(
    z.object({
      type: z.literal("computer_screenshot"),
      file_id: z.string().optional(),
      image_url: z.string().optional(),
    }),
  );

export const ComputerCallOutput =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseInputItem.ComputerCallOutput>()(
    z.object({
      type: z.literal("computer_call_output"),
      call_id: z.string(),
      output: responseComputerToolCallOutputScreenshotSchema,
      // ⚠️ MISSING: id, acknowledged_safety_checks, status fields from OpenAI type (all optional)
    }),
  );

// ⚠️ INCONSISTENCY: These tool output schemas don't have corresponding OpenAI types
// They are custom schemas for our implementation, not part of OpenAI's official API
export const FileSearchOutput = z.object({
  type: z.literal("file_search_output"),
  call_id: z.string(),
  output: z.string(),
});

export const WebSearchOutput = z.object({
  type: z.literal("web_search_output"),
  call_id: z.string(),
  output: z.string(),
});

export const MCPCallOutput = z.object({
  type: z.literal("mcp_call_output"),
  call_id: z.string(),
  output: z.string(),
});

export const ImageGenerationOutput = z.object({
  type: z.literal("image_generation_output"),
  call_id: z.string(),
  output: z.string(),
});

// ===========================================================================================
// Output Item Schemas (ResponseOutputItem)
// ===========================================================================================

// Assistant message output
export const AssistantMessageOutput =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseOutputMessage>()(
    z.object({
      type: z.literal("message"),
      id: z.string(),
      role: z.literal("assistant"),
      status: z.enum(["in_progress", "completed", "incomplete"]),
      content: z.array(OutputContent),
    }),
  );

// Tool call schemas (requests from OpenAI to execute tools)
export const FunctionCall =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseFunctionToolCall>()(
    z.object({
      type: z.literal("function_call"),
      id: z.string().optional(),
      call_id: z.string(),
      name: z.string(),
      arguments: z.string(),
      status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
    }),
  );

export const FileSearchCall =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseFileSearchToolCall>()(
    z.object({
      type: z.literal("file_search_call"),
      id: z.string(),
      queries: z.array(z.string()),
      status: z.enum(["in_progress", "searching", "completed", "incomplete", "failed"]),
      results: z
        .array(
          z.object({
            attributes: z
              .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
              .nullable()
              .optional(),
            file_id: z.string().optional(),
            filename: z.string().optional(),
            score: z.number().optional(),
            text: z.string().optional(),
          }),
        )
        .nullable()
        .optional(),
    }),
  );

export const WebSearchCall =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseFunctionWebSearch>()(
    z.object({
      type: z.literal("web_search_call"),
      id: z.string(),
      status: z.enum(["in_progress", "searching", "completed", "failed"]),
    }),
  );

// Define action schemas for ComputerCall
const ComputerCallAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    button: z.enum(["left", "right", "wheel", "back", "forward"]),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("double_click"),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("drag"),
    path: z.array(z.object({ x: z.number(), y: z.number() })),
  }),
  z.object({
    type: z.literal("keypress"),
    keys: z.array(z.string()),
  }),
  z.object({
    type: z.literal("move"),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal("screenshot"),
  }),
  z.object({
    type: z.literal("scroll"),
    x: z.number(),
    y: z.number(),
    scroll_x: z.number(),
    scroll_y: z.number(),
  }),
  z.object({
    type: z.literal("type"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("wait"),
  }),
]);

export const ComputerCall =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseComputerToolCall>()(
    z.object({
      type: z.literal("computer_call"),
      id: z.string(),
      call_id: z.string(),
      action: ComputerCallAction,
      pending_safety_checks: z.array(
        z.object({
          id: z.string(),
          code: z.string(),
          message: z.string(),
        }),
      ),
      status: z.enum(["in_progress", "completed", "incomplete"]),
    }),
  );

export const McpCall = createZodSchemaThatSatisfies<OpenAI.Responses.ResponseOutputItem.McpCall>()(
  z.object({
    type: z.literal("mcp_call"),
    id: z.string(),
    arguments: z.string(),
    name: z.string(),
    server_label: z.string(),
    error: z.string().nullable().optional(),
    output: z.string().nullable().optional(),
  }),
);

export const ImageGenerationCallOutput =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseOutputItem.ImageGenerationCall>()(
    z.object({
      type: z.literal("image_generation_call"),
      id: z.string(),
      result: z.string().nullable(),
      status: z.enum(["in_progress", "completed", "generating", "failed"]),
    }),
  );

export const ImageGenerationCallInput =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseInputItem.ImageGenerationCall>()(
    z.object({
      type: z.literal("image_generation_call"),
      id: z.string(),
      result: z.string().nullable(),
      status: z.enum(["in_progress", "completed", "generating", "failed"]),
    }),
  );

export const CodeInterpreterCall =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseCodeInterpreterToolCall>()(
    z.object({
      type: z.literal("code_interpreter_call"),
      id: z.string(),
      code: z.string().nullable(),
      container_id: z.string(),
      outputs: z
        .array(
          z.discriminatedUnion("type", [
            z.object({
              type: z.literal("logs"),
              logs: z.string(),
            }),
            z.object({
              type: z.literal("image"),
              url: z.string(),
            }),
          ]),
        )
        .nullable(),
      status: z.enum(["in_progress", "completed", "incomplete", "interpreting", "failed"]),
    }),
  );

// Custom tool call (newer OpenAI SDK variant) – allow passthrough to be forward-compatible
export const customToolCallSchema =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseCustomToolCall>()(
    z.object({
      type: z.literal("custom_tool_call"),
      // Required by SDK type
      call_id: z.string(),
      name: z.string(),
      input: z.string(),
      // Common optional fields on tool calls
      id: z.string().optional(),
      status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
    }),
  );

// Reasoning item schema
export const ResponseReasoningItem =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseReasoningItem>()(
    z.object({
      type: z.literal("reasoning"),
      id: z.string(),
      summary: z.array(
        z.object({
          type: z.literal("summary_text"),
          text: z.string(),
        }),
      ),
      encrypted_content: z.string().nullable().optional(),
      status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
    }),
  );

// Local shell call schema
export const LocalShellCall =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseOutputItem.LocalShellCall>()(
    z.object({
      type: z.literal("local_shell_call"),
      id: z.string(),
      call_id: z.string(),
      action: z.object({
        type: z.literal("exec"),
        command: z.array(z.string()),
        env: z.record(z.string(), z.string()),
        timeout_ms: z.number().nullable().optional(),
        user: z.string().nullable().optional(),
        working_directory: z.string().nullable().optional(),
      }),
      status: z.enum(["in_progress", "completed", "incomplete"]),
    }),
  );

// MCP list tools schema
export const McpListTools =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseOutputItem.McpListTools>()(
    z.object({
      type: z.literal("mcp_list_tools"),
      id: z.string(),
      server_label: z.string(),
      tools: z.array(
        z.object({
          name: z.string(),
          input_schema: z.unknown(),
          annotations: z.unknown().nullable().optional(),
          description: z.string().nullable().optional(),
        }),
      ),
      error: z.string().nullable().optional(),
    }),
  );

// MCP approval request schema
export const McpApprovalRequest =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseOutputItem.McpApprovalRequest>()(
    z.object({
      type: z.literal("mcp_approval_request"),
      id: z.string(),
      arguments: z.string(),
      name: z.string(),
      server_label: z.string(),
    }),
  );

// Combined ResponseOutputItem schema
export const ResponseOutputItem = z.discriminatedUnion("type", [
  AssistantMessageOutput,
  FunctionCall,
  FileSearchCall,
  WebSearchCall,
  ComputerCall,
  customToolCallSchema,
  McpCall,
  ImageGenerationCallOutput,
  CodeInterpreterCall,
  ResponseReasoningItem,
  LocalShellCall,
  McpListTools,
  McpApprovalRequest,
]);

export const mcpApprovalResponseSchema =
  createZodSchemaThatSatisfies<OpenAI.Responses.ResponseInputItem.McpApprovalResponse>()(
    z.object({
      type: z.literal("mcp_approval_response"),
      approval_request_id: z.string(),
      approve: z.boolean(),
      id: z.string().nullable().optional(),
      reason: z.string().nullable().optional(),
    }),
  );

// Combined ResponseInputItem schema - moved here after all schemas are defined
// All response output items can be used as input items for conversation history
export const ResponseInputItem = z.discriminatedUnion("type", [
  // Direct input items (not in ResponseOutputItem)
  MessageInput,
  FunctionCallOutput,
  ComputerCallOutput,
  mcpApprovalResponseSchema,

  // All output items can also be used as input items (for conversation history)
  // EXCEPT AssistantMessageOutput because it conflicts with MessageInput
  // Both have type: "message" but with different constraints:
  // - AssistantMessageOutput: type "message" with role restricted to "assistant"
  // - MessageInput: type "message" with role allowing "user", "system", "developer", or "assistant"
  // This is why OpenAI's SDK treats them as separate types - output messages are always from the assistant,
  // while input messages can be from various roles
  ...ResponseOutputItem.options.filter((schema) => schema !== AssistantMessageOutput),
]);

// ===========================================================================================
// Type exports
// ===========================================================================================

export type InputContent = z.infer<typeof InputContent>;
export type OutputContent = z.infer<typeof OutputContent>;
export type ResponseInputItem = z.infer<typeof ResponseInputItem>;
export type ResponseOutputItem = z.infer<typeof ResponseOutputItem>;

// Specific type exports for convenience
export type MessageInput = z.infer<typeof MessageInput>;
export type AssistantMessageOutput = z.infer<typeof AssistantMessageOutput>;
export type FunctionCall = z.infer<typeof FunctionCall>;
export type FunctionCallOutput = z.infer<typeof FunctionCallOutput>;
export type ComputerCallOutput = z.infer<typeof ComputerCallOutput>;
export type FileSearchOutput = z.infer<typeof FileSearchOutput>;
export type WebSearchOutput = z.infer<typeof WebSearchOutput>;
export type MCPCallOutput = z.infer<typeof MCPCallOutput>;
export type ImageGenerationOutput = z.infer<typeof ImageGenerationOutput>;
export type FileSearchCall = z.infer<typeof FileSearchCall>;
export type WebSearchCall = z.infer<typeof WebSearchCall>;
export type ComputerCall = z.infer<typeof ComputerCall>;
export type McpCall = z.infer<typeof McpCall>;
export type ImageGenerationCallOutput = z.infer<typeof ImageGenerationCallOutput>;
export type ImageGenerationCallInput = z.infer<typeof ImageGenerationCallInput>;
export type CodeInterpreterCall = z.infer<typeof CodeInterpreterCall>;
export type ResponseReasoningItem = z.infer<typeof ResponseReasoningItem>;
export type LocalShellCall = z.infer<typeof LocalShellCall>;
export type McpListTools = z.infer<typeof McpListTools>;
export type McpApprovalRequest = z.infer<typeof McpApprovalRequest>;

// ===========================================================================================
// OpenAI Tool Definition Schemas (moved from openai-tool-schemas.ts)
// ===========================================================================================

export const OpenAIFunctionTool = createZodSchemaThatSatisfies<FunctionTool>()(
  z.object({
    name: z.string(),
    parameters: z.record(z.string(), z.unknown()),
    strict: z.boolean(),
    type: z.literal("function"),
    description: z.string().nullable().optional(),
  }),
);

export const OpenAIFileSearchTool = createZodSchemaThatSatisfies<FileSearchTool>()(
  z.object({
    type: z.literal("file_search"),
    vector_store_ids: z.array(z.string()),
    filters: z.any().nullable().optional(),
    max_num_results: z.number().optional(),
    ranking_options: z.any().optional(),
  }),
);

export const OpenAIWebSearchTool = createZodSchemaThatSatisfies<WebSearchTool>()(
  z.object({
    type: z.union([
      z.literal("web_search"),
      z.literal("web_search_2025_08_26"),
      // support old values at runtime but not in our codebase using silly transforming and pipe
      z
        .literal("web_search_preview")
        .transform(() => "web_search")
        .pipe(z.literal("web_search")),
      z
        .literal("web_search_preview_2025_03_11")
        .transform(() => "web_search_2025_08_26")
        .pipe(z.literal("web_search_2025_08_26")),
    ]),
    search_context_size: z.enum(["low", "medium", "high"]).optional(),
    user_location: z
      .object({
        type: z.literal("approximate"),
        city: z.string().nullable().optional(),
        country: z.string().nullable().optional(),
        region: z.string().nullable().optional(),
        timezone: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
);

export const OpenAIComputerTool = createZodSchemaThatSatisfies<ComputerTool>()(
  z.object({
    type: z.literal("computer_use_preview"),
    display_height: z.number(),
    display_width: z.number(),
    environment: z.enum(["windows", "mac", "linux", "ubuntu", "browser"]),
  }),
);

export const OpenAIMcpTool = createZodSchemaThatSatisfies<Tool.Mcp>()(
  z.object({
    type: z.literal("mcp"),
    server_label: z.string(),
    server_url: z.string().optional(),
    allowed_tools: z
      .union([
        z.array(z.string()),
        z.object({
          tool_names: z.array(z.string()).optional(),
        }),
      ])
      .nullable()
      .optional(),
    headers: z.record(z.string(), z.string()).nullable().optional(),
    require_approval: z
      .union([
        z.literal("always"),
        z.literal("never"),
        z.object({
          always: z
            .object({
              tool_names: z.array(z.string()).optional(),
            })
            .optional(),
          never: z
            .object({
              tool_names: z.array(z.string()).optional(),
            })
            .optional(),
        }),
      ])
      .nullable()
      .optional(),
  }),
);

export const OpenAICodeInterpreterTool = createZodSchemaThatSatisfies<Tool.CodeInterpreter>()(
  z.object({
    type: z.literal("code_interpreter"),
    container: z.union([
      z.string(),
      z.object({
        type: z.literal("auto"),
        file_ids: z.array(z.string()).optional(),
      }),
    ]),
  }),
);

export const OpenAIImageGenerationTool = createZodSchemaThatSatisfies<Tool.ImageGeneration>()(
  z.object({
    type: z.literal("image_generation"),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    input_image_mask: z
      .object({
        file_id: z.string().optional(),
        image_url: z.string().optional(),
      })
      .optional(),
    model: z.literal("gpt-image-1").optional(),
    moderation: z.enum(["auto", "low"]).optional(),
    output_compression: z.number().optional(),
    output_format: z.enum(["png", "webp", "jpeg"]).optional(),
    partial_images: z.number().optional(),
    quality: z.enum(["low", "medium", "high", "auto"]).optional(),
    size: z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]).optional(),
  }),
);

export const OpenAILocalShellTool = createZodSchemaThatSatisfies<Tool.LocalShell>()(
  z.object({
    type: z.literal("local_shell"),
  }),
);

export const OpenAIBuiltinTool = z.discriminatedUnion("type", [
  OpenAIFileSearchTool,
  OpenAIWebSearchTool,
  OpenAIComputerTool,
  OpenAIMcpTool,
  OpenAICodeInterpreterTool,
  OpenAIImageGenerationTool,
  OpenAILocalShellTool,
]);

// Export OpenAI tool types for convenience
export type OpenAIBuiltinTool = z.infer<typeof OpenAIBuiltinTool>;
export type OpenAIFunctionTool = z.infer<typeof OpenAIFunctionTool>;
export type OpenAIFileSearchTool = z.infer<typeof OpenAIFileSearchTool>;
export type OpenAIWebSearchTool = z.infer<typeof OpenAIWebSearchTool>;
export type OpenAIComputerTool = z.infer<typeof OpenAIComputerTool>;
export type OpenAIMcpTool = z.infer<typeof OpenAIMcpTool>;
export type OpenAICodeInterpreterTool = z.infer<typeof OpenAICodeInterpreterTool>;
export type OpenAIImageGenerationTool = z.infer<typeof OpenAIImageGenerationTool>;
export type OpenAILocalShellTool = z.infer<typeof OpenAILocalShellTool>;
