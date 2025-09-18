import dedent from "dedent";
import type { PackageRuleItem } from "vibe-rules";

function codeblock(lang: string, code: string) {
  return dedent`
    \`\`\`${lang}
    ${code}
    \`\`\`
  `;
}

const rules: PackageRuleItem[] = [
  {
    name: "naming-things",
    description: "Guidelines for naming things",
    rule: dedent`
      Please always be explicit in your naming of things. If there's a concept called SomeThingTemplate, then don't call the file template.tsx! Call it some-thing-template.tsx

      Avoid using terminology that is easily misunderstood.
    `,
    alwaysApply: true,
  },
  {
    name: "trpc-and-tanstack-query-usage",
    description: "Usage of trpc and tanstack react query in apps",
    alwaysApply: true,
    rule: dedent`
      ## Prefer the useSuspenseQuery hook when making trpc queries 

      As per these docs: https://trpc.io/docs/client/react/suspense

      We want to use <Suspense> and <ErrorBoundary> in sensible places.
      E.g.
      ${codeblock(
        "tsx",
        `
      const { data } = useSuspenseQuery(trpc.agent.conversation.getConversation.queryOptions({
        conversationId: "123"
      }));
      `,
      )}
    `,
    globs: ["**/*.tsx"],
  },
  {
    name: "typescript",
    description: "How to write good typescript",
    alwaysApply: true,
    rule: dedent`
      - Use inferred types where possible. If you're creating super complex generic type expressions you're probably doing it wrong
      - Use strict typescript
      - File and folder names should be kebab-cased
      - Do not use template literals if interpolation and special-character handling are not needed
      - Always put utility functions _below_ the rest of the code
      - Prefer named exports over default exports
      - Include .ts/.js extension in relative import statements (but not in package imports even within the monorepo)
      - Use node: prefix for node imports (e.g. import { readFile } from "node:fs")
      - Unit tests are always colocated in *.test.ts files alongside the tested file. We use vitest.
      - You do not need to ever import React
      - Do not ever 'as any' to work around typescript issues. Instead, fix the typescript issues or ask your human for help.

      # Third party dependencies

      We use pnpm as our package manager.

      Use remeda for various utilities.
      Use dedent for multiline prompt template strings.
      Don't ever install ts-node or similar. We use node 24 which can run typescript natively.
      Use import { z } from "zod/v4" to import v4 of zod (the latest version), do not use import ... from "zod" without the /v4
    `,
    globs: ["**/*.ts", "**/*.tsx"],
  },
  {
    name: "vitest-patterns",
    description: "Vitest test patterns and polling helpers",
    rule: dedent`
      # Vitest Testing Patterns

      ## Using idiomatic, built-in helpers

      Use vi mocks and vi fake timers for time-based assertions.

      ## Prefer use .toMatchInlineSnapshot()

      We like snapshot tests that are inline

      ## Using pluckFields with Inline Snapshots

      Use the \`pluckFields\` helper from \`@iterate-com/helpers/test-helpers/test-utils\` to extract specific fields from arrays of objects for concise inline snapshot testing:

      \`\`\`typescript
      import { pluckFields } from "@iterate-com/helpers/test-helpers/test-utils";

      test("should track state changes", async () => {
        const events = await getEvents();
  
        // Extract only the fields we care about for the test
        const eventSummary = pluckFields(events, ["type", "data.status", "timestamp"]);
  
        expect(eventSummary).toMatchInlineSnapshot(\`
          [
            ["started", "pending", 100],
            ["progress", "running", 200],
            ["completed", "success", 300]
          ]
        \`);
      });

      // For more compact output, use the optional flags
      test("compact state tracking", async () => {
        const events = await getEvents();
  
        // Create a single string with all events
        const summary = pluckFields(events, ["type", "status"], { joinRows: true });
  
        expect(summary).toMatchInlineSnapshot(\`
          "["started","pending"]
          ["progress","running"]
          ["completed","success"]"
        \`);
      });

      // Or create an array of JSON strings
      test("stringified events", async () => {
        const events = await getEvents();
  
        const jsonEvents = pluckFields(events, ["type", "status"], { stringifyColumns: true });
  
        expect(jsonEvents).toMatchInlineSnapshot(\`
          [
            "["started","pending"]",
            "["progress","running"]",
            "["completed","success"]"
          ]
        \`);
      });
      \`\`\`

      Options:
      - \`joinRows: true\` - Joins all rows with newlines into a single string
      - \`stringifyColumns: true\` - JSON.stringify each row (can be combined with joinRows)

      This is particularly useful for:
      - Testing sequences of events or state changes
      - Focusing on specific fields in complex objects
      - Making tests more readable and maintainable
      - Avoiding brittle tests that break when unrelated fields change
      - Creating compact debug output for multi-step workflows

      ## Table-based Testing with describe.for and test.for

      Use \`describe.for\` and \`test.for\` for table-driven tests. Unlike \`.each\`, \`.for\` doesn't spread array elements - it passes the entire element as a single argument:

      \`\`\`typescript
      describe.for([
        ["add", 1, 2, 3],
        ["subtract", 5, 2, 3],
        ["multiply", 3, 4, 12]
      ])("%s(%i, %i) -> %i", ([operation, a, b, expected]) => {
        test("returns correct result", () => {
          const result = calculate(operation, a, b);
          expect(result).toBe(expected);
        });
      });

      // With object cases for better readability
      test.for([
        { user: "Alice", role: "admin", canDelete: true },
        { user: "Bob", role: "user", canDelete: false },
        { user: "Charlie", role: "guest", canDelete: false }
      ])("$user with $role role", ({ user, role, canDelete }) => {
        const permissions = getPermissions(role);
        expect(permissions.canDelete).toBe(canDelete);
      });
      \`\`\`

      ## Polling and Waiting for Conditions

      ### 1. expect.poll() - Recommended for async assertions
      Polls a function until it returns the expected value or times out.

      \`\`\`typescript
      import { expect, test } from "vitest";

      test("should eventually return expected value", async () => {
        // Basic usage
        await expect.poll(
          async () => {
            const events = await trpcClient.getEvents.query();
            return events.some(e => e.type === "COMPLETED");
          },
          { timeout: 5000, interval: 100 }
        ).toBe(true);

        // With more complex assertions
        await expect.poll(
          async () => {
            const result = await fetchData();
            return result.status;
          }
        ).toBe("ready");

        // Finding specific content
        await expect.poll(
          async () => {
            const response = await api.getMessage();
            return response.text.toLowerCase();
          }
        ).toContain("expected content");
      });
      \`\`\`

      ### 2. vi.waitFor() - More flexible alternative
      Waits for a callback to execute successfully (without throwing).

      \`\`\`typescript
      import { vi, expect, test } from "vitest";

      test("should wait for condition", async () => {
        // Wait for any condition to be met
        await vi.waitFor(
          async () => {
            const data = await fetchData();
            expect(data.ready).toBe(true);
          },
          { timeout: 5000, interval: 100 }
        );

        // Can include multiple assertions
        const result = await vi.waitFor(async () => {
          const response = await api.call();
          expect(response.status).toBe(200);
          expect(response.data).toHaveProperty("id");
          return response.data;
        });
      });
      \`\`\`

      ### 3. vi.waitUntil() - For custom conditions
      Similar to waitFor but returns the first truthy value.

      \`\`\`typescript
      test("should wait until condition is truthy", async () => {
        const element = await vi.waitUntil(
          async () => {
            const elements = await page.findElements(".my-class");
            return elements.length > 0 ? elements[0] : null;
          },
          { timeout: 3000 }
        );
  
        expect(element).toBeDefined();
      });
      \`\`\`
    `,
    globs: ["**/*.test.ts"],
  },
  {
    name: "json-schema",
    description: "JSON Schema usage in TypeScript/TSX files",
    rule: dedent`
      # JSON Schema

      We use JSON Schema extensively throughout the codebase for data validation, API contracts, and form generation.

      ## Form Rendering
      For rendering forms from JSON Schema, we use **@rjsf/shadcn** (React JSON Schema Form with shadcn theme).
      This provides automatic form generation with shadcn-styled components from JSON Schema definitions.

      Example usage:
      \`\`\`typescript
      import Form from "@rjsf/shadcn";
      import validator from "@rjsf/validator-ajv8";

      <Form
        schema={myJsonSchema}
        validator={validator}
        formData={data}
        onChange={({ formData }) => setData(formData)}
      />
      \`\`\`

      ## Important Note
      OpenAI's function calling doesn't support the full JSON Schema spec. Be aware of limitations when using JSON Schema for OpenAI tool definitions:
      - No support for \`$ref\` references
      - Limited support for complex validation keywords
      - Some format validators may not be enforced

      Always test your schemas with the actual OpenAI API to ensure compatibility.
    `,
    globs: ["**/*.ts", "**/*.tsx"],
  },
];

export default rules;
