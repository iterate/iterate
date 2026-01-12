import dedent, { default as dedent$1 } from "dedent";
import z$1, { z } from "zod";
import { dirname, join, resolve } from "node:path";
import { accessSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

//#region backend/agent/do-tools.ts
/**
* Define a record of tools that will be implemented by a Durable Object. The record can also be used to
* get JSON schemas for each tool.
*
* @returns The record you passed in, with a compile-time only `$infer` property which has:
* - `inputTypes` - A record of the input types for each tool. You can use to provide a type for each method in your implementation.
* - `outputTypes` - A record of the output types for each tool. You can use this similarly, but probably don't need to - typescript will infer output types for you.
* - `interface` - create a type alias with this like `type MyToolsInterface = typeof myTools.$infer.interface` then do `class MyDO implements MyToolsInterface {...}` to make sure you correctly implement the tools
*/
const defineDOTools = (tools$1) => {
	return tools$1;
};
const LooseEmptyObject = z.looseObject({});
function createDOToolFactory(definitions) {
	return Object.fromEntries(Object.keys(definitions).map((key) => {
		return [key, (toolSpec) => {
			return {
				type: "agent_durable_object_tool",
				methodName: key,
				...toolSpec
			};
		}];
	}));
}

//#endregion
//#region backend/utils/type-helpers.ts
const JSONSerializable = z.unknown();
function createZodSchemaThatSatisfies() {
	return (zodSchema) => zodSchema;
}

//#endregion
//#region backend/agent/openai-response-schemas.ts
const inputTextContentSchema = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("input_text"),
	text: z.string()
}));
const inputImageContentSchema = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("input_image"),
	image_url: z.string().optional(),
	file_id: z.string().optional(),
	detail: z.enum([
		"auto",
		"low",
		"high"
	])
}));
const inputFileContentSchema = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("input_file"),
	file_id: z.string().optional(),
	file_data: z.string().optional(),
	filename: z.string().optional()
}));
const fileCitationAnnotationSchema = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("file_citation"),
	file_id: z.string(),
	filename: z.string(),
	index: z.number()
}));
const urlCitationAnnotationSchema = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("url_citation"),
	url: z.string(),
	title: z.string(),
	start_index: z.number(),
	end_index: z.number()
}));
const containerFileCitationAnnotationSchema = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("container_file_citation"),
	file_id: z.string(),
	filename: z.string(),
	container_id: z.string(),
	start_index: z.number(),
	end_index: z.number()
}));
const filePathAnnotationSchema = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("file_path"),
	file_id: z.string(),
	index: z.number()
}));
const FileDownloadAnnotation = z.object({
	type: z.literal("file_download"),
	file_id: z.string(),
	filename: z.string()
});
const outputTextContentSchema = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("output_text"),
	text: z.string(),
	annotations: z.array(z.union([
		fileCitationAnnotationSchema,
		urlCitationAnnotationSchema,
		containerFileCitationAnnotationSchema,
		filePathAnnotationSchema
	]))
}));
const refusalContentSchema = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("refusal"),
	refusal: z.string()
}));
const InputContent = z.discriminatedUnion("type", [
	inputTextContentSchema,
	inputImageContentSchema,
	inputFileContentSchema
]);
const OutputContent = z.discriminatedUnion("type", [outputTextContentSchema, refusalContentSchema]);
const MessageInput = z.object({
	type: z.literal("message"),
	role: z.enum([
		"user",
		"system",
		"developer",
		"assistant"
	]),
	content: z.array(z.union([InputContent, OutputContent])),
	id: z.string().optional(),
	status: z.enum([
		"in_progress",
		"completed",
		"incomplete"
	]).optional()
});
const FunctionCallOutput = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("function_call_output"),
	call_id: z.string(),
	output: z.string()
}));
const responseComputerToolCallOutputScreenshotSchema = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("computer_screenshot"),
	file_id: z.string().optional(),
	image_url: z.string().optional()
}));
const ComputerCallOutput = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("computer_call_output"),
	call_id: z.string(),
	output: responseComputerToolCallOutputScreenshotSchema
}));
const FileSearchOutput = z.object({
	type: z.literal("file_search_output"),
	call_id: z.string(),
	output: z.string()
});
const WebSearchOutput = z.object({
	type: z.literal("web_search_output"),
	call_id: z.string(),
	output: z.string()
});
const MCPCallOutput = z.object({
	type: z.literal("mcp_call_output"),
	call_id: z.string(),
	output: z.string()
});
const ImageGenerationOutput = z.object({
	type: z.literal("image_generation_output"),
	call_id: z.string(),
	output: z.string()
});
const AssistantMessageOutput = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("message"),
	id: z.string(),
	role: z.literal("assistant"),
	status: z.enum([
		"in_progress",
		"completed",
		"incomplete"
	]),
	content: z.array(OutputContent)
}));
const FunctionCall = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("function_call"),
	id: z.string().optional(),
	call_id: z.string(),
	name: z.string(),
	arguments: z.string(),
	status: z.enum([
		"in_progress",
		"completed",
		"incomplete"
	]).optional()
}));
const FileSearchCall = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("file_search_call"),
	id: z.string(),
	queries: z.array(z.string()),
	status: z.enum([
		"in_progress",
		"searching",
		"completed",
		"incomplete",
		"failed"
	]),
	results: z.array(z.object({
		attributes: z.record(z.string(), z.union([
			z.string(),
			z.number(),
			z.boolean()
		])).nullable().optional(),
		file_id: z.string().optional(),
		filename: z.string().optional(),
		score: z.number().optional(),
		text: z.string().optional()
	})).nullable().optional()
}));
const WebSearchCall = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("web_search_call"),
	id: z.string(),
	status: z.enum([
		"in_progress",
		"searching",
		"completed",
		"failed"
	])
}));
const ComputerCallAction = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("click"),
		button: z.enum([
			"left",
			"right",
			"wheel",
			"back",
			"forward"
		]),
		x: z.number(),
		y: z.number()
	}),
	z.object({
		type: z.literal("double_click"),
		x: z.number(),
		y: z.number()
	}),
	z.object({
		type: z.literal("drag"),
		path: z.array(z.object({
			x: z.number(),
			y: z.number()
		}))
	}),
	z.object({
		type: z.literal("keypress"),
		keys: z.array(z.string())
	}),
	z.object({
		type: z.literal("move"),
		x: z.number(),
		y: z.number()
	}),
	z.object({ type: z.literal("screenshot") }),
	z.object({
		type: z.literal("scroll"),
		x: z.number(),
		y: z.number(),
		scroll_x: z.number(),
		scroll_y: z.number()
	}),
	z.object({
		type: z.literal("type"),
		text: z.string()
	}),
	z.object({ type: z.literal("wait") })
]);
const ComputerCall = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("computer_call"),
	id: z.string(),
	call_id: z.string(),
	action: ComputerCallAction,
	pending_safety_checks: z.array(z.object({
		id: z.string(),
		code: z.string(),
		message: z.string()
	})),
	status: z.enum([
		"in_progress",
		"completed",
		"incomplete"
	])
}));
const McpCall = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("mcp_call"),
	id: z.string(),
	arguments: z.string(),
	name: z.string(),
	server_label: z.string(),
	error: z.string().nullable().optional(),
	output: z.string().nullable().optional()
}));
const ImageGenerationCallOutput = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("image_generation_call"),
	id: z.string(),
	result: z.string().nullable(),
	status: z.enum([
		"in_progress",
		"completed",
		"generating",
		"failed"
	])
}));
const ImageGenerationCallInput = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("image_generation_call"),
	id: z.string(),
	result: z.string().nullable(),
	status: z.enum([
		"in_progress",
		"completed",
		"generating",
		"failed"
	])
}));
const CodeInterpreterCall = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("code_interpreter_call"),
	id: z.string(),
	code: z.string().nullable(),
	container_id: z.string(),
	outputs: z.array(z.discriminatedUnion("type", [z.object({
		type: z.literal("logs"),
		logs: z.string()
	}), z.object({
		type: z.literal("image"),
		url: z.string()
	})])).nullable(),
	status: z.enum([
		"in_progress",
		"completed",
		"incomplete",
		"interpreting",
		"failed"
	])
}));
const customToolCallSchema = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("custom_tool_call"),
	call_id: z.string(),
	name: z.string(),
	input: z.string(),
	id: z.string().optional(),
	status: z.enum([
		"in_progress",
		"completed",
		"incomplete"
	]).optional()
}));
const ResponseReasoningItem = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("reasoning"),
	id: z.string(),
	summary: z.array(z.object({
		type: z.literal("summary_text"),
		text: z.string()
	})),
	encrypted_content: z.string().nullable().optional(),
	status: z.enum([
		"in_progress",
		"completed",
		"incomplete"
	]).optional()
}));
const LocalShellCall = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("local_shell_call"),
	id: z.string(),
	call_id: z.string(),
	action: z.object({
		type: z.literal("exec"),
		command: z.array(z.string()),
		env: z.record(z.string(), z.string()),
		timeout_ms: z.number().nullable().optional(),
		user: z.string().nullable().optional(),
		working_directory: z.string().nullable().optional()
	}),
	status: z.enum([
		"in_progress",
		"completed",
		"incomplete"
	])
}));
const McpListTools = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("mcp_list_tools"),
	id: z.string(),
	server_label: z.string(),
	tools: z.array(z.object({
		name: z.string(),
		input_schema: z.unknown(),
		annotations: z.unknown().nullable().optional(),
		description: z.string().nullable().optional()
	})),
	error: z.string().nullable().optional()
}));
const McpApprovalRequest = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("mcp_approval_request"),
	id: z.string(),
	arguments: z.string(),
	name: z.string(),
	server_label: z.string()
}));
const ResponseOutputItem = z.discriminatedUnion("type", [
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
	McpApprovalRequest
]);
const mcpApprovalResponseSchema = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("mcp_approval_response"),
	approval_request_id: z.string(),
	approve: z.boolean(),
	id: z.string().nullable().optional(),
	reason: z.string().nullable().optional()
}));
const ResponseInputItem = z.discriminatedUnion("type", [
	MessageInput,
	FunctionCallOutput,
	ComputerCallOutput,
	mcpApprovalResponseSchema,
	...ResponseOutputItem.options.filter((schema) => schema !== AssistantMessageOutput)
]);
const OpenAIFunctionTool = createZodSchemaThatSatisfies()(z.object({
	name: z.string(),
	parameters: z.record(z.string(), z.unknown()),
	strict: z.boolean(),
	type: z.literal("function"),
	description: z.string().nullable().optional()
}));
const OpenAIFileSearchTool = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("file_search"),
	vector_store_ids: z.array(z.string()),
	filters: z.any().nullable().optional(),
	max_num_results: z.number().optional(),
	ranking_options: z.any().optional()
}));
const OpenAIWebSearchTool = createZodSchemaThatSatisfies()(z.object({
	type: z.union([
		z.literal("web_search"),
		z.literal("web_search_2025_08_26"),
		z.literal("web_search_preview").transform(() => "web_search").pipe(z.literal("web_search")),
		z.literal("web_search_preview_2025_03_11").transform(() => "web_search_2025_08_26").pipe(z.literal("web_search_2025_08_26"))
	]),
	search_context_size: z.enum([
		"low",
		"medium",
		"high"
	]).optional(),
	user_location: z.object({
		type: z.literal("approximate"),
		city: z.string().nullable().optional(),
		country: z.string().nullable().optional(),
		region: z.string().nullable().optional(),
		timezone: z.string().nullable().optional()
	}).nullable().optional()
}));
const OpenAIComputerTool = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("computer_use_preview"),
	display_height: z.number(),
	display_width: z.number(),
	environment: z.enum([
		"windows",
		"mac",
		"linux",
		"ubuntu",
		"browser"
	])
}));
const OpenAIMcpTool = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("mcp"),
	server_label: z.string(),
	server_url: z.string().optional(),
	allowed_tools: z.union([z.array(z.string()), z.object({ tool_names: z.array(z.string()).optional() })]).nullable().optional(),
	headers: z.record(z.string(), z.string()).nullable().optional(),
	require_approval: z.union([
		z.literal("always"),
		z.literal("never"),
		z.object({
			always: z.object({ tool_names: z.array(z.string()).optional() }).optional(),
			never: z.object({ tool_names: z.array(z.string()).optional() }).optional()
		})
	]).nullable().optional()
}));
const OpenAICodeInterpreterTool = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("code_interpreter"),
	container: z.union([z.string(), z.object({
		type: z.literal("auto"),
		file_ids: z.array(z.string()).optional()
	})])
}));
const OpenAIImageGenerationTool = createZodSchemaThatSatisfies()(z.object({
	type: z.literal("image_generation"),
	background: z.enum([
		"transparent",
		"opaque",
		"auto"
	]).optional(),
	input_image_mask: z.object({
		file_id: z.string().optional(),
		image_url: z.string().optional()
	}).optional(),
	model: z.literal("gpt-image-1").optional(),
	moderation: z.enum(["auto", "low"]).optional(),
	output_compression: z.number().optional(),
	output_format: z.enum([
		"png",
		"webp",
		"jpeg"
	]).optional(),
	partial_images: z.number().optional(),
	quality: z.enum([
		"low",
		"medium",
		"high",
		"auto"
	]).optional(),
	size: z.enum([
		"1024x1024",
		"1024x1536",
		"1536x1024",
		"auto"
	]).optional()
}));
const OpenAILocalShellTool = createZodSchemaThatSatisfies()(z.object({ type: z.literal("local_shell") }));
const OpenAIBuiltinTool = z.discriminatedUnion("type", [
	OpenAIFileSearchTool,
	OpenAIWebSearchTool,
	OpenAIComputerTool,
	OpenAIMcpTool,
	OpenAICodeInterpreterTool,
	OpenAIImageGenerationTool,
	OpenAILocalShellTool
]);

//#endregion
//#region backend/agent/tool-schemas.ts
const IntegrationMode = z$1.enum(["personal", "company"]);
const AgentDurableObjectToolSpec = z$1.object({
	type: z$1.literal("agent_durable_object_tool"),
	methodName: z$1.string(),
	passThroughArgs: z$1.record(z$1.string(), JSONSerializable).nullable().optional(),
	overrideName: z$1.string().nullable().optional(),
	overrideDescription: z$1.string().nullable().optional(),
	overrideInputJSONSchema: z$1.any().nullable().optional(),
	strict: z$1.boolean().default(false).optional(),
	triggerLLMRequest: z$1.boolean().default(true).optional(),
	hideOptionalInputs: z$1.boolean().default(false).optional(),
	statusIndicatorText: z$1.string().nullable().optional()
});
const OpenAIBuiltinToolSpec = z$1.object({
	type: z$1.literal("openai_builtin"),
	openAITool: OpenAIBuiltinTool,
	triggerLLMRequest: z$1.boolean().default(true).optional(),
	hideOptionalInputs: z$1.boolean().default(false).optional()
});
const ToolSpec = z$1.discriminatedUnion("type", [OpenAIBuiltinToolSpec, AgentDurableObjectToolSpec]);
const MCPParam = z$1.object({
	key: z$1.string(),
	type: z$1.enum(["header", "query_param"]),
	placeholder: z$1.string(),
	description: z$1.string(),
	sensitive: z$1.boolean()
});
const MCPServer = z$1.object({
	serverUrl: z$1.string(),
	mode: IntegrationMode.default("personal"),
	integrationSlug: z$1.string().optional(),
	allowedTools: z$1.array(z$1.string()).optional(),
	allowedPrompts: z$1.array(z$1.string()).optional(),
	allowedResources: z$1.array(z$1.string()).optional(),
	triggerLLMRequest: z$1.boolean().default(true).optional(),
	requiresParams: z$1.array(MCPParam).optional()
});

//#endregion
//#region backend/agent/iterate-agent-tools.ts
const iterateAgentTools = defineDOTools({
	ping: {
		description: "Simple ping method that returns a pong response",
		statusIndicatorText: "🏓 pinging"
	},
	shareFileWithSlack: {
		description: "Share an iterate file in the current Slack thread. Use after uploading or generating a file.",
		statusIndicatorText: "📎 sharing file",
		input: z$1.object({
			iterateFileId: z$1.string().describe("The iterate file id to share"),
			originalFilename: z$1.string().optional()
		})
	},
	flexibleTestTool: {
		description: "Flexible testing tool that can simulate slow responses, errors, or return secrets based on behaviour",
		input: z$1.object({ params: z$1.discriminatedUnion("behaviour", [
			z$1.object({
				behaviour: z$1.literal("slow-tool"),
				recordStartTime: z$1.boolean().default(false).describe("Whether to record the start time of the tool call"),
				delay: z$1.number().describe("Delay in milliseconds before responding"),
				response: z$1.string().describe("Response message to return after delay")
			}),
			z$1.object({
				behaviour: z$1.literal("raise-error"),
				error: z$1.string().describe("Error message to throw")
			}),
			z$1.object({
				behaviour: z$1.literal("return-secret"),
				secret: z$1.string().describe("Secret value to return")
			})
		]) })
	},
	reverse: {
		description: "Reverse a string",
		input: z$1.object({ message: z$1.string() })
	},
	doNothing: {
		description: "This ends your turn without sending a message to the user. Use this when you believe the other users are now talking amongst themselves and not expecting a response from you. For example: \nUser A: @iterate can you make a linear issue?\n @iterate (You, the agent): Yes I've done that\n User B:L @UserA why did you do that \n @iterate: doNothing({ reason: 'Users are talking to each other' }). This should never be called in parallel with another tool.",
		statusIndicatorText: "🙈 sitting this one out",
		input: z$1.object({ reason: z$1.string().describe("Very short reason for why you are not responding. For example 'User X and Y are talking amongst themselves' or 'the conversation has moved on to a tangent i can't help with'") })
	},
	getAgentDebugURL: {
		description: "Get the debug URL for this agent instance. Only use this when EXPLICITLY asked by the user.",
		statusIndicatorText: "🔗 getting debug url",
		input: z$1.object({})
	},
	remindMyselfLater: {
		input: z$1.object({
			message: z$1.string().describe("The message you wish to be reminded of later. This will be shared with you verbatim in the form of a developer message later."),
			type: z$1.enum([
				"numberOfSecondsFromNow",
				"atSpecificDateAndTime",
				"recurringCron"
			]).describe("The type of reminder scheduling: 'numberOfSecondsFromNow' for delays in seconds, 'atSpecificDateAndTime' for specific dates/times, or 'recurringCron' for repeating schedules"),
			when: z$1.string().describe("The timing specification interpreted based on type: for 'numberOfSecondsFromNow' use a positive number (e.g., '300' for 5 minutes), for 'atSpecificDateAndTime' use an ISO 8601 date-time string (e.g., '2024-12-25T10:00:00Z'), for 'recurringCron' use a cron expression (e.g., '0 9 * * 1' for every Monday at 9am)")
		}),
		description: "Set a reminder for yourself to receive at a future time or on a recurring basis. You will receive the message string verbatim. So phrase it in a way that's addressed to yourself. E.g. 'You should now ask the user if they need anything else' etc",
		statusIndicatorText: "⏰ setting reminder"
	},
	listMyReminders: {
		description: "List all active reminders that have been set.",
		statusIndicatorText: "📋 listing reminders",
		input: z$1.object({})
	},
	cancelReminder: {
		description: "Cancel a previously set reminder by its ID.",
		statusIndicatorText: "🚫 canceling reminder",
		input: z$1.object({ iterateReminderId: z$1.string() })
	},
	connectMCPServer: {
		description: dedent$1`
      Connect to a remote MCP (Model Context Protocol) server.
      This will make additional tools available to you.
    `,
		statusIndicatorText: "🔌 connecting to mcp server",
		input: z$1.object({
			serverUrl: z$1.string().describe("The URL of the MCP server"),
			mode: IntegrationMode.default("personal").describe("The integration mode for the MCP server. personal means each user gets their own isntance of the MCP server and authenticates individually, company means a single MCP server is shared by everone in the company it is authenticated once for all users"),
			requiresHeadersAuth: z$1.record(z$1.string(), MCPParam.pick({
				placeholder: true,
				description: true,
				sensitive: true
			})).nullable().describe("Set when headers are required to authenticate (use for non-OAuth servers that require authentication). Provide an object with placeholder configuration for each header."),
			requiresQueryParamsAuth: z$1.record(z$1.string(), MCPParam.pick({
				placeholder: true,
				description: true,
				sensitive: true
			})).nullable().describe("Set when query params are required to authenticate (use for non-OAuth servers that require authentication). Provide an object with placeholder configuration for each query parameter."),
			onBehalfOfIterateUserId: z$1.string().describe("The iterate user ID to connect on behalf of.")
		})
	},
	getURLContent: {
		description: "Get the content of a URL, including Slack message threads",
		statusIndicatorText: "🌐 visiting url",
		input: z$1.object({
			url: z$1.string(),
			includeScreenshotOfPage: z$1.boolean().default(false).describe("Set to true to capture a screenshot of the webpage. Screenshots are useful for visual content, layout issues, text which is isn't matched, or when you need to see what the page looks like. Defaults to false.").optional(),
			includeTextContent: z$1.boolean().default(true).describe("Set to true to extract text content from the webpage. This includes the full text, title, and other metadata. Defaults to true.").optional()
		})
	},
	searchWeb: {
		description: "Search the web using exa (think of it like a better google)",
		statusIndicatorText: "🔍 searching the web",
		input: z$1.object({
			query: z$1.string(),
			numResults: z$1.number().optional().default(10)
		})
	},
	generateImage: {
		description: "Create or edit an image using the Replicate API. Multiple input images can be provided, but inputImages is optional.",
		statusIndicatorText: "🎨 generating image",
		input: z$1.object({
			prompt: z$1.string(),
			inputImages: z$1.array(z$1.string()).default([]),
			model: z$1.custom((val) => {
				return typeof val === "string" && /^(?:[^/\s]+)\/(?:[^:/\s]+)(?::[^\s]+)?$/.test(val);
			}, "Model must be in the form 'owner/name' or 'owner/name:tag'").default("openai/gpt-image-1").describe("The replicate model to use. Only set this when explicitly asked to do so. Must be in the form 'owner/name' or 'owner/name:tag'"),
			quality: z$1.enum([
				"low",
				"medium",
				"high"
			]).default("high"),
			background: z$1.enum([
				"auto",
				"transparent",
				"opaque"
			]).default("auto"),
			overrideReplicateParams: z$1.record(z$1.string(), z$1.any()).optional()
		})
	},
	exec: {
		description: "Execute a shell in a sandbox. This should be used for making commits and PRs using git, gh and to perform simple-read-only shell commands.",
		statusIndicatorText: "⚙️ running command",
		input: z$1.object({
			command: z$1.string(),
			files: z$1.array(z$1.object({
				path: z$1.string().describe("The path to the file in the sandbox. If the path is a relative path, it will be created in a sandbox working directory"),
				content: z$1.string()
			})).optional().describe("Files to create in the sandbox before running the command (generally not required)"),
			env: z$1.record(z$1.string(), z$1.string()).optional()
		})
	},
	execCodex: {
		description: "Ask codex to perform a task in the sandbox.",
		statusIndicatorText: "⚙️ running command",
		input: z$1.object({ command: z$1.string() })
	},
	deepResearch: {
		description: "Conduct comprehensive deep research on a topic using Parallel AI. This tool performs multi-step web exploration across authoritative sources and synthesizes findings into a structured report with citations. Best for open-ended research questions that require analyst-grade intelligence. Note: Deep research can take several minutes to complete, so clarify user needs first.",
		statusIndicatorText: "🔬 conducting deep research",
		input: z$1.object({
			query: z$1.string().describe("A detailed research question or topic to investigate. Be specific and include relevant context for better results - ask the user for clarification or elaboration first. Keep under 15,000 characters."),
			processor: z$1.enum([
				"lite",
				"base",
				"core",
				"core2x",
				"pro",
				"pro-fast",
				"ultra",
				"ultra-fast",
				"ultra2x",
				"ultra4x",
				"ultra8x"
			]).default("pro").describe("Research processor. lite/base/core for quick lookups (10s-5min). pro for exploratory research (2-10min). ultra for advanced multi-source research (5-25min). ultra2x/4x/8x for very difficult research (up to 2hr). Add '-fast' suffix (pro-fast, ultra-fast) for 2-5x faster but slightly less accurate results.")
		})
	},
	uploadFile: {
		description: "Upload a file from the sandbox to iterate. Returns the file id, which you can then use to share via slack or other means.",
		statusIndicatorText: "📂 uploading file",
		input: z$1.object({ path: z$1.string().describe("The absolute path to the file in the sandbox.") })
	},
	generateVideo: {
		description: "Generate a video using OpenAI's SORA 2 model. The video generation is asynchronous and may take several minutes to complete.",
		statusIndicatorText: "🎬 generating video",
		input: z$1.object({
			prompt: z$1.string().describe("Text prompt that describes the video to generate"),
			inputReferenceFileId: z$1.string().optional().describe("Optional image or video file id that guides generation. Must match the generated video size"),
			model: z$1.enum(["sora-2", "sora-2-pro"]).default("sora-2").describe("The video generation model to use. Defaults to sora-2"),
			seconds: z$1.enum([
				"4",
				"8",
				"12"
			]).default("4").describe("Clip duration in seconds"),
			size: z$1.enum([
				"720x1280",
				"1280x720",
				"1024x1792",
				"1792x1024"
			]).default("720x1280").describe("Output resolution formatted as width x height")
		})
	},
	callGoogleAPI: {
		description: "Call a Google API endpoint with automatic authentication and token refresh",
		statusIndicatorText: "📞 calling google api",
		input: z$1.object({
			endpoint: z$1.string().describe("The API endpoint path (e.g., '/gmail/v1/users/me/messages/send' or '/calendar/v3/calendars/primary/events')"),
			method: z$1.enum([
				"GET",
				"POST",
				"PUT",
				"PATCH",
				"DELETE"
			]).describe("The HTTP method to use"),
			body: z$1.any().optional().describe("The request body (will be JSON stringified)"),
			queryParams: z$1.record(z$1.string(), z$1.string()).optional().describe("Query parameters to append to the URL"),
			pathParams: z$1.record(z$1.string(), z$1.string()).optional().describe("Path parameters to insert into the URL. Path parameters are placeholders in the endpoint path represented as [param] that are replaced with the values in this object."),
			impersonateUserId: z$1.string().describe("The user ID to use for authentication")
		})
	},
	sendGmail: {
		description: "Send an email via Gmail. Can also reply to emails by providing threadId and inReplyTo.",
		statusIndicatorText: "📧 sending email",
		input: z$1.object({
			to: z$1.string().describe("Recipient email address"),
			subject: z$1.string().describe("Email subject"),
			body: z$1.string().describe("Email body (plain text)"),
			cc: z$1.string().optional().describe("CC email addresses (comma-separated)"),
			bcc: z$1.string().optional().describe("BCC email addresses (comma-separated)"),
			threadId: z$1.string().optional().describe("Thread ID to reply to (from getGmailMessage)"),
			inReplyTo: z$1.string().optional().describe("Message ID to reply to (from getGmailMessage headers)"),
			impersonateUserId: z$1.string().describe("The user ID to use for authentication")
		})
	},
	getGmailMessage: {
		description: "Get the full content of a specific Gmail message by ID. Returns the email with decoded text body.",
		statusIndicatorText: "📬 fetching email",
		input: z$1.object({
			messageId: z$1.string().describe("The ID of the message to retrieve"),
			impersonateUserId: z$1.string().describe("The user ID to use for authentication")
		})
	},
	addLabel: {
		description: "Add a label to the agent's metadata to enable specific tool sets",
		statusIndicatorText: "🏷️ adding label",
		input: z$1.object({ label: z$1.string().describe("Label to add (e.g., 'GMAIL', 'GCALENDAR')") })
	},
	messageAgent: {
		description: "Send a message to another agent. The target agent will receive the message and can respond to it asynchronously.",
		statusIndicatorText: "💬 sending message",
		input: z$1.object({
			agentName: z$1.string().describe("The name of the target agent to send the message to"),
			message: z$1.string().describe("The message content to send"),
			triggerLLMRequest: z$1.boolean().default(true).describe("Whether to trigger an LLM request in the target agent (default: true)")
		})
	}
});

//#endregion
//#region backend/agent/slack-agent-tools.ts
const slackAgentTools = defineDOTools({
	sendSlackMessage: {
		description: `Send a slack message to the thread you are currently active in.`,
		statusIndicatorText: "✏️ writing response",
		input: z$1.object({
			text: z$1.string().describe("The message text (required if blocks not provided)"),
			blocks: z$1.array(z$1.record(z$1.string(), z$1.any())).optional().describe("Array of slack block objects"),
			ephemeral: z$1.boolean().optional().describe("Whether to send as ephemeral message (visible only to specific user). Requires 'user' field when true."),
			user: z$1.string().optional().describe("Slack user ID to send ephemeral message to (required when ephemeral=true)"),
			metadata: z$1.object({
				event_type: z$1.string(),
				event_payload: z$1.any()
			}).optional().describe("Optional metadata for tracking message events"),
			modalDefinitions: z$1.record(z$1.string(), z$1.any()).optional().describe("Modal definitions for button interactions - maps action_id to modal view definition"),
			unfurl: z$1.enum([
				"never",
				"auto",
				"all"
			]).default("auto").optional().describe("Whether to unfurl links and media."),
			endTurn: z$1.boolean().default(false).optional().describe("Optional. Set this to true only if you want to yield to the user and end your turn. For example because you've asked them for input on something or if you think you're done and there's nothing left for you to do.")
		})
	},
	addSlackReaction: {
		description: "Add an emoji reaction to a Slack message",
		statusIndicatorText: "👍 adding reaction",
		input: z$1.object({
			messageTs: z$1.string().describe("The ts of the message to react to"),
			name: z$1.string().describe("The emoji name (without colons, e.g., 'thumbsup')")
		})
	},
	removeSlackReaction: {
		description: "Remove an emoji reaction from a Slack message",
		statusIndicatorText: "✖️ removing reaction",
		input: z$1.object({
			messageTs: z$1.string().describe("The ts of the message to remove reaction from"),
			name: z$1.string().describe("The emoji name (without colons, e.g., 'thumbsup')")
		})
	},
	updateSlackMessage: {
		description: "Update a message in a Slack channel. This is useful for updating the content of a message after it has been sent.",
		statusIndicatorText: "✏️ updating message",
		input: z$1.object({
			ts: z$1.string().describe("The timestamp of the message to update"),
			text: z$1.string().optional().describe("Updated message text")
		})
	},
	stopRespondingUntilMentioned: {
		description: "After you call this tool, you will not get a turn after any user messages, unless they explicitly mention you. Use this only when someone asks you to stop/ be quiet/enough/ shut-up, or reacts with 🤫/💤/🤐 to one of your messages. Or when you are explicitly asked to use it. This will cause you to add a zipper mouth emoji reaction to the most recent user message automatically (you don't need to do this)",
		statusIndicatorText: "🤐 shutting up",
		input: z$1.object({ reason: z$1.string().describe("Very short reason for why you want to disengage from this slack thread until mentioned. For example 'User X told me to shut up' or 'User Y responded with 🤫 to my message' or 'the conversation has moved on to a tangent i can't help with'") })
	},
	uploadAndShareFileInSlack: {
		description: "DO NOT USE - this is just here so old agents don't get bricked",
		input: z$1.object({ iterateFileId: z$1.string().describe("The ID of the file to upload") })
	}
});

//#endregion
//#region backend/agent/prompt-fragments.ts
const PromptFragment = z.lazy(() => z.union([
	z.null(),
	z.string(),
	z.object({
		tag: z.string().optional(),
		content: PromptFragment
	}),
	z.array(PromptFragment)
]));
/**
* Create a prompt fragment with an optional XML tag wrapper.
* This is a utility function for creating structured prompt fragments.
*
* @param tag - The XML tag name to wrap the content
* @param content - The fragment content(s) - can be strings, objects, or arrays
* @returns A PromptFragmentObject with the specified tag and content
*
* @example
* // Simple fragment
* f("role", "You are a helpful assistant")
*
* // Nested fragments
* f("rules",
*   "Follow these guidelines:",
*   f("important", "Be concise"),
*   f("important", "Be accurate")
* )
*/
function f(tag, ...content) {
	return {
		tag,
		content
	};
}

//#endregion
//#region backend/agent/context.ts
function always() {
	return { type: "always" };
}
function never() {
	return { type: "never" };
}
function jsonata(expression) {
	return {
		type: "jsonata",
		expression
	};
}
function hasParticipant(searchString) {
	return {
		type: "jsonata",
		expression: `$contains($string(agentCoreState.participants), ${JSON.stringify(searchString)})`
	};
}
function slackChannel(channelIdOrName) {
	return {
		type: "jsonata",
		expression: `agentCoreState.slackChannelId = "${channelIdOrName}" or agentCoreState.slackChannel.name = "${channelIdOrName.toLowerCase().replace(/^#/, "")}"`
	};
}
function slackChannelHasExternalUsers(hasExternalUsers) {
	return {
		type: "jsonata",
		expression: `agentCoreState.slackChannel.isShared = ${hasExternalUsers} or agentCoreState.slackChannel.isExtShared = ${hasExternalUsers}`
	};
}
function and(...inner) {
	return {
		type: "and",
		matchers: inner
	};
}
function or(...inner) {
	return {
		type: "or",
		matchers: inner
	};
}
function not(inner) {
	return {
		type: "not",
		matcher: inner
	};
}
function contextContains(searchString) {
	return {
		type: "jsonata",
		expression: `$contains(
    $string(agentCoreState.systemPrompt) &
    $string(agentCoreState.inputItems) &
    $string(agentCoreState.ephemeralPromptFragments) &
    $string(agentCoreState.runtimeTools),
    ${JSON.stringify(searchString)}
  )`
	};
}
function hasTool(searchString) {
	return {
		type: "jsonata",
		expression: `$contains($string(agentCoreState.runtimeTools), ${JSON.stringify(searchString)})`
	};
}
function hasMCPConnection(searchString) {
	return {
		type: "jsonata",
		expression: `$count(
    agentCoreState.mcpConnections.*[
      $contains($string(serverUrl), ${JSON.stringify(searchString)}) or
      $contains($string(serverName), ${JSON.stringify(searchString)})
    ]
  ) > 0`
	};
}
function forAgentClass(className) {
	return {
		type: "jsonata",
		expression: `durableObjectClassName = ${JSON.stringify(className)}`
	};
}
function sandboxStatus(status) {
	return {
		type: "jsonata",
		expression: `agentCoreState.metadata.sandboxStatus = ${JSON.stringify(status)}`
	};
}
function hasLabel(label) {
	return {
		type: "jsonata",
		expression: `${JSON.stringify(label)} in agentCoreState.metadata.labels`
	};
}
const matchers = {
	never,
	always,
	jsonata,
	hasParticipant,
	slackChannel,
	slackChannelHasExternalUsers,
	contextContains,
	hasTool,
	hasMCPConnection,
	forAgentClass,
	sandboxStatus,
	hasLabel,
	and,
	or,
	not,
	timeWindow
};
const defineRule = (rule) => rule;
const defineRules = (rules) => rules;
function timeWindow(windows, opts) {
	return {
		type: "timeWindow",
		windows: Array.isArray(windows) ? windows : [windows],
		tz: opts?.tz
	};
}
/**
* Parses front matter from a file content string.
* Front matter is delimited by triple dashes (---) at the start of the file.
* Returns the parsed front matter object and the remaining content.
* The match field is automatically converted: strings become jsonata expressions,
* objects are treated as ContextRuleMatcher directly.
*/
function parseFrontMatter(content) {
	const trimmedContent = content.trim();
	if (!trimmedContent.startsWith("---")) return {
		frontMatter: {},
		body: content
	};
	const lines = trimmedContent.split("\n");
	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") {
		endIndex = i;
		break;
	}
	if (endIndex === -1) return {
		frontMatter: {},
		body: content
	};
	const frontMatterText = lines.slice(1, endIndex).join("\n");
	const body = lines.slice(endIndex + 1).join("\n").trim();
	try {
		const result = parse(frontMatterText) || {};
		if (result.match !== void 0 && result.match !== null) {
			if (typeof result.match === "string") result.match = {
				type: "jsonata",
				expression: result.match
			};
		}
		return {
			frontMatter: result,
			body
		};
	} catch (error) {
		console.error(`Failed to parse front matter as YAML:`, error);
		return {
			frontMatter: {},
			body: content
		};
	}
}
/**
* Helper function to create context rules from files matching a glob pattern.
* Each file becomes a context rule with slug derived from filename and prompt from file content.
* Supports YAML front matter for overriding context rule properties.
*/
function contextRulesFromFiles(pattern, overrides = {}) {
	try {
		const configDir = findIterateConfig();
		if (!configDir) throw new Error("iterate.config.ts not found");
		return globSync(pattern, { cwd: configDir }).map((filePath) => {
			const { frontMatter, body } = parseFrontMatter(readFileSync(join(configDir, filePath), "utf-8"));
			return defineRule({
				key: filePath.replace(/\.md$/, ""),
				prompt: `<!-- Source: ${filePath} -->\n\n${body}`,
				...frontMatter,
				...overrides
			});
		});
	} catch (error) {
		console.error(`Error reading files with pattern ${pattern}:`, error);
		return [];
	}
}
const findIterateConfig = (root = process.cwd()) => {
	const envPath = process.env.ITERATE_CONFIG_PATH;
	if (envPath) {
		const candidates = [resolve(root, envPath), resolve(root, "..", "..", envPath)];
		for (const candidate of candidates) try {
			accessSync(candidate);
			return dirname(candidate);
		} catch {}
	}
	try {
		const lines = ((/* @__PURE__ */ new Error()).stack ?? "").split("\n");
		for (const line of lines) {
			if (!line.includes("iterate.config.ts")) continue;
			const fileUrlMatch = line.match(/(file:\/\/[^^\s)]+?\/iterate\.config\.ts)/);
			if (fileUrlMatch) return dirname(resolve(fileURLToPath(fileUrlMatch[1])));
			const posixMatch = line.match(/(\/[^^\s)]+?\/iterate\.config\.ts)/);
			if (posixMatch) return dirname(resolve(posixMatch[1]));
			const winMatch = line.match(/([A-Za-z]:\\[^\s)]+?\\iterate\.config\.ts)/);
			if (winMatch) return dirname(resolve(winMatch[1]));
		}
	} catch {}
	let currentDir = resolve(root);
	const rootDir = resolve("/");
	while (currentDir !== rootDir) {
		const configPath = join(currentDir, "iterate.config.ts");
		try {
			accessSync(configPath);
			return currentDir;
		} catch {
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
		}
	}
	return null;
};

//#endregion
//#region sdk/iterate-config.ts
function defineConfig(config) {
	return config;
}

//#endregion
//#region sdk/index.ts
const tools = {
	...createDOToolFactory(iterateAgentTools),
	...createDOToolFactory(slackAgentTools)
};

//#endregion
export { contextRulesFromFiles, dedent, defineConfig, defineRule, defineRules, f, matchers, tools };