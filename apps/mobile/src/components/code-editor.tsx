"use dom";

// CodeMirror 6 bundled by Expo as an offline DOM component. Expo hosts this in
// react-native-webview and marshals source changes back to the native working tree.

import { Component } from "react";
import { basicSetup } from "codemirror";
import { vsCodeDark } from "@fsegurai/codemirror-theme-vscode-dark";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

type Props = {
  dom?: import("expo/dom").DOMProps;
  editable: boolean;
  onChange: (content: string) => Promise<void>;
  /** Fired once the EditorView has mounted INSIDE the webview — the positive
   * signal that the DOM bundle actually loaded (progressive-enhancement
   * consumers keep their native fallback until it arrives). Marshaled across
   * the expo/dom bridge like `onChange`, hence async. */
  onReady: () => Promise<void>;
  path: string;
  value: string;
};

export default class CodeEditor extends Component<Props> {
  #changeChain = Promise.resolve();
  #language = new Compartment();
  #root: HTMLDivElement | null = null;
  #syncing = false;
  #view: EditorView | null = null;

  componentDidMount() {
    if (!this.#root) throw new Error("CodeMirror root did not mount.");
    this.#view = new EditorView({
      doc: this.props.value,
      parent: this.#root,
      extensions: [
        basicSetup,
        vsCodeDark,
        EditorState.readOnly.of(!this.props.editable),
        EditorView.editable.of(this.props.editable),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          autocapitalize: "off",
          autocorrect: "off",
          spellcheck: "false",
        }),
        this.#language.of(languageForPath(this.props.path)),
        editorLayout,
        EditorView.updateListener.of((update) => {
          if (!this.#syncing && update.docChanged) {
            const content = update.state.doc.toString();
            this.#changeChain = this.#changeChain
              .then(() => this.props.onChange(content))
              .catch((error) => console.error("CodeMirror bridge update failed", error));
          }
        }),
      ],
    });
    this.props.onReady().catch((error) => console.error("CodeMirror ready signal failed", error));
  }

  componentDidUpdate(previous: Props) {
    if (!this.#view) return;
    const currentValue = this.#view.state.doc.toString();
    const effects =
      previous.path === this.props.path
        ? []
        : [this.#language.reconfigure(languageForPath(this.props.path))];
    if (currentValue === this.props.value && effects.length === 0) return;
    this.#syncing = true;
    this.#view.dispatch({
      changes:
        currentValue === this.props.value
          ? undefined
          : { from: 0, to: currentValue.length, insert: this.props.value },
      effects,
    });
    this.#syncing = false;
  }

  componentWillUnmount() {
    this.#view?.destroy();
  }

  render() {
    return (
      <main>
        <style>{styles}</style>
        <div
          className="editor"
          ref={(root) => {
            this.#root = root;
          }}
        />
      </main>
    );
  }
}

function languageForPath(path: string): Extension {
  const extension = path.split(".").pop()?.toLowerCase();
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(extension || ""))
    return javascript({
      jsx: ["jsx", "tsx"].includes(extension || ""),
      typescript: extension ? extension.includes("ts") : false,
    });
  if (extension === "json") return json();
  if (["md", "mdx"].includes(extension || "")) return markdown();
  if (extension === "css") return css();
  if (["html", "htm"].includes(extension || "")) return html();
  return [];
}

const editorLayout = EditorView.theme({
  "&": { height: "100%" },
  ".cm-content": { padding: "12px 0 100px" },
  ".cm-scroller": { overflow: "auto", WebkitOverflowScrolling: "touch" },
});

const styles = `
  * { box-sizing: border-box; }
  html, body, #root, main, .editor { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  body { background: #0b0b0f; overscroll-behavior: none; }
`;
