import { z } from "zod/v4";
import dedent from "dedent";
import { eq } from "drizzle-orm";
import { SearchRequest } from "../default-tools.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import type { ContextRule } from "./context-schemas.ts";
import { createDOToolFactory, type DOToolDefinitions } from "./do-tools.ts";
import { iterateAgentTools } from "./iterate-agent-tools.ts";
import { IterateAgent } from "./iterate-agent.ts";
import type { CoreAgentSlices, IterateAgentState } from "./iterate-agent.ts";
import { onboardingAgentTools } from "./onboarding-agent-tools.ts";
import { startSlackAgentInChannel } from "./start-slack-agent-in-channel.ts";

type ToolsInterface = typeof onboardingAgentTools.$infer.interface;
type Inputs = typeof onboardingAgentTools.$infer.inputTypes;

// Company context gathered by stalking agent
const CompanyContext = z
  .object({
    company: z.object({
      name: z.string(),
      domain: z.string(),
      description: z.string().nullish(),
      tagline: z.string().nullish(),
      founded: z.string().nullish(),
      location: z
        .object({
          city: z.string().nullish(),
          state: z.string().nullish(),
          country: z.string().nullish(),
          fullAddress: z.string().nullish(),
        })
        .nullish(),
      teamSize: z.string().nullish(),
      industry: z.string().nullish(),
      stage: z.string().nullish(),
    }),
    branding: z
      .object({
        logoUrl: z.string().nullish(),
        colors: z
          .object({
            primary: z.string().nullish(),
            secondary: z.string().nullish(),
            accent: z.string().nullish(),
            additional: z.array(z.string()).nullish(),
          })
          .nullish(),
        fonts: z
          .object({
            heading: z.string().nullish(),
            body: z.string().nullish(),
          })
          .nullish(),
        toneOfVoice: z.string().nullish(),
        brandAssets: z.array(z.string()).nullish(),
      })
      .nullish(),
    targetCustomers: z
      .object({
        description: z.string().nullish(),
        segments: z.array(z.string()).nullish(),
      })
      .nullish(),
    products: z
      .array(
        z.object({
          name: z.string(),
          description: z.string(),
          url: z.string().nullish(),
        }),
      )
      .nullish(),
    funding: z
      .object({
        totalRaised: z.string().nullish(),
        lastRound: z
          .object({
            type: z.string().nullish(),
            amount: z.string().nullish(),
            date: z.string().nullish(),
            investors: z.array(z.string()).nullish(),
          })
          .nullish(),
      })
      .nullish(),
    competitors: z
      .array(
        z.object({
          name: z.string(),
          url: z.string().nullish(),
        }),
      )
      .nullish(),
    metadata: z
      .object({
        scrapedAt: z.string(),
        confidence: z.enum(["high", "medium", "low"]).nullish(),
        notes: z.string().nullish(),
      })
      .nullish(),
  })
  .nullish();

const OnboardingChecklist = z
  .object({
    firstToolConnected: z.boolean().default(false),
    remoteMCPConnected: z.boolean().default(false),
    learnedBotUsageEverywhere: z.boolean().default(false),
    editedRulesForTone: z.boolean().default(false),
    communityInviteSent: z.boolean().default(false),
  })
  .default({
    firstToolConnected: false,
    remoteMCPConnected: false,
    learnedBotUsageEverywhere: false,
    editedRulesForTone: false,
    communityInviteSent: false,
  });

export const OnboardingData = z.object({
  // Legacy field for backward compatibility
  researchResults: z.record(z.string(), z.unknown()).optional(),
  // New structured company context
  companyContext: CompanyContext,
  // Onboarding progress checklist
  onboardingChecklist: OnboardingChecklist,
});

export type OnboardingData = z.infer<typeof OnboardingData>;

type OnboardingAgentState = IterateAgentState & {
  onboardingData?: OnboardingData;
  ashsStuffRan?: boolean;
};

export class OnboardingAgent
  extends IterateAgent<CoreAgentSlices, OnboardingAgentState>
  implements ToolsInterface
{
  toolDefinitions(): DOToolDefinitions<{}> {
    return {
      ...super.toolDefinitions(),
      ...onboardingAgentTools,
    };
  }

  protected async getContextRules(): Promise<ContextRule[]> {
    // We just start with a completely blank slate here and don't
    // pull in anything from iterate config. Want to have maximum control.
    const iterateAgentTool = createDOToolFactory(iterateAgentTools);
    const onboardingAgentTool = createDOToolFactory(onboardingAgentTools);

    // Get the company domain from organization name or extract from user email
    const companyDomain = this.extractCompanyDomain();
    const logoUrl =
      companyDomain && this.env.LOGO_DEV_PUBLISHABLE_KEY
        ? `https://img.logo.dev/${companyDomain}?token=${this.env.LOGO_DEV_PUBLISHABLE_KEY}&size=512&format=png`
        : null;

    return [
      {
        key: "onboarding-agent",
        prompt: dedent`
          # Company Research Agent

          Research domain: ${companyDomain || "NOT YET EXTRACTED"}

          ## Research Strategy

          Use ALL available tools to gather information quickly and efficiently. Run searches, and tool calls in parallel:

          **exaSearch**: Fast neural search for funding, competitors, news, team info, industry context
          **getURLContent**: Company website content for branding, tone, products, official info (NO SCREENSHOTS)
          **searchWeb**: Additional context, verification, filling gaps

          Run multiple exaSearch and searchWeb queries in parallel for different topics. When sources conflict, prefer official company sources > recent news > third-party data.

          ## What to Extract

          **From Website (${companyDomain || "domain"})**:
          - Homepage: name, tagline, value proposition, products, target customers
          - About page: founding year, team size, location, history
          - Tone of Voice: Analyze writing style - professional, casual, technical, friendly, authoritative? 2-4 sentences max.

          **From Exa/Web Search**:
          - Funding: total raised, last round details, investors
          - Competitors: similar companies in the space
          - Industry: market segment, category
          - Recent news: announcements, milestones (optional)

          ## Logo URL

          Auto-injected: ${logoUrl || "pending"}

          ## Data Quality Rules

          - Use null for fields where information is not found
          - Do NOT guess or speculate
          - Cross-reference multiple sources for accuracy
          - Confidence: high (>80% fields filled), medium (40-80%), low (<40%)
          - Include current ISO 8601 timestamp in metadata.scrapedAt

          ## Output Format

          Call updateResults with structured data matching this format:

          {
            company: {name, domain, description, tagline, founded, location: {city, state, country}, teamSize, industry, stage},
            branding: {toneOfVoice, colors: {primary, secondary, accent}, fonts: {heading, body}},
            targetCustomers: {description, segments: [...]},
            products: [{name, description, url}],
            funding: {totalRaised, lastRound: {type, amount, date, investors}},
            competitors: [{name, url}],
            metadata: {scrapedAt: ISO8601, confidence: "high|medium|low"}
          }

          ## After Research

          1. Call updateResults with company data
          2. Call startSlackThread(channel: "test-blank", firstMessage: "what's up boss 🫡 let's get down to business… tag me in a new thread or just reply in this one and i'll get you onboarded")
          3. Call endTurn

          **START**: Run multiple exaSearch and webSearch queries in parallel (funding, competitors, industry) + visit homepage with getURLContent. Keep it FAST - 5 results max per search. Update results once you have enough.
        `,
        tools: [
          iterateAgentTool.doNothing({
            overrideName: "endTurn",
            overrideDescription: "End your turn and do nothing else",
          }),
          iterateAgentTool.getURLContent({
            overrideInputJSONSchema: z.toJSONSchema(
              z.object({
                url: z.string(),
                includeScreenshotOfPage: z
                  .literal(false)
                  .default(false)
                  .describe("Screenshots are disabled during research phase"),
                includeTextContent: z.boolean().default(true).optional(),
              }),
            ),
          }),
          iterateAgentTool.searchWeb({
            overrideInputJSONSchema: z.toJSONSchema(
              SearchRequest.pick({
                query: true,
                type: true,
                category: true,
              }).extend({
                numResults: z.number().max(10).default(10).describe("Max 10 results"),
              }),
            ),
          }),
          onboardingAgentTool.exaSearch(),
          onboardingAgentTool.updateResults(),
          onboardingAgentTool.getResults(),
          onboardingAgentTool.getOnboardingProgress(),
          onboardingAgentTool.updateOnboardingProgress(),
          onboardingAgentTool.startSlackThread(),
        ],
      },
    ];
  }

  // Extract company domain from organization name or user email
  private extractCompanyDomain(): string | null {
    // Try to extract from organization name first (e.g., "iterate.com" or "Iterate")
    const orgName = this.organization.name;

    // Check if org name is a domain
    if (orgName.includes(".") && !orgName.includes("@")) {
      return orgName.toLowerCase().trim();
    }

    // Check if org name looks like a company name we can convert to domain
    // For now, just return null and we'll extract from email
    // TODO: Could add logic to guess domain from company name (e.g., "Iterate" -> "iterate.com")

    return null;
  }

  override async onStart(): Promise<void> {
    await super.onStart();

    // Ash: if you add something here, it'll kick off every time the durable object boots
    if (!this.state.ashsStuffRan) {
      this.ctx.waitUntil(
        (async () => {
          // Run your agent here
          this.setState({
            ...this.state,
            ashsStuffRan: true,
          });
        })(),
      );
    }

    if (!this.state.onboardingData) {
      // Extract company domain for research
      const companyDomain = this.extractCompanyDomain();

      // Initialize onboarding data with empty checklist
      this.setState({
        ...this.state,
        onboardingData: {
          onboardingChecklist: {
            firstToolConnected: false,
            remoteMCPConnected: false,
            learnedBotUsageEverywhere: false,
            editedRulesForTone: false,
            communityInviteSent: false,
          },
        },
      });

      this.agentCore.addEvents([
        {
          type: "CORE:SET_MODEL_OPTS",
          data: {
            model: "gpt-5",
            toolChoice: "required",
          },
        },
        {
          type: "CORE:LLM_INPUT_ITEM",
          data: {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: companyDomain
                  ? `Start company research for domain: ${companyDomain}`
                  : `Start company research for organization: ${this.organization.name}`,
              },
            ],
          },
          triggerLLMRequest: true,
        },
      ]);
    }
  }

  private mergeResults(results: Record<string, any>): void {
    const currentOnboardingData = this.state.onboardingData;
    const currentResearchResults = currentOnboardingData?.researchResults ?? {};
    const currentChecklist = currentOnboardingData?.onboardingChecklist ?? {
      firstToolConnected: false,
      remoteMCPConnected: false,
      learnedBotUsageEverywhere: false,
      editedRulesForTone: false,
      communityInviteSent: false,
    };

    // Try to parse as structured company context
    let companyContext = currentOnboardingData?.companyContext;
    const parseResult = CompanyContext.safeParse(results);
    if (parseResult.success && parseResult.data) {
      // Merge structured data with existing context
      // New data takes precedence, but we preserve existing data for fields not in new data
      const existingContext = currentOnboardingData?.companyContext;

      companyContext = {
        company: {
          ...existingContext?.company,
          ...parseResult.data.company,
        },
        branding:
          existingContext?.branding || parseResult.data.branding
            ? {
                ...existingContext?.branding,
                ...parseResult.data.branding,
              }
            : undefined,
        targetCustomers:
          existingContext?.targetCustomers || parseResult.data.targetCustomers
            ? {
                ...existingContext?.targetCustomers,
                ...parseResult.data.targetCustomers,
              }
            : undefined,
        products: parseResult.data.products ?? existingContext?.products,
        funding:
          existingContext?.funding || parseResult.data.funding
            ? {
                ...existingContext?.funding,
                ...parseResult.data.funding,
              }
            : undefined,
        competitors: parseResult.data.competitors ?? existingContext?.competitors,
        metadata:
          parseResult.data.metadata?.scrapedAt || existingContext?.metadata?.scrapedAt
            ? {
                scrapedAt:
                  parseResult.data.metadata?.scrapedAt ?? existingContext?.metadata?.scrapedAt!,
                confidence:
                  parseResult.data.metadata?.confidence ?? existingContext?.metadata?.confidence,
                notes: parseResult.data.metadata?.notes ?? existingContext?.metadata?.notes,
              }
            : undefined,
      };
    }

    this.setState({
      ...this.state,
      onboardingData: {
        companyContext,
        onboardingChecklist: currentChecklist,
        researchResults: {
          ...currentResearchResults,
          ...results,
        },
      },
    });
  }

  private getResearchResults(): Record<string, any> {
    return (this.state.onboardingData?.researchResults ?? {}) as Record<string, any>;
  }

  async exaSearch(input: Inputs["exaSearch"]) {
    const { query, numResults = 5, includeDomains } = input;
    const EXA_API_KEY = this.env.EXA_API_KEY;

    if (!EXA_API_KEY) {
      throw new Error("EXA_API_KEY not configured in environment");
    }

    const requestBody: {
      query: string;
      numResults: number;
      type: string;
      contents: {
        text: boolean;
        highlights: boolean;
        summary: boolean;
      };
      includeDomains?: string[];
    } = {
      query,
      numResults,
      type: "auto",
      contents: {
        text: true,
        highlights: true,
        summary: true,
      },
    };

    if (includeDomains && includeDomains.length > 0) {
      requestBody.includeDomains = includeDomains;
    }

    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": EXA_API_KEY,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Exa search failed: ${JSON.stringify(errorData)}`);
    }

    const data = (await response.json()) as {
      results: Array<{
        title: string;
        url: string;
        publishedDate?: string;
        text?: string;
        highlights?: string[];
        summary?: string;
      }>;
    };

    return {
      results: data.results,
      summary: data.results
        .map(
          (r, idx) =>
            `${idx + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.summary || r.highlights?.join(" ") || ""}`,
        )
        .join("\n\n"),
    };
  }

  async updateResults(input: Inputs["updateResults"]) {
    // Auto-inject the logo URL from logo.dev if we have a domain
    const companyDomain = this.extractCompanyDomain();
    const logoUrl =
      companyDomain && this.env.LOGO_DEV_PUBLISHABLE_KEY
        ? `https://img.logo.dev/${companyDomain}?token=${this.env.LOGO_DEV_PUBLISHABLE_KEY}&size=512&format=png`
        : null;

    // Merge in the logo URL if branding info is being updated
    const enhancedResults = { ...input.results };
    if (enhancedResults.branding && logoUrl) {
      enhancedResults.branding = {
        ...enhancedResults.branding,
        logoUrl,
      };
    }

    this.mergeResults(enhancedResults);
    return {};
  }

  async getResults(_input: Inputs["getResults"]) {
    return this.getResearchResults();
  }

  async startSlackThread(input: { channel: string; firstMessage?: string }) {
    const { channel, firstMessage } = input;

    return await startSlackAgentInChannel({
      db: this.db,
      estateId: this.databaseRecord.estateId,
      slackChannelIdOrName: channel,
      firstMessage: firstMessage,
    });
  }

  async getOnboardingProgress(_input: Inputs["getOnboardingProgress"]) {
    const checklist = this.state.onboardingData?.onboardingChecklist ?? {
      firstToolConnected: false,
      remoteMCPConnected: false,
      learnedBotUsageEverywhere: false,
      editedRulesForTone: false,
      communityInviteSent: false,
    };
    return { checklist };
  }

  async updateOnboardingProgress(input: Inputs["updateOnboardingProgress"]) {
    const { step, completed } = input;
    const currentOnboardingData = this.state.onboardingData;
    const currentChecklist = currentOnboardingData?.onboardingChecklist ?? {
      firstToolConnected: false,
      remoteMCPConnected: false,
      learnedBotUsageEverywhere: false,
      editedRulesForTone: false,
      communityInviteSent: false,
    };

    const newChecklist = {
      ...currentChecklist,
      [step]: completed,
    };

    this.setState({
      ...this.state,
      onboardingData: {
        companyContext: currentOnboardingData?.companyContext,
        researchResults: currentOnboardingData?.researchResults,
        onboardingChecklist: newChecklist,
      },
    });

    // Check if ALL onboarding steps are now complete
    const allStepsComplete =
      newChecklist.firstToolConnected &&
      newChecklist.remoteMCPConnected &&
      newChecklist.learnedBotUsageEverywhere &&
      newChecklist.editedRulesForTone &&
      newChecklist.communityInviteSent;

    if (allStepsComplete) {
      // Clear the onboardingAgentName to complete onboarding
      // This removes the onboarding context from future SlackAgent conversations
      try {
        await this.db
          .update(schema.estate)
          .set({ onboardingAgentName: null })
          .where(eq(schema.estate.id, this.databaseRecord.estateId));

        logger.info("🎉 Onboarding completed - cleared onboardingAgentName", {
          estateId: this.databaseRecord.estateId,
          organizationId: this.organization.id,
          checklist: newChecklist,
        });
      } catch (error) {
        logger.error("Failed to clear onboardingAgentName after completion", {
          error,
          estateId: this.databaseRecord.estateId,
          organizationId: this.organization.id,
        });
        // Don't throw - we don't want to break the agent if this DB update fails
        // The checklist is still updated correctly in state, and the user completed onboarding
        // The next time the DO restarts, it will try again
      }
    }

    // Figure out what the next step is
    const nextStepGuidance = this.getNextStepGuidance(newChecklist);

    return {
      success: true,
      checklist: newChecklist,
      nextStep: nextStepGuidance,
    };
  }

  private getNextStepGuidance(
    checklist: NonNullable<typeof this.state.onboardingData>["onboardingChecklist"],
  ): string {
    if (!checklist.firstToolConnected) {
      return dedent`
        ✅ Step updated!

        NEXT ACTION: Continue with Step 1 - help them connect their first tool (Linear, Notion, or Gmail) and run the automatic demo. Only call updateOnboardingProgress AFTER the demo completes.
      `;
    }

    if (!checklist.remoteMCPConnected) {
      return dedent`
        ✅ Step 1 complete! Demo finished.

        NEXT ACTION: Send a playful, teasing message right now. Tell them you can hook into ANY remote MCP server (flex this). Tease them about their company domain name - be a bit rude/sassy. Ask if they want to see something cool (DON'T reveal what). Be cocky and fun. DO NOT say what you're going to do or mention domains yet.

        Example: "btw i can hook into any remote MCP server... speaking of which, i gotta say [company name] is... a choice. wanna see something cool?"

        THEN WAIT for their response. When they say yes, connect to https://api.findadomain.dev/mcp and find alternative domain names. Share the results. THEN call updateOnboardingProgress({step: "remoteMCPConnected", completed: true}). Do NOT offer to keep hunting or ask what's next.
      `;
    }

    if (!checklist.learnedBotUsageEverywhere) {
      return dedent`
        ✅ Step 2 complete! Remote MCP connected (or skipped).

        NEXT ACTION: Send a message right now teaching them they can @ you in ANY channel and reply in threads. Make it sound powerful and omnipresent. Then immediately in the same or next message, reveal the hackability feature (that your brain lives in their GitHub repo as rules/*.md files). After you send that message, call updateOnboardingProgress({step: "learnedBotUsageEverywhere", completed: true}).
      `;
    }

    if (!checklist.editedRulesForTone) {
      return dedent`
        ✅ Step 3 complete! They learned about @ mentions and hackability.

        NEXT ACTION: Suggest they edit the rules in their GitHub repo to change your tone (make you less sassy, more professional, whatever they want). Tell them to let you know when they're done by just saying "done with rules" or similar. Wait for them to tell you they're done - when they do, call updateOnboardingProgress({step: "editedRulesForTone", completed: true}).
      `;
    }

    if (!checklist.communityInviteSent) {
      return dedent`
        ✅ Step 4 complete! They edited the rules.

        NEXT ACTION: Send a message right now acknowledging their rule changes, share the iterate community link (https://community.iterate.chat), and stay in character based on whatever tone they set. After you send that message, call updateOnboardingProgress({step: "communityInviteSent", completed: true}).
      `;
    }

    return dedent`
      🎉 Onboarding complete! All steps finished.

      You can now help with normal requests. The sassy onboarding personality can stay or be toned down based on user preference.
    `;
  }

  // This is automatically pulled into context of all SlackAgents
  async onboardingPromptFragment(): Promise<ContextRule> {
    const companyContext = this.state.onboardingData?.companyContext;
    const checklist = this.state.onboardingData?.onboardingChecklist ?? {
      firstToolConnected: false,
      remoteMCPConnected: false,
      learnedBotUsageEverywhere: false,
      editedRulesForTone: false,
      communityInviteSent: false,
    };

    // Legacy research results (for backward compatibility)
    const legacyResults = this.getResearchResults();
    const hasLegacyData = Object.keys(legacyResults).length > 0;

    const onboardingAgentTool = createDOToolFactory(onboardingAgentTools);

    const prompt = dedent`
      # ONBOARDING MODE

      You're helping a new user get started with iterate! Be playful, sassy, witty, concise, and a bit rude (in a fun way). Use the company context below to make SPECIFIC jokes and references - don't be generic! Show off that you researched them. Be cocky about your capabilities but helpful.

      **ESSENTIAL COMMUNICATION RULES**:
      - DO NOT tell the user when you're updating internal onboarding progress
      - DO NOT show messages like "updating onboarding progress…" or "progress updated"
      - DO NOT ask the user if they want you to do more things - just do them (or don't, but don't ask)
      - DO NOT say 'next step' or anything to that effect
      - DO NOT ask "want me to do X?" or "should I Y?" after completing a step - just move on or wait for their next request
      - DO NOT offer to do additional demos or connect more tools unless they explicitly ask
      - When you complete a task (like creating docs), just share the result confidently and STOP
      - After completing any onboarding step, follow the EXACT next action specified in the guidance - don't freelance
      - Call updateOnboardingProgress silently in the background - the user doesn't need to know about it

      **IMPORTANT**: Still help with any normal requests!

      ## Company Context
      ${companyContext ? this.formatCompanyContext(companyContext) : hasLegacyData ? `Research in progress:\n${JSON.stringify(legacyResults, null, 2)}` : "Still gathering company intel... 🕵️"}

      ## Internal Checklist (track progress, don't show to user)
      ${this.formatChecklistStatus(checklist)}

      ## Onboarding Flow

      Work through these steps naturally in conversation. Don't be robotic - have fun with it!

      ### STEP 1: First Tool Connection${!checklist.firstToolConnected ? " 👈 YOU ARE HERE" : " ✅"}
      ${
        !checklist.firstToolConnected
          ? dedent`
            Send two SEPARATE messages in this exact order:

            **MESSAGE 1**: Make a sassy welcome with a SPECIFIC joke about their company using the research context above. Reference something real from their business (their product, industry, funding, etc.). Be a bit rude and sassy - no generic greetings! Also flex that you can search the web - but make it cocky/playful, like you're showing off.

            Example tone: "i see [CompanyName] is in [industry]... [sassy observation about their space]. oh and btw, i can search the entire web if you couldn't already tell - but enough flexing"

            **MESSAGE 2**: Suggest connecting ONE tool (Linear, Notion, or Gmail) - but show all three of course and allow the user to pick. Frame it as THE BEST WAY TO SEE WHAT I CAN DO - emphasize this is about showing capabilities through action. Be playful about it but not over-the-top. Keep it brief - one sentence is fine.

            Example tone: "connect Linear, Notion, or Gmail—best way to actually see what i can do for you"

            **After they connect a tool**: Automatically run a demo to show off what you can do. CRITICAL: DO NOT ASK, DO NOT TELL THEM YOU'RE ABOUT TO DO IT, DO NOT SAY "I'LL RUN A DEMO", JUST SILENTLY DO IT AND SURPRISE THEM WITH THE RESULTS:

            **IMPORTANT**: When an integration is connected, NEW TOOLS become available to you automatically. Check your available tools - you'll see integration-specific tools appear (like "linear_oauth_proxy_*" for Linear, "notion_*" or "mcp_*" for Notion, "gmail_*" for Gmail). Use these real tools.

            **If Linear connected:**
            1. Use linear_oauth_proxy_list_issues to fetch "In Progress" and "Up Next" issues (make parallel calls)
            2. Summarize the tickets in a sassy, show-offy way - group by status, highlight interesting ones
            3. Make it clear you just read through their backlog to flex
            4. Share the summary with the user in a message
            5. **CRITICAL**: ONLY AFTER you've sent that message to the user, call updateOnboardingProgress({step: "firstToolConnected", completed: true})
            6. The tool will respond with your next action - follow it (It will be about showing the user they can use any MCP and using the domain MCP provided below)!

            **If Notion connected:**
            1. SILENTLY use the Notion MCP tools to create a page titled "How to Use iterate" with a comprehensive welcome guide. Write the actual documentation yourself - be thorough and helpful. Include:
               - What iterate is (AI work companion in Slack)
               - How to use it (tag me anywhere, reply in threads)
               - What tools I connect to (Linear, Notion, Gmail, Calendar, any remote MCP etc.)
               - Tips & tricks for working with me
               - Any other useful information that would help the user get started
            2. Share the link to the page with context so the user understands what you just did. Example: "just wrote up your iterate docs in Notion: [link]. covers everything—how to use me, what i connect to, tips & tricks. tag me anywhere and i'll handle the rest."
            3. Be confident and show-offy, but GIVE CONTEXT about what you created. Do NOT ask if they want more content or additional sections - you're the expert, you wrote comprehensive docs already.
            4. **CRITICAL**: ONLY AFTER you've sent that message with the link to the user, call updateOnboardingProgress({step: "firstToolConnected", completed: true})
            5. The tool will respond with your next action - follow it immediately (It will be about showing the user they can use any MCP and using the domain MCP provided below)!

            **If Gmail connected:**
            1. First call activateGmailTools to enable Gmail functionality
            2. Use listGmailMessages to fetch recent/unread emails (last 2 days or unread)
            3. Use getGmailMessage to fetch details on 3-5 interesting messages
            4. Summarize them in a sassy, show-offy way - who they're from, what they're about
            5. Make it clear you just read through their inbox to flex
            6. Share the summary with the user in a message
            7. **CRITICAL**: ONLY AFTER you've sent that message to the user, call updateOnboardingProgress({step: "firstToolConnected", completed: true})
            8. The tool will respond with your next action - follow it immediately (It will be about showing the user they can use any MCP and using the domain MCP provided below)!

            **CRITICAL RULE**: You MUST call updateOnboardingProgress after completing the demo and sharing results. The tool response will tell you exactly what to do next. Do not skip this step or the onboarding flow will stall. Once called - do not go back and make references or requests of the user pertaining to the last executed task.
          `
          : ""
      }

      ### STEP 2: Connect Remote MCP${checklist.firstToolConnected && !checklist.remoteMCPConnected ? " 👈 YOU ARE HERE" : checklist.remoteMCPConnected ? " ✅" : ""}
      ${
        checklist.firstToolConnected && !checklist.remoteMCPConnected
          ? dedent`
            **ACTION REQUIRED**: Send a playful, teasing message right now:
            - Tell them you can hook into ANY remote MCP server (flex this capability)
            - Tease them about their company domain name (${this.organization.name}) - be a bit rude/sassy about it
            - Ask if they want to see something cool (DON'T reveal what it is, just ask if they want to see something cool)
            - Be cocky and fun about it - make it sound like a flex
            - DO NOT say what you're going to do, DO NOT mention domains or alternatives yet

            Example tone: "btw i can hook into any remote MCP server... speaking of which, i gotta say ${this.organization.name} is... a choice. wanna see something cool?"

            **AFTER THEY RESPOND YES**: THEN connect to https://api.findadomain.dev/mcp and use the tools to find alternative .com domain names. Share the results in a show-offy way with the domain alternatives.

            **CRITICAL**: After you share the domain alternatives, you MUST call updateOnboardingProgress({step: "remoteMCPConnected", completed: true}). The tool will respond with your next action - follow it immediately (This time it'll be to send a message about where the user can use iterate and hackability)!

            **THEN STOP**: Do not offer to keep hunting domains, do not ask what they want to do next. The onboarding step is complete. Move to Step 3.

            Do not skip calling updateOnboardingProgress or the onboarding flow will stall.
          `
          : !checklist.firstToolConnected
            ? "Waiting on Step 1..."
            : ""
      }

      ### STEP 3: Teach Usage Everywhere${checklist.remoteMCPConnected && !checklist.learnedBotUsageEverywhere ? " 👈 YOU ARE HERE" : checklist.learnedBotUsageEverywhere ? " ✅" : ""}
      ${
        checklist.remoteMCPConnected && !checklist.learnedBotUsageEverywhere
          ? dedent`
            **ACTION REQUIRED**: Send a message right now with TWO things:
            1. Tell them they can @ you in ANY channel, DMs and reply in threads - make it sound powerful and omnipresent
            2. SECOND SEPARATE MESSAGE. Reveal the hackability feature - tell them your brain lives in their GitHub repo as rules/*.md files and they can edit these to change your behavior. Tell them to go to the repo they made earlier and make an edit.

            DO NOT ask if they want a demo or if they want to skip anything. Just tell them both things in one message.

            **CRITICAL**: After you send that message to the user, you MUST call updateOnboardingProgress({step: "learnedBotUsageEverywhere", completed: true}). The tool will respond with your next action - follow it immediately!

            **THEN STOP**: Do not offer to do more demos, connect more tools, or ask what they want to do next. The onboarding step is complete. Wait for their next request or move to Step 4.

            Do not skip calling updateOnboardingProgress or the onboarding flow will stall.
          `
          : !checklist.remoteMCPConnected
            ? "Waiting on Step 2..."
            : ""
      }

      ### STEP 4: Wait for Rules Edit${checklist.learnedBotUsageEverywhere && !checklist.editedRulesForTone ? " 👈 YOU ARE HERE" : checklist.editedRulesForTone ? " ✅" : ""}
      ${
        checklist.learnedBotUsageEverywhere && !checklist.editedRulesForTone
          ? dedent`
            **ACTION REQUIRED**: Send a message right now suggesting they edit the rules in their GitHub repo to change your tone:
            - Tell them the rules are in rules/*.md files
            - Suggest they make you less sassy, more professional, or whatever they want
            - Tell them to let you know when they're done by saying "done with rules" or similar
            - Be playful about it

            Example tone: "go ahead, edit the rules/*.md files in your repo to make me less sassy. or more sassy. your call. just tell me 'done with rules' when you're finished and i'll vibe-check my new personality 😎"

            **THEN WAIT**: After you send that message, DO NOT call updateOnboardingProgress yet. Wait for them to tell you they're done editing. When they do, THEN call updateOnboardingProgress({step: "editedRulesForTone", completed: true}).

            **DO NOT offer to connect more tools or do additional demos** - you already showed off in Step 1. If they want help with something specific, they'll ask.
          `
          : !checklist.learnedBotUsageEverywhere
            ? "Waiting on Step 3..."
            : ""
      }

      ### STEP 5: Send Community Invite${checklist.editedRulesForTone && !checklist.communityInviteSent ? " 👈 YOU ARE HERE" : checklist.communityInviteSent ? " ✅" : ""}
      ${
        checklist.editedRulesForTone && !checklist.communityInviteSent
          ? dedent`
            **ACTION REQUIRED**: Send a message right now with:
            - Acknowledge their rule changes (stay in character based on whatever tone they set)
            - Share the iterate community link: https://community.iterate.chat
            - Keep your personality consistent with whatever rules they set

            Example tone: "nice edits. stealing workflows from other iterate users here: https://community.iterate.chat. you're welcome."

            **CRITICAL**: After you send that message to the user, you MUST call updateOnboardingProgress({step: "communityInviteSent", completed: true}). This completes onboarding! 🎉

            Do not skip calling updateOnboardingProgress or the onboarding flow will not complete properly.
          `
          : !checklist.editedRulesForTone
            ? "Waiting on Step 4..."
            : checklist.communityInviteSent
              ? "🎉 Onboarding complete!"
              : ""
      }
    `;

    return {
      key: "onboarding-context",
      prompt,
      tools: [
        onboardingAgentTool.getOnboardingProgress(),
        onboardingAgentTool.updateOnboardingProgress(),
      ],
    };
  }

  private formatCompanyContext(
    context: NonNullable<typeof this.state.onboardingData>["companyContext"],
  ): string {
    if (!context) return "No company context available yet.";

    const parts: string[] = [];

    if (context.company) {
      parts.push(
        `**Company**: ${context.company.name}${context.company.tagline ? ` - "${context.company.tagline}"` : ""}`,
      );
      if (context.company.description) {
        parts.push(`**About**: ${context.company.description}`);
      }
      if (context.company.industry) {
        parts.push(`**Industry**: ${context.company.industry}`);
      }
    }

    if (context.branding?.toneOfVoice) {
      parts.push(`**Brand Voice**: ${context.branding.toneOfVoice}`);
    }

    if (context.targetCustomers?.description) {
      parts.push(`**Target Customers**: ${context.targetCustomers.description}`);
    }

    return parts.join("\n");
  }

  private formatChecklistStatus(
    checklist: NonNullable<typeof this.state.onboardingData>["onboardingChecklist"],
  ): string {
    const items = [
      { key: "firstToolConnected", label: "Connected first tool & ran automatic demo" },
      { key: "remoteMCPConnected", label: "Suggested remote MCP connection" },
      { key: "learnedBotUsageEverywhere", label: "Learned they can tag bot anywhere" },
      { key: "editedRulesForTone", label: "Edited rules for tone (hackability lesson)" },
      { key: "communityInviteSent", label: "Community invite sent" },
    ];

    return items
      .map((item) => {
        const checked = checklist?.[item.key as keyof typeof checklist] ? "✅" : "⬜";
        return `${checked} ${item.label}`;
      })
      .join("\n");
  }

  // What does the user see in the web UI
  async getMessageForUI() {
    return "You are onboarding!";
  }
}
