import { Bash } from "just-bash";
import dedent from "dedent";
import { defineProcessor, GenericEventInput } from "ai-engineer-workshop";
import { z } from "zod";

export const BashmodeBlockAddedEventInput = GenericEventInput.extend({
  type: z.literal("bashmode-block-added"),
  payload: z.object({
    content: z.string().min(1),
  }),
});

const bashmode = defineProcessor(() => ({
  slug: "bashmode",
  initialState: {},

  afterAppend: async ({ append, event }) => {
    const bashmodeBlock = BashmodeBlockAddedEventInput.safeParse({
      type: event.type,
      payload: event.payload,
      metadata: event.metadata,
    });
    if (!bashmodeBlock.success) return;

    const bash = new Bash({
      env: {
        BASE_URL: process.env.BASE_URL || "https://events.iterate.com",
        PROJECT_SLUG: process.env.PROJECT_SLUG || "public",
      },
      network: {
        dangerouslyAllowFullInternetAccess: true,
      },
    });
    const result = await bash.exec(bashmodeBlock.data.payload.content);

    await append({
      event: {
        type: "agent-input-added",
        payload: {
          content: dedent`
            Bash result:
            stdout:
            ${result.stdout}
            stderr:
            ${result.stderr}
            exitCode: ${result.exitCode}
          `,
        },
      },
    });
  },
}));

export default bashmode;
