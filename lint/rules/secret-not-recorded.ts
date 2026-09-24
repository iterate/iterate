// Two rules that keep secrets out of PostHog's session replay, which records what people type and
// see (packages/ui not-recorded.tsx `posthogPrivacy`): a field that takes a secret renders as a
// SecretInput or SecretTextarea, and a secret rendered on the page, as text or in an attribute,
// sits inside a NotRecorded. Both call a name secret the way the replay's own runtime masking does
// (packages/ui/src/lib/secret-text.ts). That masking also covers what these rules cannot see, but
// only as asterisks and only for fields: these components leave the secret out entirely.
import {
  CREDENTIAL_AUTOCOMPLETE,
  KEY_PREFIX,
  namesSecret,
} from "../../packages/ui/src/lib/secret-text.ts";
import type { StrictRule } from "../types.ts";

export const secretFieldNotRecordedRule: StrictRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a field that takes a secret to render as <SecretInput> or <SecretTextarea> " +
        "(@iterate-com/ui/components/not-recorded) or inside a <NotRecorded>, which session replay " +
        "and autocapture leave out. Flags a raw input or textarea (an aliased import of the " +
        'vendored ones included) that says it takes one: type="password" (a show/hide ' +
        "conditional too), a credential autoComplete, an id, name, aria-label or placeholder " +
        "naming a secret or showing a key's prefix, a label naming one (wrapping the field, or " +
        'pointing at its id with htmlFor), or a spread such as {...register("password")}.',
    },
  },
  create(context) {
    const fieldNames = new Set(RAW_FORM_FIELDS);
    const labels = new Map<string, string[]>();
    const byId: { node: any; name: string; id: string }[] = [];
    const report = (node: any, name: string, evidence: string) =>
      context.report({
        node,
        message:
          `<${name} ${evidence}> takes a secret. Render <SecretInput> or <SecretTextarea> from ` +
          `@iterate-com/ui/components/not-recorded: session replay and autocapture leave them out ` +
          `entirely, where a raw field is at best replayed as asterisks.`,
      });
    return {
      ImportDeclaration(node: any) {
        // `import { Input as TextField } from "@iterate-com/ui/components/input"`
        if (!/^@iterate-com\/ui\/components\/(input|textarea|input-group)$/.test(node.source.value))
          return;
        for (const specifier of node.specifiers)
          if (specifier.type === "ImportSpecifier" && RAW_FORM_FIELDS.has(specifier.imported.name))
            fieldNames.add(specifier.local.name);
      },
      JSXOpeningElement(node: any) {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : undefined;
        if (!name) return;
        if (LABELS.has(name)) {
          const htmlFor = attributeKey(context, node, "htmlFor");
          if (htmlFor) labels.set(htmlFor, [...(labels.get(htmlFor) ?? []), jsxText(node.parent)]);
          return;
        }
        if (!fieldNames.has(name) || isInsideNotRecorded(node)) return;
        const evidence = secretFieldEvidence(context, node) ?? wrappingLabelEvidence(node);
        if (evidence) return report(node, name, evidence);
        const id = attributeKey(context, node, "id");
        if (id) byId.push({ node, name, id });
      },
      // a label may come after its field: `<Input id={keyId} />` then `<FieldLabel htmlFor={keyId}>`
      "Program:exit"() {
        for (const field of byId) {
          const text = labels.get(field.id)?.find(namesSecret);
          if (text) report(field.node, field.name, `labelled "${text}"`);
        }
      },
    };
  },
};

export const secretShownNotRecordedRule: StrictRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a value named like a secret (token, apiKey, clientSecret, password, …) that JSX " +
        "renders to sit inside a <NotRecorded> (@iterate-com/ui/components/not-recorded): session " +
        "replay records the page's text and attributes. It counts as rendered as a child, in an " +
        "element's attribute, in a component prop that renders or links (value, href, to, params, " +
        "…), or in a string built for any prop (`/invitations/${token}`). Names that only mention " +
        "a secret (tokenName, secretId, tokenHash), handlers and keys pass.",
    },
  },
  create(context) {
    return {
      JSXExpressionContainer(node: any) {
        const { parent } = node;
        if (parent.type === "JSXAttribute") {
          const element = parent.parent.name;
          const elementName = element.type === "JSXIdentifier" ? element.name : undefined;
          const attribute = parent.name.type === "JSXIdentifier" ? parent.name.name : "";
          if (attribute === "key" || /^on[A-Z]/.test(attribute)) return;
          if (elementName && NOT_RECORDED_ELEMENTS.has(elementName)) return;
          // a component's prop may never reach the page (`posthogApiKey`, `passwordEnabled`): only
          // a prop that renders or links, or a string built from the secret, counts
          const component = !elementName || /^[A-Z]/.test(elementName);
          const built = ["TemplateLiteral", "BinaryExpression"].includes(node.expression.type);
          if (component && !built && !RENDERED_PROPS.has(attribute)) return;
        } else if (parent.type !== "JSXElement" && parent.type !== "JSXFragment") return;
        if (isInsideNotRecorded(node)) return;
        const reference = secretReference(node.expression);
        if (!reference) return;
        context.report({
          node,
          message:
            `\`${context.sourceCode.getText(reference)}\` looks like a secret, and session replay ` +
            `records the page's text and attributes. Render it inside a <NotRecorded> from ` +
            `@iterate-com/ui/components/not-recorded, which replay and autocapture leave out.`,
        });
      },
    };
  },
};

/** The raw form fields: the vendored shadcn ones and the DOM's. */
const RAW_FORM_FIELDS = new Set([
  "input",
  "textarea",
  "Input",
  "Textarea",
  "InputGroupInput",
  "InputGroupTextarea",
]);

const LABELS = new Set(["label", "Label", "FieldLabel"]);

/** The props a component commonly renders as text or an attribute, or turns into a link. */
const RENDERED_PROPS = new Set([
  "children",
  "value",
  "defaultValue",
  "href",
  "to",
  "params",
  "search",
  "src",
  "title",
  "label",
  "text",
  "content",
  "description",
  "placeholder",
  "alt",
  "url",
  "link",
]);

/** The elements whose content, attributes and value replay leaves out. */
const NOT_RECORDED_ELEMENTS = new Set(["NotRecorded", "SecretInput", "SecretTextarea"]);

/** What says a raw field takes a secret, or undefined. Only what the source spells out counts: the
 *  string literals an attribute can take (both branches of `show ? "text" : "password"`, a
 *  template's fixed text), and the string argument of a spread call. */
function secretFieldEvidence(context: any, node: any) {
  if (attributeStrings(node, "type").some((type) => type.toLowerCase() === "password"))
    return 'type="password"';
  for (const value of attributeStrings(node, "autoComplete")) {
    const token = value
      .toLowerCase()
      .split(/\s+/)
      .find((candidate) => CREDENTIAL_AUTOCOMPLETE.includes(candidate));
    if (token) return `autoComplete="${token}"`;
  }
  for (const name of ["id", "name", "aria-label", "placeholder"])
    for (const value of attributeStrings(node, name))
      if (namesSecret(value) || (name === "placeholder" && KEY_PREFIX.test(value)))
        return `${name}="${value}"`;
  for (const attribute of node.attributes) {
    if (attribute.type !== "JSXSpreadAttribute" || attribute.argument.type !== "CallExpression")
      continue;
    const [first] = attribute.argument.arguments;
    if (first?.type === "Literal" && typeof first.value === "string" && namesSecret(first.value))
      return `{...${context.sourceCode.getText(attribute.argument)}}`;
  }
  return undefined;
}

/** `<Label>Wi-Fi password <Input /></Label>`: the text of the label the field sits in. */
function wrappingLabelEvidence(node: any) {
  for (let ancestor = node.parent?.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type !== "JSXElement") continue;
    const name = ancestor.openingElement.name;
    if (name.type !== "JSXIdentifier" || !LABELS.has(name.name)) continue;
    const text = jsxText(ancestor);
    return namesSecret(text) ? `labelled "${text}"` : undefined;
  }
  return undefined;
}

/** The string literals an attribute's value can be. */
function attributeStrings(node: any, name: string) {
  const value = findAttribute(node, name)?.value;
  if (!value) return [];
  return value.type === "JSXExpressionContainer"
    ? staticStrings(value.expression)
    : staticStrings(value);
}

function staticStrings(node: any): string[] {
  if (node.type === "Literal") return typeof node.value === "string" ? [node.value] : [];
  if (node.type === "TemplateLiteral")
    return [node.quasis.map((quasi: any) => quasi.value.cooked).join(" ")];
  if (node.type === "ConditionalExpression")
    return [...staticStrings(node.consequent), ...staticStrings(node.alternate)];
  if (node.type === "LogicalExpression")
    return [...staticStrings(node.left), ...staticStrings(node.right)];
  return [];
}

/** A key that matches a field's `id` to a label's `htmlFor`: the literal, or an expression's
 *  source text (`{keyId}` from `useId()`). */
function attributeKey(context: any, node: any, name: string) {
  const value = findAttribute(node, name)?.value;
  if (!value) return undefined;
  const expression = value.type === "JSXExpressionContainer" ? value.expression : value;
  if (expression.type === "Literal") return `"${expression.value}"`;
  if (expression.type === "TemplateLiteral" && expression.expressions.length === 0)
    return `"${expression.quasis[0].value.cooked}"`;
  return `{${context.sourceCode.getText(expression)}}`;
}

function findAttribute(node: any, name: string) {
  return node.attributes.find(
    (attribute: any) =>
      attribute.type === "JSXAttribute" &&
      attribute.name.type === "JSXIdentifier" &&
      attribute.name.name === name,
  );
}

/** The text a JSX element renders from literals: its JSX text and string children, nested ones
 *  included, whitespace collapsed. */
function jsxText(element: any) {
  const parts: string[] = [];
  (function walk(children: any[]) {
    for (const child of children) {
      if (child.type === "JSXText") parts.push(child.value);
      else if (child.type === "JSXExpressionContainer")
        parts.push(...staticStrings(child.expression));
      else if (child.type === "JSXElement" || child.type === "JSXFragment") walk(child.children);
    }
  })(element?.children ?? []);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Whether the node is written inside a <NotRecorded> block in the same JSX tree. */
function isInsideNotRecorded(node: any) {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    const name = ancestor.type === "JSXElement" ? ancestor.openingElement.name : undefined;
    if (name?.type === "JSXIdentifier" && name.name === "NotRecorded") return true;
  }
  return false;
}

/** The first identifier or member the expression renders whose name says it holds a secret:
 *  `token`, `minted.token`, `apiKey` inside `/x/${apiKey}`, `{ token }` in a Link's params, the
 *  object of `token.slice(0, 8)`. It does not look into functions (handlers use a secret, they
 *  do not show it), into the test of a condition or the left of `&&`, or into JSX, which is
 *  checked on its own. Plurals and a bare `key` (a map's key, a React key) are not secrets here:
 *  `sortedKeys` lists names, `row.key` names a setting. */
function secretReference(node: any): any {
  if (!node) return undefined;
  const secretName = (name: string) =>
    name !== "key" && !/(keys|secrets|passwords|credentials)$/i.test(name) && namesSecret(name);
  const first = (nodes: any[]) => nodes.map(secretReference).find(Boolean);
  switch (node.type) {
    case "Identifier":
      return secretName(node.name) ? node : undefined;
    case "MemberExpression":
      if (node.computed) return undefined;
      return secretName(node.property.name) ? node : undefined;
    case "ChainExpression":
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "ParenthesizedExpression":
      return secretReference(node.expression);
    case "TemplateLiteral":
      return first(node.expressions);
    case "BinaryExpression":
      return first([node.left, node.right]);
    case "LogicalExpression":
      return node.operator === "&&" ? secretReference(node.right) : first([node.left, node.right]);
    case "ConditionalExpression":
      return first([node.consequent, node.alternate]);
    case "CallExpression":
    case "NewExpression":
      return first([
        ...node.arguments,
        node.callee.type === "MemberExpression" ? node.callee.object : undefined,
      ]);
    case "ObjectExpression":
      return first(node.properties.map((property: any) => property.value ?? property.argument));
    case "ArrayExpression":
      return first(node.elements);
    case "SpreadElement":
      return secretReference(node.argument);
    default:
      return undefined;
  }
}
