/**
 * Standalone Onboarding Stalking Agent
 *
 * This script uses the Claude Agent SDK to autonomously gather comprehensive
 * company information given just a domain name. It outputs ONLY structured JSON
 * to stdout - no chat messages, no progress indicators.
 *
 * Usage:
 *   doppler run -- COMPANY_DOMAIN=example.com node --import tsx apps/os/backend/agent/stalking-agent.ts
 *
 * Output:
 *   - Stdout: Clean JSON matching the COMPANY_RESEARCH_TOOL schema
 *   - Stderr: Error messages only (if any)
 *
 * Required environment variables (via Doppler):
 *   - ANTHROPIC_API_KEY: Your Anthropic API key
 *   - LOGO_DEV_PUBLISHABLE_KEY: Logo.dev publishable key (format: pk_...)
 *   - COMPANY_DOMAIN: Target company domain (e.g., example.com)
 */

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

// Configuration
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const COMPANY_DOMAIN = process.env.COMPANY_DOMAIN;
const LOGO_DEV_PUBLISHABLE_KEY = process.env.LOGO_DEV_PUBLISHABLE_KEY;
const EXA_API_KEY = process.env.EXA_API_KEY;
const MODEL = "claude-sonnet-4-5-20250929";

// Validate required environment variables
if (!ANTHROPIC_API_KEY) {
  console.error("Error: ANTHROPIC_API_KEY environment variable is required");
  console.error(
    "Use Doppler: doppler run -- COMPANY_DOMAIN=example.com node --import tsx apps/os/backend/agent/stalking-agent.ts",
  );
  process.exit(1);
}

if (!COMPANY_DOMAIN) {
  console.error("Error: COMPANY_DOMAIN environment variable is required");
  console.error(
    "Usage: doppler run -- COMPANY_DOMAIN=example.com node --import tsx apps/os/backend/agent/stalking-agent.ts",
  );
  process.exit(1);
}

if (!LOGO_DEV_PUBLISHABLE_KEY) {
  console.error("Error: LOGO_DEV_PUBLISHABLE_KEY environment variable is required");
  console.error("Add it to Doppler or set it via: export LOGO_DEV_PUBLISHABLE_KEY=pk_...");
  process.exit(1);
}

if (!EXA_API_KEY) {
  console.error("Error: EXA_API_KEY environment variable is required");
  console.error("Add it to Doppler or set it via: export EXA_API_KEY=your_key");
  process.exit(1);
}

// Create Exa research tool
const exaResearch = tool(
  "exa_research",
  "Performs deep web research on a given topic using Exa's AI research capabilities. Returns comprehensive research findings with sources. Use this tool to gather high-quality, factual information about companies, industries, funding, competitors, and other topics.",
  {
    instructions: {
      type: "string",
      description: "The research task or question to investigate (max 4096 characters)",
    },
  } as any,
  async (args) => {
    try {
      const { instructions } = args;

      // Create research task
      const createResponse = await fetch("https://api.exa.ai/research/v1/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": EXA_API_KEY!,
        },
        body: JSON.stringify({
          model: "exa-research",
          instructions,
        }),
      });

      if (!createResponse.ok) {
        const errorData = await createResponse.json();
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create Exa research task: ${JSON.stringify(errorData)}`,
            },
          ],
          isError: true,
        };
      }

      const createData = (await createResponse.json()) as { researchId: string };

      // Poll for completion (check every 3 seconds, max 5 minutes)
      const maxAttempts = 100;
      let attempts = 0;

      while (attempts < maxAttempts) {
        const statusResponse = await fetch(
          `https://api.exa.ai/research/v1/${createData.researchId}`,
          {
            headers: {
              "x-api-key": EXA_API_KEY!,
            },
          },
        );

        if (!statusResponse.ok) {
          const errorData = await statusResponse.json();
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to check research status: ${JSON.stringify(errorData)}`,
              },
            ],
            isError: true,
          };
        }

        const statusData = (await statusResponse.json()) as {
          status: string;
          output?: string;
          events?: unknown;
        };

        if (statusData.status === "completed") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Research completed successfully:\n\n${statusData.output}\n\nSources and details:\n${JSON.stringify(statusData.events, null, 2)}`,
              },
            ],
          };
        } else if (statusData.status === "failed") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Research task failed: ${JSON.stringify(statusData)}`,
              },
            ],
            isError: true,
          };
        } else if (statusData.status === "canceled") {
          return {
            content: [
              {
                type: "text" as const,
                text: "Research task was canceled",
              },
            ],
            isError: true,
          };
        }

        // Still pending or running, wait and retry
        await new Promise((resolve) => setTimeout(resolve, 3000));
        attempts++;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Research task timed out after 5 minutes",
          },
        ],
        isError: true,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error in exa_research: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Create MCP server with the Exa research tool
const exaMcpServer = createSdkMcpServer({
  name: "exa-research-server",
  version: "1.0.0",
  tools: [exaResearch],
});

async function runStalkingAgent() {
  try {
    const prompt = `Research the company at domain: ${COMPANY_DOMAIN}

Your task: Gather comprehensive company information and output ONLY a JSON object.

## Research Strategy

Use ALL available tools to gather information. Cross-reference and fact-check across multiple sources:

**exa_research**: Deep web research for funding, competitors, news, team info, industry context
**WebFetch**: Company website content for branding, tone, products, official info
**WebSearch**: Additional context, verification, filling gaps

Run tools in parallel where possible. When sources conflict, prefer official company sources > recent news > third-party data.

## What to Extract

**From Website (${COMPANY_DOMAIN})**:
- Homepage: name, tagline, value proposition, products, brand colors (CSS/hex codes), fonts, tone of voice, target customers
- About page: founding year, team size, location, history
- Brand/press pages: brand assets, colors, fonts

**Tone of Voice**: Analyze writing style - is it professional, casual, technical, friendly, authoritative? Describe in 1-2 sentences.

**Target Customers**: Who is the product for? Look for explicit mentions, use cases, testimonials, customer examples.

**From Research (exa_research + WebSearch)**:
- Funding: total raised, last round details, investors
- Competitors: similar companies in the space
- Recent news: announcements, milestones, updates
- Team: employee count, founders, key people
- Tech stack: technologies used
- Culture: values, work style, benefits

## Logo URL

Use: https://img.logo.dev/${COMPANY_DOMAIN}?token=${LOGO_DEV_PUBLISHABLE_KEY}&size=512&format=png

## Data Quality Rules

- Use null for fields where information is not found
- Do NOT guess or speculate
- Cross-reference multiple sources for accuracy
- Confidence: high (>80% fields filled), medium (40-80%), low (<40%)
- Include current ISO 8601 timestamp in metadata.scrapedAt

## OUTPUT FORMAT - STRICT REQUIREMENTS

After completing ALL research:
1. Output ONLY a JSON object in a markdown code block
2. NO conversational text before or after the JSON
3. NO explanations of what you did
4. The JSON MUST be valid and match this EXACT structure:

\`\`\`json
{
  "company": {
    "name": "string",
    "domain": "string",
    "description": "string (2-3 sentences)",
    "tagline": "string or null",
    "founded": "string (YYYY) or null",
    "location": {
      "city": "string or null",
      "state": "string or null",
      "country": "string or null",
      "fullAddress": "string or null"
    },
    "teamSize": "string or null",
    "industry": "string or null",
    "stage": "string or null"
  },
  "branding": {
    "logoUrl": "string (Logo.dev URL)",
    "colors": {
      "primary": "string (hex) or null",
      "secondary": "string (hex) or null",
      "accent": "string (hex) or null",
      "additional": ["array of hex codes"]
    },
    "fonts": {
      "heading": "string or null",
      "body": "string or null"
    },
    "toneOfVoice": "string or null (description of brand voice: professional, casual, technical, friendly, etc.)",
    "brandAssets": ["array of URLs"]
  },
  "targetCustomers": {
    "description": "string or null (who the product/service is for)",
    "segments": ["array of customer segments/personas"]
  },
  "products": [{"name": "string", "description": "string", "url": "string or null"}],
  "contact": {
    "email": "string or null",
    "phone": "string or null",
    "address": "string or null"
  },
  "socials": {
    "twitter": "string or null",
    "linkedin": "string or null",
    "github": "string or null",
    "facebook": "string or null",
    "instagram": "string or null",
    "youtube": "string or null",
    "discord": "string or null",
    "slack": "string or null"
  },
  "techStack": [{"category": "string", "technologies": ["array of strings"]}],
  "culture": {
    "values": ["array of strings"],
    "summary": "string or null",
    "benefits": ["array of strings"],
    "workStyle": "string or null"
  },
  "funding": {
    "totalRaised": "string or null",
    "lastRound": {
      "type": "string or null",
      "amount": "string or null",
      "date": "string (YYYY-MM-DD) or null",
      "investors": ["array of strings"]
    }
  },
  "recentNews": [{"title": "string", "summary": "string", "date": "string or null", "url": "string"}],
  "competitors": [{"name": "string", "url": "string or null"}],
  "additionalAssets": [{"type": "string", "url": "string", "description": "string"}],
  "metadata": {
    "scrapedAt": "string (ISO 8601)",
    "confidence": "high|medium|low",
    "notes": "string or null"
  }
}
\`\`\`

CRITICAL: Output ONLY the JSON in a \`\`\`json code block. NO other text allowed.`;

    const queryResult = query({
      prompt,
      options: {
        model: MODEL,
        cwd: process.cwd(),
        systemPrompt:
          "You are a research bot that outputs ONLY JSON. Use ALL available tools (exa_research, WebFetch, WebSearch) to gather comprehensive information. Cross-reference sources and fact-check. Output ONLY a JSON object in a ```json code block with NO other text. Do NOT explain your process.",
        mcpServers: {
          "exa-research": exaMcpServer,
        },
        allowedTools: ["WebFetch", "WebSearch", "exa_research"],
        permissionMode: "bypassPermissions",
        maxTurns: 30, // Increased to allow for Exa research calls
        stderr: () => {}, // Suppress stderr output
      },
    });

    // Collect all assistant messages to extract JSON
    let fullResponse = "";
    for await (const message of queryResult) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            fullResponse += block.text;
          }
        }
      }
    }

    // Extract JSON from markdown code block
    const jsonMatch = fullResponse.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      const jsonString = jsonMatch[1];
      // Validate it's valid JSON before outputting
      try {
        const parsed = JSON.parse(jsonString);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.error("Error: Agent produced invalid JSON");
        console.error(jsonString);
        process.exit(1);
      }
    } else {
      console.error("Error: No JSON found in agent response");
      console.error("Response:", fullResponse);
      process.exit(1);
    }
  } catch (error) {
    console.error("Error running stalking agent:");
    console.error(error);
    process.exit(1);
  }
}

// Run the agent
runStalkingAgent();
