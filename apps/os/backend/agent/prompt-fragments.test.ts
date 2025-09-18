import { describe, it, expect } from "vitest";
import dedent from "dedent";
import { renderPromptFragment, f } from "./prompt-fragments.ts";

describe("prompt fragments", () => {
  describe("renderPromptFragment", () => {
    it("renders simple string fragment", () => {
      const fragment = "Hello world";
      const result = renderPromptFragment(fragment);

      expect(result).toMatchInlineSnapshot(`"Hello world"`);
    });

    it("renders null fragment as empty string", () => {
      const fragment = null;
      const result = renderPromptFragment(fragment);

      expect(result).toMatchInlineSnapshot(`""`);
    });

    it("renders simple tagged fragment", () => {
      const fragment = f("greeting", "Hello world");
      const result = renderPromptFragment(fragment);

      expect(result).toMatchInlineSnapshot(`
        "<greeting>
          Hello world
        </greeting>"
      `);
    });

    it("renders multiline string content with proper indentation", () => {
      const fragment = f(
        "instructions",
        dedent`
          Follow these steps:
          1. First step
          2. Second step
          3. Third step
        `,
      );
      const result = renderPromptFragment(fragment);

      expect(result).toMatchInlineSnapshot(`
        "<instructions>
          Follow these steps:
          1. First step
          2. Second step
          3. Third step
        </instructions>"
      `);
    });

    it("renders array of string fragments", () => {
      const fragments = ["First item", "Second item", "Third item"];
      const result = renderPromptFragment(fragments);

      expect(result).toMatchInlineSnapshot(`
        "First item

        Second item

        Third item"
      `);
    });

    it("renders array of tagged fragments", () => {
      const fragments = [
        f("rule", "Be helpful"),
        f("rule", "Be concise"),
        f("rule", "Be accurate"),
      ];
      const result = renderPromptFragment(fragments);

      expect(result).toMatchInlineSnapshot(`
        "<rule>
          Be helpful
        </rule>

        <rule>
          Be concise
        </rule>

        <rule>
          Be accurate
        </rule>"
      `);
    });

    it("renders nested tagged fragments", () => {
      const fragment = f(
        "instructions",
        f("primary", "Complete the task"),
        f("secondary", "Document your work"),
      );
      const result = renderPromptFragment(fragment);

      expect(result).toMatchInlineSnapshot(`
        "<instructions>
          <primary>
            Complete the task
          </primary>

          <secondary>
            Document your work
          </secondary>
        </instructions>"
      `);
    });

    it("renders deeply nested fragments with mixed content", () => {
      const fragment = f(
        "system",
        "You are an AI assistant.",
        f(
          "capabilities",
          f("primary", "Answer questions"),
          f("primary", "Solve problems"),
          f("secondary", "Provide examples", f("note", "Use clear language")),
        ),
        f("constraints", "Always be truthful", f("important", "Admit when unsure")),
      );
      const result = renderPromptFragment(fragment);

      expect(result).toMatchInlineSnapshot(`
        "<system>
          You are an AI assistant.

          <capabilities>
            <primary>
              Answer questions
            </primary>

            <primary>
              Solve problems
            </primary>

            <secondary>
              Provide examples

              <note>
                Use clear language
              </note>
            </secondary>
          </capabilities>

          <constraints>
            Always be truthful

            <important>
              Admit when unsure
            </important>
          </constraints>
        </system>"
      `);
    });

    it("renders mixed array with strings and tagged fragments", () => {
      const fragments = [
        "Introduction text",
        f("section", "Tagged content"),
        "More plain text",
        f("conclusion", "Final thoughts"),
      ];
      const result = renderPromptFragment(fragments);

      expect(result).toMatchInlineSnapshot(`
        "Introduction text

        <section>
          Tagged content
        </section>

        More plain text

        <conclusion>
          Final thoughts
        </conclusion>"
      `);
    });

    it("handles empty arrays", () => {
      const fragment = f("empty", []);
      const result = renderPromptFragment(fragment);

      expect(result).toMatchInlineSnapshot(`""`);
    });

    it("filters out null values in arrays", () => {
      const fragments = ["First item", null, f("tagged", "Tagged item"), null, "Last item"];
      const result = renderPromptFragment(fragments);

      expect(result).toMatchInlineSnapshot(`
        "First item

        <tagged>
          Tagged item
        </tagged>

        Last item"
      `);
    });

    it("renders complex real-world scenario", () => {
      const fragment = f(
        "agent_instructions",
        dedent`
          You are a code review assistant. Your task is to review code changes
          and provide constructive feedback.
        `,
        f(
          "guidelines",
          f(
            "style",
            dedent`
              Check for:
              - Consistent formatting
              - Clear variable names
              - Proper documentation
            `,
          ),
          f(
            "logic",
            dedent`
              Analyze:
              - Algorithm efficiency
              - Edge case handling
              - Error conditions
            `,
          ),
          f(
            "security",
            "Look for potential vulnerabilities",
            f(
              "specific_checks",
              "SQL injection risks",
              "XSS vulnerabilities",
              "Authentication bypasses",
            ),
          ),
        ),
        f(
          "output_format",
          "Provide feedback in this structure:",
          f("summary", "Brief overview of the changes"),
          f("issues", "List any problems found"),
          f("suggestions", "Recommendations for improvement"),
        ),
      );
      const result = renderPromptFragment(fragment);

      expect(result).toMatchInlineSnapshot(`
        "<agent_instructions>
          You are a code review assistant. Your task is to review code changes
          and provide constructive feedback.

          <guidelines>
            <style>
              Check for:
              - Consistent formatting
              - Clear variable names
              - Proper documentation
            </style>

            <logic>
              Analyze:
              - Algorithm efficiency
              - Edge case handling
              - Error conditions
            </logic>

            <security>
              Look for potential vulnerabilities

              <specific_checks>
                SQL injection risks

                XSS vulnerabilities

                Authentication bypasses
              </specific_checks>
            </security>
          </guidelines>

          <output_format>
            Provide feedback in this structure:

            <summary>
              Brief overview of the changes
            </summary>

            <issues>
              List any problems found
            </issues>

            <suggestions>
              Recommendations for improvement
            </suggestions>
          </output_format>
        </agent_instructions>"
      `);
    });

    it("handles fragments with empty string content", () => {
      const fragment = f("empty_content", "");
      const result = renderPromptFragment(fragment);

      expect(result).toMatchInlineSnapshot(`""`);
    });

    it("preserves empty lines in multiline content", () => {
      const fragment = f(
        "code_example",
        dedent`
          function example() {
            console.log("first");

            console.log("after empty line");
          }
        `,
      );
      const result = renderPromptFragment(fragment);

      expect(result).toMatchInlineSnapshot(`
        "<code_example>
          function example() {
            console.log("first");

            console.log("after empty line");
          }
        </code_example>"
      `);
    });
  });

  describe("f utility function", () => {
    it("creates simple tagged fragment", () => {
      const fragment = f("test", "content");

      expect(fragment).toEqual({
        tag: "test",
        content: ["content"],
      });
    });

    it("creates fragment with multiple content items", () => {
      const fragment = f("parent", "text1", "text2", f("child", "nested"));

      expect(fragment).toEqual({
        tag: "parent",
        content: ["text1", "text2", { tag: "child", content: ["nested"] }],
      });
    });

    it("creates fragment with no content", () => {
      const fragment = f("empty");

      expect(fragment).toEqual({
        tag: "empty",
        content: [],
      });
    });
  });
});
