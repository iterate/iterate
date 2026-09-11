import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  javascriptLanguage,
  jsxLanguage,
  typescriptLanguage,
  tsxLanguage,
} from "@codemirror/lang-javascript";
import { highlightMarkdown } from "@atomic-editor/editor";

/** One Markdown grammar for source editing and the rich review projection. */
export function workspaceMarkdown() {
  return markdown({
    base: markdownLanguage,
    extensions: highlightMarkdown,
    codeLanguages: (info) => {
      switch (info.trim().split(/\s+/)[0]?.toLowerCase()) {
        case "ts":
        case "typescript":
          return typescriptLanguage;
        case "tsx":
          return tsxLanguage;
        case "js":
        case "javascript":
          return javascriptLanguage;
        case "jsx":
          return jsxLanguage;
        default:
          return null;
      }
    },
  });
}
