import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { SignatureKind } from "@typescript/native-preview/unstable/sync";
import esquery from "esquery";
import unicorn from "eslint-plugin-unicorn";

import { getTypeAwareLintService } from "./lint/oxlint-type-aware.ts";

const LIFECYCLE_HOOKS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);
const VI_MOCK_CALLS = new Set(["vi.mock", "vi.doMock"]);
const PROPERTY_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual"]);

/** @param {string} name */
const getExpectedName = (name) => {
  const acronyms = ["API", "HTML", "JSON", "ORPC", "MCP"];
  const acronymStart = acronyms.find(
    (a) => name.toLowerCase().startsWith(a.toLowerCase()) && name[a.length]?.match(/[A-Z]/),
  );
  const capitaliseLetters = acronymStart ? acronymStart.length : 1;
  return (
    name.slice(0, capitaliseLetters).toUpperCase() +
    name.slice(capitaliseLetters).replace(/Schema$/, "")
  );
};

/** @param {import("estree").MemberExpression | import("estree").Identifier | import("estree").CallExpression} callee */
const getCalleeName = (callee) => {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type !== "MemberExpression") return null;
  if (callee.property.type === "Identifier") return callee.property.name;
  if (callee.property.type === "Literal" && typeof callee.property.value === "string") {
    return callee.property.value;
  }
  return null;
};

/** @param {import("estree").Node | undefined} node */
function getPropertyName(node) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}

/** @param {string} filename */
function normalizePathForLint(filename) {
  return filename.replaceAll("\\", "/");
}

/** @param {string} filename */
function isAllowedRawDurableObjectBindingAccessFile(filename) {
  const path = normalizePathForLint(filename);

  if (!path.includes("/apps/os/src/")) return true;
  if (path.includes("/apps/os/docs/")) return true;
  if (path.includes("/apps/os/src/workers/")) return true;
  // src/itx is THE capability layer (apps/os/docs/itx-spec.md): the handle,
  // restorer, and egress entrypoint legitimately mint Project DO stubs.
  if (path.includes("/apps/os/src/itx/")) return true;
  if (path.includes("/apps/os/src/durable-objects/")) return true;
  if (!path.includes("/apps/os/src/domains/")) return false;

  return (
    path.includes("/durable-objects/") ||
    path.includes("/entrypoints/") ||
    path.endsWith("/durable-object.ts") ||
    path.endsWith("/capability.ts") ||
    path.endsWith("-capability.ts")
  );
}

/** @param {import("estree").Node | undefined} node */
function getRawEnvBindingName(node) {
  if (!node || node.type !== "MemberExpression") return undefined;
  const bindingName = getPropertyName(node.property);
  if (!bindingName) return undefined;
  if (node.object.type === "Identifier" && node.object.name === "env") return bindingName;
  if (
    node.object.type === "MemberExpression" &&
    getPropertyName(node.object.property) === "env" &&
    node.object.object.type === "ThisExpression"
  ) {
    return bindingName;
  }
  return undefined;
}

/** @param {import("estree").Node | undefined} node */
function getTestLintCallName(node) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return undefined;
  const objectName = getTestLintCallObjectName(node.object);
  const propertyName = getPropertyName(node.property);
  if (!objectName || !propertyName) return undefined;
  return `${objectName}.${propertyName}`;
}

/** @param {import("estree").Node} node */
function getTestLintCallObjectName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") return getTestLintCallName(node);
  if (node.type === "CallExpression") return getTestLintCallName(node.callee);
  return undefined;
}

/** @param {import("estree").Node} callee */
function isDescribeCall(callee) {
  const name = getTestLintCallName(callee);
  return name === "describe" || Boolean(name?.startsWith("describe."));
}

/** @param {import("estree").Node} callee */
function isLifecycleHookCall(callee) {
  return callee.type === "Identifier" && LIFECYCLE_HOOKS.has(callee.name);
}

/** @param {import("estree").Node} callee */
function isViMockCall(callee) {
  const name = getTestLintCallName(callee);
  return Boolean(name && VI_MOCK_CALLS.has(name));
}

/** @param {import("estree").Node | undefined} node */
function isTestCallExpression(node) {
  if (!node || node.type !== "CallExpression") return false;
  const name = getTestLintCallName(node.callee);
  if (name === "test" || name === "it" || name?.startsWith("test.") || name?.startsWith("it.")) {
    return true;
  }
  return isTestCallExpression(node.callee);
}

/** @param {import("estree").Node} node */
function isFunctionLikeDeclaration(node) {
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") return true;
  if (node.type !== "VariableDeclaration") return false;
  return node.declarations.some((declarator) => {
    const init = declarator.init;
    return (
      init &&
      (init.type === "FunctionExpression" ||
        init.type === "ArrowFunctionExpression" ||
        init.type === "ClassExpression")
    );
  });
}

/**
 * Counts the source lines spanned by a function's body content: the statements between the
 * braces, or the expression of a concise arrow. Brace-only lines don't count, so
 * `function f() {\n  return x;\n}` is 1 line.
 *
 * @param {import("eslint").SourceCode} sourceCode
 * @param {import("estree").Function} fn
 */
function getFunctionBodyLineCount(sourceCode, fn) {
  const body = fn.body;
  if (!body) return Infinity; // overload signatures / declare function
  let start;
  let end;
  if (body.type === "BlockStatement") {
    const statements = body.body;
    if (statements.length === 0) return 0;
    start = statements[0].range?.[0];
    end = statements[statements.length - 1].range?.[1];
  } else {
    start = body.range?.[0];
    end = body.range?.[1];
  }
  if (start === undefined || end === undefined) return Infinity;
  return sourceCode.getText().slice(start, end).split("\n").length;
}

/**
 * @param {import("eslint").SourceCode} sourceCode
 * @param {import("estree").Function} fn
 */
function hasCommentInsideFunction(sourceCode, fn) {
  const bodyRange = fn.body?.range;
  if (!bodyRange) return false;

  return sourceCode.getAllComments().some((comment) => {
    if (!comment.range) return false;
    return comment.range[0] > bodyRange[0] && comment.range[1] < bodyRange[1];
  });
}

/**
 * @param {import("eslint").SourceCode} sourceCode
 * @param {import("estree").Node} node
 */
function hasLeadingJsDocComment(sourceCode, node) {
  const nodeStartLine = node.loc?.start.line;

  return sourceCode.getCommentsBefore(node).some((comment) => {
    if (comment.type !== "Block") return false;
    if (!comment.value.trim().startsWith("*")) return false;
    return !nodeStartLine || comment.loc?.end.line === nodeStartLine - 1;
  });
}

/**
 * @param {import("eslint").SourceCode} sourceCode
 * @param {import("estree").Function} fn
 */
function hasTypePredicateReturnType(sourceCode, fn) {
  const returnType = fn.returnType || fn.typeAnnotation;
  if (!returnType) return false;

  const returnTypeText = sourceCode.getText(returnType);
  return /\basserts\b/.test(returnTypeText) || /\bis\b/.test(returnTypeText);
}

/** @param {import("estree").Function} fn */
function hasIfStatement(fn) {
  return esquery.match(fn, esquery.parse("IfStatement")).length > 0;
}

/**
 * @param {import("eslint").Scope.Scope | null} scope
 * @param {string} name
 */
function findVariableInScopeChain(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.variables.find((v) => v.name === name);
    if (variable) return variable;
  }
  return undefined;
}

/** @param {string} text */
function compactTypeText(text) {
  return text.replace(/\s+/g, "");
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").ClassDeclaration | import("estree").ClassExpression} node
 */
function getMechanicalClassImplContracts(context, node) {
  if (!node.body.range) return undefined;
  const classText = context.sourceCode.getText(node);
  const headerLength = node.body.range[0] - (node.range?.[0] || 0);
  const classHeader = classText.slice(0, headerLength);
  const implementedTypes = getImplementedContractTypes(classHeader);
  const classStart = node.range?.[0] || 0;
  return implementedTypes.map((implementedType) => ({
    name: implementedType.contractText,
    position: classStart + implementedType.contractStart,
  }));
}

/**
 * @param {string} classHeader
 */
function getImplementedContractTypes(classHeader) {
  const implementsMatch = classHeader.match(/\bimplements\b/);
  if (!implementsMatch) return [];

  const implementsStart = implementsMatch.index + implementsMatch[0].length;
  const implementsText = classHeader.slice(implementsStart);
  return splitTopLevelTypes(implementsText)
    .flatMap((candidate) =>
      getReadableContractTypes(candidate.text, implementsStart + candidate.start),
    )
    .filter(Boolean);
}

/**
 * @param {string} text
 * @param {number} start
 */
function getReadableContractTypes(text, start) {
  const generic = getGenericTypeInfo(text);
  if (!generic) {
    return [{ contractText: text, contractStart: start }];
  }
  return generic.typeArguments.flatMap((argument) =>
    getReadableContractTypes(argument.text, start + argument.start),
  );
}

/** @param {string} text */
function splitTopLevelTypes(text) {
  /** @type {{ text: string; start: number }[]} */
  const types = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "<") depth++;
    if (character === ">") depth--;
    if (character !== "," || depth !== 0) continue;
    appendTopLevelType(types, text, start, index);
    start = index + 1;
  }
  appendTopLevelType(types, text, start, text.length);
  return types;
}

/**
 * @param {{ text: string; start: number }[]} types
 * @param {string} source
 * @param {number} start
 * @param {number} end
 */
function appendTopLevelType(types, source, start, end) {
  const raw = source.slice(start, end);
  const trimmed = raw.trim();
  if (!trimmed) return;
  types.push({
    text: trimmed,
    start: start + raw.indexOf(trimmed),
  });
}

/** @param {string} text */
function getGenericTypeInfo(text) {
  const openBracket = text.indexOf("<");
  if (openBracket === -1) return undefined;
  const closeBracket = findMatchingGenericClose(text, openBracket);
  if (closeBracket === undefined) return undefined;
  const typeName = text.slice(0, openBracket).trim().split(".").at(-1);
  if (!typeName) return undefined;
  const typeArguments = splitTopLevelTypes(text.slice(openBracket + 1, closeBracket));
  const firstArgument = typeArguments[0];
  const firstTypeArgument = firstArgument?.text;
  if (!firstTypeArgument) return undefined;
  return {
    firstTypeArgument,
    firstTypeArgumentStart: openBracket + 1 + firstArgument.start,
    typeArguments: typeArguments.map((argument) => ({
      text: argument.text,
      start: openBracket + 1 + argument.start,
    })),
    typeName,
  };
}

/**
 * @param {string} text
 * @param {number} openBracket
 */
function findMatchingGenericClose(text, openBracket) {
  let depth = 0;
  for (let index = openBracket; index < text.length; index++) {
    const character = text[index];
    if (character === "<") depth++;
    if (character !== ">") continue;
    depth--;
    if (depth === 0) return index;
  }
  return undefined;
}

/** @param {import("estree").Node} node */
function getClassElementName(node) {
  if (!("key" in node)) return undefined;
  return getPropertyName(node.key);
}

/** @param {import("estree").Node} node */
function getClassElementImplementationFunction(node) {
  if (node.type === "MethodDefinition") return node.value;
  if (node.type !== "PropertyDefinition" && node.type !== "FieldDefinition") return undefined;
  const value = node.value;
  if (value?.type !== "ArrowFunctionExpression" && value?.type !== "FunctionExpression") {
    return undefined;
  }
  return value;
}

/** @param {string} text */
function isSimpleImplementationParameterType(text) {
  return /^(bigint|boolean|null|number|object|string|symbol|undefined|unknown|void)(\[\])?$/.test(
    compactTypeText(text),
  );
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").Node} parameter
 */
function getParameterTypeText(context, parameter) {
  if (parameter.type === "AssignmentPattern") return getParameterTypeText(context, parameter.left);
  if (parameter.type === "RestElement") return getParameterTypeText(context, parameter.argument);
  if (!("typeAnnotation" in parameter)) return undefined;
  const annotation = parameter.typeAnnotation?.typeAnnotation;
  return annotation ? context.sourceCode.getText(annotation) : undefined;
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").Node} element
 */
function hasOnlySimpleImplementationParameterTypes(context, element) {
  const parameters = getClassElementImplementationFunction(element)?.params || [];
  if (parameters.length !== 1) return false;
  return parameters.every((parameter) => {
    const typeText = getParameterTypeText(context, parameter);
    return typeText !== undefined && isSimpleImplementationParameterType(typeText);
  });
}

/**
 * @param {import("./lint/oxlint-type-aware.ts").TypeAwareLintFileService} fileService
 * @param {{ name: string; position: number }} candidate
 */
function getMechanicalClassImplContractMethods(fileService, candidate) {
  const typed = fileService.resolveTypeByName(candidate.name, candidate.position);
  if (!typed) return undefined;
  const project = fileService.project;
  if (!project) return undefined;

  return project.checker
    .getPropertiesOfType(typed.type)
    .map((property) => {
      const propertyType = project.checker.getTypeOfSymbol(property);
      if (!propertyType) return undefined;
      const signature = project.checker.getSignaturesOfType(propertyType, SignatureKind.Call)[0];
      if (!signature) return undefined;
      return {
        name: property.name,
        parameters: signature.getParameters().map((parameter) => parameter.name),
        hasRestParameter: signature.hasRestParameter,
      };
    })
    .filter(Boolean);
}

/**
 * @param {{ parameters: string[]; hasRestParameter: boolean }} contractMethod
 * @param {string} contractName
 * @param {string} methodName
 * @param {{ defaultText?: string; name: string; optional: boolean }[]} implementationParameters
 */
function expectedMechanicalClassImplParameterText(
  contractMethod,
  contractName,
  methodName,
  implementationParameters,
) {
  const quotedMethod = JSON.stringify(methodName);
  const parametersType = `Parameters<${contractName}[${quotedMethod}]>`;
  if (contractMethod.parameters.length === 0 || implementationParameters.length === 0) return "";
  if (contractMethod.hasRestParameter) {
    const name = implementationParameters[0]?.name || contractMethod.parameters[0] || "args";
    return `...${name}: ${parametersType}`;
  }
  if (contractMethod.parameters.length === 1) {
    const implementationParameter = implementationParameters[0];
    const name = implementationParameter?.name || contractMethod.parameters[0] || "args";
    const optional = implementationParameter?.optional ? "?" : "";
    const defaultText = implementationParameter?.defaultText
      ? ` = ${implementationParameter.defaultText}`
      : "";
    return `${name}${optional}: ${parametersType}[0]${defaultText}`;
  }
  const names =
    implementationParameters.length === contractMethod.parameters.length
      ? implementationParameters.map((parameter) => parameter.name)
      : contractMethod.parameters;
  return `...[${names.join(", ")}]: ${parametersType}`;
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").Node} element
 */
function getMethodParameterText(context, element) {
  return (
    getClassElementImplementationFunction(element)
      ?.params.map((parameter) => context.sourceCode.getText(parameter))
      .join(", ") || ""
  );
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").Node} element
 */
function getMethodParameterInfo(context, element) {
  return (getClassElementImplementationFunction(element)?.params || []).map((parameter) => {
    if (parameter.type === "RestElement") {
      return {
        name: getPropertyName(parameter.argument) || "args",
        optional: false,
      };
    }
    if (parameter.type === "AssignmentPattern") {
      return {
        defaultText: context.sourceCode.getText(parameter.right),
        name: getPropertyName(parameter.left) || "args",
        optional: Boolean(parameter.left.optional),
      };
    }
    return {
      name: getPropertyName(parameter) || "args",
      optional: Boolean(parameter.optional),
    };
  });
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").Node} element
 */
function getMethodParameterRange(context, element) {
  const keyEnd = element.key?.range?.[1];
  const implementationFunction = getClassElementImplementationFunction(element);
  const bodyStart = implementationFunction?.body?.range?.[0];
  if (keyEnd === undefined || bodyStart === undefined) {
    return undefined;
  }

  const source = context.sourceCode.getText();
  const openParen = source.indexOf("(", keyEnd);
  if (openParen === -1 || openParen > bodyStart) return undefined;

  let depth = 0;
  for (let index = openParen; index < bodyStart; index++) {
    const character = source[index];
    if (character === "(") depth++;
    if (character !== ")") continue;
    depth--;
    if (depth === 0) return [openParen + 1, index];
  }

  return undefined;
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").Node} element
 * @param {string} expectedParameters
 * @param {import("eslint").Rule.RuleFixer} fixer
 */
function fixMethodParameters(context, element, expectedParameters, fixer) {
  const range = getMethodParameterRange(context, element);
  if (!range) return null;
  return fixer.replaceTextRange(range, expectedParameters);
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {[number, number] | undefined} range
 */
function getRangeLocation(context, range) {
  const start = range?.[0];
  const end = range?.[1];
  if (start === undefined || end === undefined) return undefined;
  if (typeof context.sourceCode.getLocFromIndex !== "function") return undefined;
  return {
    start: context.sourceCode.getLocFromIndex(start),
    end: context.sourceCode.getLocFromIndex(end),
  };
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").Node} element
 */
function getMethodParameterLocation(context, element) {
  return getRangeLocation(context, getMethodParameterRange(context, element));
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").Node} element
 */
function getMethodReturnTypeLocation(context, element) {
  const implementationFunction = getClassElementImplementationFunction(element);
  const returnType = implementationFunction?.returnType || implementationFunction?.typeAnnotation;
  return getRangeLocation(context, returnType?.range);
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").Node} element
 */
function hasDisallowedMethodReturnType(context, element) {
  const implementationFunction = getClassElementImplementationFunction(element);
  const returnType = implementationFunction?.returnType || implementationFunction?.typeAnnotation;
  if (!returnType) return false;
  return compactTypeText(context.sourceCode.getText(returnType)) !== ":never";
}

/**
 * @param {import("estree").Node} element
 * @param {import("eslint").Rule.RuleFixer} fixer
 */
function fixMethodReturnType(element, fixer) {
  const implementationFunction = getClassElementImplementationFunction(element);
  const returnType = implementationFunction?.returnType || implementationFunction?.typeAnnotation;
  if (!returnType?.range) return null;
  return fixer.removeRange(returnType.range);
}

/** @param {string} filename */
function isTypeScriptSourceFile(filename) {
  return filename.endsWith(".ts") || filename.endsWith(".tsx");
}

/** @param {import("eslint").Rule.RuleContext} context */
function getPreparedTypeAwareLintFileService(context) {
  const service = getTypeAwareLintService();
  service.setFileText(context.filename, context.sourceCode.getText());
  return service.getFileService(context.filename);
}

/** @param {import("estree").Expression} expression */
function isExplicitlyHandledPromiseExpression(expression) {
  if (expression.type === "AwaitExpression") return true;
  return expression.type === "UnaryExpression" && expression.operator === "void";
}

/** @param {import("estree").CallExpression} node */
function isPromiseHandlingCallExpression(node) {
  if (node.callee.type !== "MemberExpression") return false;
  const propertyName = getPropertyName(node.callee.property);
  return propertyName === "catch" || propertyName === "then" || propertyName === "finally";
}

/** @param {string} text */
function truncateTypeText(text) {
  const maxLength = 180;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

const isolatedCodemodeRule = {
  ...unicorn.rules["isolated-functions"],
  create(context) {
    const original = unicorn.rules["isolated-functions"].create(context);
    for (const codemodeSelector of [":function[codemode]", ":function[codemode]:exit"]) {
      if (codemodeSelector in original) {
        const cb = original[codemodeSelector];
        delete original[codemodeSelector];
        const suffix = codemodeSelector.match(/:exit$/)?.[0] || "";
        const nonClashingCatchallFunctionSelector = `FunctionExpression[random!="${Math.random()}"]${suffix}`;
        original[nonClashingCatchallFunctionSelector] = (node, ...args) => {
          const parentCallee = node.parent?.callee;
          if (!parentCallee) return;
          if (!context.sourceCode.getText(parentCallee).match(/\bcodemode\b/i)) return;
          if (!context.sourceCode.getText(parentCallee).match(/\bfixture\b/i)) return;
          return cb(node, ...args);
        };
        original[`Arrow${nonClashingCatchallFunctionSelector}`] =
          original[nonClashingCatchallFunctionSelector];
      }
    }
    return original;
  },
};

/** @param {import("estree").CallExpression} node */
function getMatcherCall(node) {
  if (node.callee.type !== "MemberExpression") return undefined;
  const matcherName = getPropertyName(node.callee.property);
  if (!PROPERTY_MATCHERS.has(matcherName)) return undefined;

  let expectChain = node.callee.object;
  if (expectChain.type === "MemberExpression" && getPropertyName(expectChain.property) === "not") {
    expectChain = expectChain.object;
  }

  if (
    expectChain.type !== "CallExpression" ||
    expectChain.callee.type !== "Identifier" ||
    expectChain.callee.name !== "expect"
  ) {
    return undefined;
  }

  const actual = expectChain.arguments[0];
  if (!actual || actual.type !== "MemberExpression") return undefined;
  if (actual.computed) return undefined;

  const propertyName = getPropertyName(actual.property);
  if (propertyName === "length") return undefined;

  return { actual, matcherName };
}

/**
 * @param {string} source
 * @param {string} filename
 */
function getRelativeTsImportWithExtension(source, filename) {
  if (!filename) return undefined;
  if (!source.startsWith("./") && !source.startsWith("../")) return undefined;

  const queryIndex = source.search(/[?#]/);
  const modulePath = queryIndex === -1 ? source : source.slice(0, queryIndex);
  const segments = modulePath.split("/");
  const lastSegment = segments[segments.length - 1] || "";
  if (!lastSegment || lastSegment.includes(".")) return undefined;

  const resolvedTsPath = resolve(dirname(filename), `${modulePath}.ts`);
  if (!existsSync(resolvedTsPath)) return undefined;

  return `${modulePath}.ts${queryIndex === -1 ? "" : source.slice(queryIndex)}`;
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").Literal} sourceNode
 */
function reportMissingRelativeImportExtension(context, sourceNode) {
  if (typeof sourceNode.value !== "string") return;

  const fixedSource = getRelativeTsImportWithExtension(sourceNode.value, context.filename || "");
  if (!fixedSource) return;

  context.report({
    node: sourceNode,
    message: `Use "${fixedSource}" instead of "${sourceNode.value}".`,
    fix: (fixer) => {
      const sourceText = context.sourceCode.getText(sourceNode);
      const quote = sourceText[0];
      const fixedSourceText =
        (quote === '"' || quote === "'") && sourceText.endsWith(quote)
          ? `${quote}${fixedSource}${quote}`
          : JSON.stringify(fixedSource);
      return fixer.replaceText(sourceNode, fixedSourceText);
    },
  });
}

// custom iterate-internal rules
/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
  meta: {
    name: "iterate",
  },
  rules: {
    "no-capnweb-http-batch": {
      meta: {
        docs: {
          description:
            "Forbid capnweb's newHttpBatchRpcSession - always use a WebSocket session instead",
        },
        type: "problem",
      },
      create: (context) => {
        return {
          Identifier: (node) => {
            if (node.name === "newHttpBatchRpcSession") {
              context.report({
                node,
                message:
                  "Never use newHttpBatchRpcSession. Stateless workers can hold a WebSocket session for the duration of a request - use newWebSocketRpcSession and dispose it when the call completes.",
              });
            }
          },
        };
      },
    },
    "no-public-procedure": {
      meta: {
        docs: {
          description:
            "Warn against usage of publicProcedure - prefer flexibleAuthProcedure or other auth procedures",
        },
        type: "suggestion",
      },
      create: (context) => {
        return {
          Identifier: (node) => {
            if (node.name === "publicProcedure" && node.parent.type === "MemberExpression") {
              context.report({
                node,
                message:
                  "Avoid using publicProcedure unless the procedure truly must be publicly accessible - prefer one of the authenticated procedures instead",
              });
            }
          },
        };
      },
    },
    "zod-schema-naming": {
      meta: {
        docs: {
          description: `Zod schemas should be pascal case, and should not end with "Schema"`,
        },
        hasSuggestions: true,
        type: "suggestion",
        fixable: "code",
      },
      create: (context) => {
        return {
          "VariableDeclarator[init.callee.object.name='z']": ({ init, id }) => {
            if (init.callee.property.name === "toJSONSchema") return;
            if (init.callee.property.name === "prettifyError") return;

            const actualName = id.name;
            const expectedName = getExpectedName(actualName);

            if (actualName !== expectedName && actualName !== "schema") {
              context.report({
                node: id,
                message: `Rename zod schema ${actualName} to ${expectedName} or similar`,
                // disabled suggestion because you really need to do a IDE refactor to change all references
                // suggest: [{ desc: `Rename to ${expectedName}`, fix: fixer => fixer.replaceTextRange(id.range, expectedName) }]
              });
            }
          },
          "TSTypeAliasDeclaration[typeAnnotation.typeName.left.name='z'][typeAnnotation.typeName.right.name='infer']":
            (node) => {
              const typeName = node.id.name;
              const variableName = node.typeAnnotation?.typeArguments?.params?.[0]?.exprName?.name;

              if (variableName && variableName !== typeName) {
                const expectedTypeName = getExpectedName(typeName);
                const messages = [
                  typeName !== expectedTypeName && `rename the type alias to ${expectedTypeName}`,
                  variableName !== expectedTypeName &&
                    `rename the variable from ${variableName} to ${expectedTypeName}`,
                ];
                const suggestion = messages.filter(Boolean).join(" and ") || "rename the variable";
                context.report({
                  node,
                  message: `Type ${typeName} should be the z.infer result for a schema with the same name. Suggestion: ${suggestion}.`,
                });
              }
            },
        };
      },
    },
    // oxlint doesn't have fixToSuggestionInIDE, so we reimplement prefer-const as a suggestion-only rule.
    // this means `--fix` won't auto-convert let to const (you need `--fix-suggestions` for that).
    "prefer-const": {
      meta: {
        type: "suggestion",
        hasSuggestions: true,
        docs: {
          description:
            "Require `const` declarations for variables that are never reassigned after declared. Reported as a suggestion (not auto-fix) so it doesn't aggressively rewrite `let` while you're still writing code.",
        },
      },
      create: (context) => {
        return {
          VariableDeclaration: (node) => {
            if (node.kind !== "let") return;
            const scope = context.sourceCode.getScope(node);
            for (const declarator of node.declarations) {
              if (!declarator.id || declarator.id.type !== "Identifier") continue;
              if (!declarator.init) continue; // `let x;` without init is fine
              const variable = scope.variables.find((v) => v.name === declarator.id.name);
              if (!variable) continue;
              const isReassigned = variable.references.some(
                (ref) => ref.isWrite() && ref.identifier !== declarator.id,
              );
              if (isReassigned) continue;
              context.report({
                node: declarator.id,
                message: `'${declarator.id.name}' is never reassigned. Use \`const\` instead.`,
                suggest: [
                  {
                    desc: "Change to const, if you're finished tinkering",
                    fix: (fixer) => {
                      // Only fix if this is the only declarator — otherwise
                      // changing `let a = 1, b = 2` where only `a` is const is complex
                      if (node.declarations.length > 1) return null;
                      const letToken = context.sourceCode.getFirstToken(node);
                      if (!letToken || letToken.value !== "let") return null;
                      return fixer.replaceText(letToken, "const");
                    },
                  },
                ],
              });
            }
          },
        };
      },
    },
    "typed-no-floating-promises": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Require promise-returning expression statements to be awaited, returned, or explicitly voided.",
        },
      },
      create(context) {
        if (!isTypeScriptSourceFile(context.filename || "")) return {};

        /** @type {import("./lint/oxlint-type-aware.ts").TypeAwareLintFileService | undefined} */
        let fileService;

        return {
          CallExpression(node) {
            if (node.parent?.type !== "ExpressionStatement") return;
            if (isExplicitlyHandledPromiseExpression(node.parent.expression)) return;
            if (isPromiseHandlingCallExpression(node)) return;

            fileService ??= getPreparedTypeAwareLintFileService(context);
            const thenable = fileService.getThenableInfo(node);
            if (!thenable) return;

            context.report({
              node,
              message:
                `Promise-like expression of type \`${truncateTypeText(thenable.text)}\` is not handled. ` +
                "Await it, return it, or explicitly mark it with `void`.",
            });
          },
        };
      },
    },
    "mechanical-class-impl": {
      meta: {
        type: "problem",
        fixable: "code",
        schema: [],
        docs: {
          description:
            "Require class implementation method params to mechanically reference the implemented interface via Parameters<Contract[method]>.",
        },
      },
      create(context) {
        if (!isTypeScriptSourceFile(context.filename || "")) return {};

        /** @type {import("./lint/oxlint-type-aware.ts").TypeAwareLintFileService | undefined} */
        let fileService;

        return {
          "ClassDeclaration, ClassExpression": (node) => {
            const contracts = getMechanicalClassImplContracts(context, node);
            if (!contracts?.length) return;

            fileService ??= getPreparedTypeAwareLintFileService(context);
            const classMethodNames = new Set(
              node.body.body
                .filter((element) => getClassElementImplementationFunction(element))
                .map((element) => getClassElementName(element))
                .filter(Boolean),
            );
            const contract = contracts
              .map((candidate) => ({
                candidate,
                properties: getMechanicalClassImplContractMethods(fileService, candidate),
              }))
              .find(({ properties }) =>
                properties?.some((property) => classMethodNames.has(property.name)),
              );
            if (!contract?.properties) return;

            const methods = new Map(
              contract.properties.map((property) => [property.name, property]),
            );
            for (const element of node.body.body) {
              if (!getClassElementImplementationFunction(element)) continue;
              if (element.type === "MethodDefinition" && element.kind === "constructor") continue;
              const methodName = getClassElementName(element);
              if (!methodName) continue;

              const method = methods.get(methodName);
              if (!method) continue;

              const implementationParameters = getMethodParameterInfo(context, element);
              const expectedParameterText = expectedMechanicalClassImplParameterText(
                method,
                contract.candidate.name,
                methodName,
                implementationParameters,
              );
              const actualParameters = compactTypeText(getMethodParameterText(context, element));
              const expectedParameters = compactTypeText(expectedParameterText);
              if (
                actualParameters !== expectedParameters &&
                !hasOnlySimpleImplementationParameterTypes(context, element)
              ) {
                context.report({
                  node: element,
                  loc: getMethodParameterLocation(context, element),
                  message: `Infer implementation params from the contract: \`${expectedParameterText}\`.`,
                  fix: (fixer) =>
                    fixMethodParameters(context, element, expectedParameterText, fixer),
                });
              }

              if (hasDisallowedMethodReturnType(context, element)) {
                context.report({
                  node: element,
                  loc: getMethodReturnTypeLocation(context, element),
                  message: `Infer the return type from the contract.`,
                  fix: (fixer) => fixMethodReturnType(element, fixer),
                });
              }
            }
          },
        };
      },
    },
    "isolated-codemode": isolatedCodemodeRule,
    "relative-import-extensions": {
      meta: {
        type: "problem",
        fixable: "code",
        docs: {
          description:
            "Require .ts extensions on relative imports when the matching .ts file exists.",
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            reportMissingRelativeImportExtension(context, node.source);
          },
          ExportNamedDeclaration(node) {
            if (!node.source) return;
            reportMissingRelativeImportExtension(context, node.source);
          },
          ExportAllDeclaration(node) {
            reportMissingRelativeImportExtension(context, node.source);
          },
          ImportExpression(node) {
            if (node.source.type !== "Literal") return;
            reportMissingRelativeImportExtension(context, node.source);
          },
          TSImportType(node) {
            if (!node.argument) return;
            if (node.argument.type !== "Literal") return;
            reportMissingRelativeImportExtension(context, node.argument);
          },
        };
      },
    },
    "no-lifecycle-hooks": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow beforeEach/beforeAll/afterEach/afterAll in test files; use disposable fixtures instead.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isLifecycleHookCall(node.callee)) return;
            context.report({
              node,
              message:
                "Avoid Vitest lifecycle hooks in test files. Prefer fixtures with Symbol.dispose or Symbol.asyncDispose.",
            });
          },
        };
      },
    },
    "no-describe": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Keep test files flat so the first readable unit is the test itself, not a describe wrapper.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isDescribeCall(node.callee)) return;
            context.report({
              node,
              message:
                "Avoid describe blocks. Keep tests as top-level test(...) calls unless grouping is truly necessary.",
            });
          },
        };
      },
    },
    "no-vi-mock": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Avoid vi.mock in tests; prefer dependency injection and controllable fakes at the product boundary.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isViMockCall(node.callee)) return;
            context.report({
              node,
              message:
                "Avoid vi.mock/vi.doMock in tests. Prefer dependency injection or a controllable fake dependency.",
            });
          },
        };
      },
    },
    "no-single-use-helpers": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Flag undocumented tiny non-exported helper functions that are only used once. Inline them so the reader can see what's actually happening instead of chasing an indirection.",
        },
      },
      create(context) {
        const MAX_BODY_LINES = 1;

        /**
         * @param {import("estree").Identifier} id the helper's name binding
         * @param {import("estree").Function} fn the function node
         * @param {import("estree").Node} statement the enclosing declaration statement
         */
        function checkHelper(id, fn, statement) {
          const exportParent = statement.parent?.type;
          if (
            exportParent === "ExportNamedDeclaration" ||
            exportParent === "ExportDefaultDeclaration"
          ) {
            return;
          }

          const bodyLines = getFunctionBodyLineCount(context.sourceCode, fn);
          if (bodyLines > MAX_BODY_LINES) return;
          if (
            statement.type === "VariableDeclaration" &&
            (statement.kind === "let" || statement.kind === "var")
          ) {
            return;
          }
          if (hasIfStatement(fn)) return;
          if (hasLeadingJsDocComment(context.sourceCode, statement)) return;
          if (hasCommentInsideFunction(context.sourceCode, fn)) return;
          if (hasTypePredicateReturnType(context.sourceCode, fn)) return;

          const scope = context.sourceCode.getScope(statement);
          const variable = findVariableInScopeChain(scope, id.name);
          if (!variable) return;

          const reads = variable.references.filter((ref) => ref.isRead());
          // `export { helper }` / `export default helper` make it part of the module's surface
          const isExportedReference = reads.some((ref) => {
            const parentType = ref.identifier.parent?.type;
            return parentType === "ExportSpecifier" || parentType === "ExportDefaultDeclaration";
          });
          if (isExportedReference) return;

          // a recursive helper can't be inlined, so any self-reference disqualifies it
          const hasSelfReference = reads.some((ref) => {
            const referenceStart = ref.identifier.range?.[0];
            if (referenceStart === undefined || !fn.range) return false;
            return referenceStart >= fn.range[0] && referenceStart < fn.range[1];
          });
          if (hasSelfReference) return;
          if (reads.length !== 1) return;

          context.report({
            node: id,
            message:
              `${id.name} is a single-use helper with a ${bodyLines}-line body. ` +
              `Inline it at the call site so the reader can see what's actually happening.`,
          });
        }

        return {
          FunctionDeclaration(node) {
            if (!node.id) return;
            checkHelper(node.id, node, node);
          },
          VariableDeclarator(node) {
            if (node.id.type !== "Identifier" || !node.init) return;
            if (
              node.init.type !== "ArrowFunctionExpression" &&
              node.init.type !== "FunctionExpression"
            ) {
              return;
            }
            checkHelper(node.id, node.init, node.parent);
          },
        };
      },
    },
    "helpers-after-tests": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Keep helper functions and fixture builders below the top-level tests in each test file.",
        },
      },
      create(context) {
        return {
          Program(node) {
            const lastTestIndex = node.body.findLastIndex((statement) => {
              return (
                statement.type === "ExpressionStatement" &&
                isTestCallExpression(statement.expression)
              );
            });
            if (lastTestIndex === -1) return;

            for (const statement of node.body.slice(0, lastTestIndex)) {
              if (!isFunctionLikeDeclaration(statement)) continue;
              context.report({
                node: statement,
                message:
                  "Move test helpers below the tests so the file opens with behavior, not setup.",
              });
            }
          },
        };
      },
    },
    "prefer-object-property-match": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Prefer expect(object).toMatchObject({ property }) over expect(object.property).toBe(...).",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const matcherCall = getMatcherCall(node);
            if (!matcherCall) return;

            const propertyName = getPropertyName(matcherCall.actual.property);
            const sourceText = context.sourceCode.getText(matcherCall.actual.object);
            const propertyText = propertyName ? `.${propertyName}` : ".[property]";
            context.report({
              node,
              message:
                `Prefer expect(${sourceText}).toMatchObject({ ${propertyName || "property"}: ... }) ` +
                `over expect(${sourceText}${propertyText}).${matcherCall.matcherName}(...).`,
            });
          },
        };
      },
    },
    "prefer-test-over-it": {
      meta: {
        type: "suggestion",
        docs: {
          description: "Use Vitest test(...) instead of it(...).",
        },
      },
      create(context) {
        return {
          ImportSpecifier(node) {
            if (node.imported.type !== "Identifier" || node.imported.name !== "it") return;
            context.report({
              node,
              message: 'Import and use `test` from "vitest" instead of `it`.',
            });
          },
          CallExpression(node) {
            const name = getTestLintCallName(node.callee);
            if (name !== "it" && !name?.startsWith("it.")) return;
            context.report({
              node,
              message: "Use test(...) instead of it(...).",
            });
          },
        };
      },
    },
    "import-rules": {
      meta: {
        fixable: "code",
      },
      create: (context) => {
        return {
          ImportDeclaration: (node) => {
            const parentBodyIndex = node.parent.body.indexOf(node);
            const lastImportIndex = node.parent.body.findLastIndex(
              (n) => n.type === "ImportDeclaration",
            );
            if (parentBodyIndex === -1 || parentBodyIndex !== lastImportIndex) {
              return;
            }
            const exportsBefore = node.parent.body
              .slice(0, parentBodyIndex)
              .filter(
                (n) =>
                  n.type === "ExportDeclaration" ||
                  n.type === "ExportNamedDeclaration" ||
                  n.type === "ExportAllDeclaration" ||
                  n.type === "ExportDefaultDeclaration",
              );

            exportsBefore.forEach((e) => {
              context.report({
                node: e,
                message: `Exports should come after imports`,
              });
            });
          },
          "ImportDeclaration[specifiers.length=0]": (node) => {
            const parentBodyIndex = node.parent.body.indexOf(node);
            const nonSideEffectImportBefore = node.parent.body
              .slice(0, parentBodyIndex)
              .find((n) => n.type === "ImportDeclaration" && n.specifiers.length);
            if (!nonSideEffectImportBefore) {
              return;
            }
            context.report({
              node,
              message: "Side-effect imports need to go before non-side-effect imports",
              fix: (fixer) => {
                return [
                  fixer.removeRange([node.range[0], node.range[1] + 1]),
                  fixer.insertTextBefore(
                    nonSideEffectImportBefore,
                    // @ts-expect-error getText exists I swear
                    `${context.sourceCode.getText(node)}\n`,
                  ),
                ];
              },
            });
          },
        };
      },
    },
    "no-direct-waituntil-import": {
      meta: {
        docs: {
          description:
            "Disallow importing waitUntil directly from cloudflare:workers - use the wrapper from env.ts instead",
        },
        type: "problem",
      },
      create: (context) => {
        return {
          ImportDeclaration: (node) => {
            if (node.source.value === "cloudflare:workers") {
              const waitUntilImport = node.specifiers.find(
                (spec) =>
                  (spec.type === "ImportSpecifier" && spec.imported.name === "waitUntil") ||
                  spec.type === "ImportNamespaceSpecifier",
              );
              if (waitUntilImport) {
                context.report({
                  node: waitUntilImport,
                  message:
                    'Do not import waitUntil directly from "cloudflare:workers". Use the error-handling wrapper from "../env.ts" instead: import { waitUntil } from "../env.ts"',
                });
              }
            }
          },
        };
      },
    },
    "no-raw-durable-object-binding-access": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Restrict raw env.*.getByName Durable Object namespace access to capability adapters and trusted domain internals.",
        },
      },
      create: (context) => {
        return {
          "CallExpression[callee.type='MemberExpression']": (node) => {
            if (getPropertyName(node.callee.property) !== "getByName") return;
            const bindingName = getRawEnvBindingName(node.callee.object);
            if (!bindingName) return;
            if (isAllowedRawDurableObjectBindingAccessFile(context.filename ?? "")) return;

            context.report({
              node,
              message:
                `Raw env.${bindingName}.getByName(...) access is privileged platform authority. ` +
                `Untrusted ingress should go through the root capability/capability adapter instead. ` +
                `Allowed locations are domain Durable Objects, domain entrypoints, capability files, ` +
                `and the current Cap'n Web compatibility layer.`,
            });
          },
        };
      },
    },
    "drizzle-conventions": {
      meta: {
        hasSuggestions: true,
        fixable: "code",
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create: (context) => {
        const dbMutateMethods = ["insert", "update", "delete"];
        /** @type {Record<string, Function>} */
        const dbMutateEnforcementListeners = {};
        for (const m of dbMutateMethods) {
          const selector = `CallExpression[callee.object.type='Identifier'][callee.property.name='${m}'][arguments.0.type='Identifier']`;
          const selector2 = `CallExpression[callee.object.type='Identifier'][callee.property.name='${m}'][arguments.0.object.name='schemas']`;
          dbMutateEnforcementListeners[selector] = (node) => {
            const before = context.sourceCode.getText(node.arguments[0]);
            const after = before.startsWith("schemas.")
              ? before.replace("schemas.", "schema.")
              : `schema.${node.arguments[0].name}`;
            if (
              (m === "delete" || m === "update") &&
              node.callee.object.name !== "db" &&
              node.callee.object.name !== "tx"
            ) {
              return; // too many false positives for Maps, hmac.update, etc.
            }
            context.report({
              node: node.arguments[0],
              message: `use \`db.${m}(${after})\` instead of \`db.${m}(${before})\` - it makes it easier to find ${m} expressions in the codebase`,
              suggest: [
                {
                  desc: `Change \`${before}\` to \`${after}\``,
                  fix: (fixer) => fixer.replaceText(node.arguments[0], after),
                },
              ],
            });
          };
          dbMutateEnforcementListeners[selector2] = dbMutateEnforcementListeners[selector];
        }

        return {
          ...dbMutateEnforcementListeners,

          "CallExpression[callee.property.name='transaction']": (node) => {
            const parentReference = context.sourceCode.getText(node.callee.object);
            const shouldUse = node.arguments[0].params[0]?.name;
            esquery.match(node, esquery.parse(`${node.callee.object.type}`)).forEach((m) => {
              const used = context.sourceCode.getText(m);
              if (m !== node.callee.object && parentReference === used) {
                context.report({
                  node: m,
                  message: `Don't use the parent connection (${used}) in a transaction. Use the passed in transaction connection (${shouldUse}).`,
                  suggest: [
                    {
                      desc: `Change \`${used}\` to \`${shouldUse}\``,
                      fix: (fixer) => fixer.replaceText(m, shouldUse),
                    },
                  ],
                });
              }
            });
          },
        };
      },
    },
    "spec-restricted-syntax": {
      meta: {
        type: "problem",
      },
      create: (context) => {
        return {
          CallExpression: (node) => {
            if (node.callee.type === "Identifier" && node.callee.name === "expect") {
              let expr = node;
              while ((expr = expr.parent)) {
                if (expr.type === "AwaitExpression") break;
              }
              if (!expr) return;
              context.report({
                node,
                message: `Use locators, not expect. Locators are configured to wait for loading UI to complete, so allow for faster failures and more reliable assertions. For example: page.getByText("...").waitFor() instead of expect(page.getByText("...")).toBeVisible(). If you can't use a locator and must use polling, expect.poll is acceptable.`,
              });
              return;
            }

            if (
              node.callee.type === "MemberExpression" &&
              node.callee.property.type === "Identifier" &&
              node.callee.property.name === "toBe"
            ) {
              const firstArg = node.arguments[0];
              if (
                firstArg &&
                firstArg.type === "Literal" &&
                (firstArg.value === true || firstArg.value === false)
              ) {
                context.report({
                  node,
                  message: `Don't use toBe(true) or toBe(false), this is an indicator of an assertion that will fail unhelpfully. Examples: use \`await expect.poll(() => realtimeMessages).toMatchObject(expect.arrayContaining([expect.stringContaining("CONNECTED")]));\` instead of \`await expect.poll(() => realtimeMessages.some((msg) => msg.includes("CONNECTED"))).toBe(true);\`.`,
                });
                return;
              }
            }

            const calleeName = getCalleeName(node.callee);
            if (calleeName === "waitForURL") {
              context.report({
                node,
                message: `Don't use waitForURL, use a locator with .waitFor() instead, this accounts for loading UI. If necessary, you can add "data-*" attributes to the product code so you have a concrete, reliable locator.`,
              });
              return;
            }

            if (calleeName !== "goto") {
              return;
            }
            const firstArg = node.arguments[0];
            if (firstArg?.type !== "TemplateLiteral") {
              return;
            }
            const usesBaseUrl = firstArg.expressions.some(
              (expression) => expression.type === "Identifier" && expression.name === "baseURL",
            );
            if (!usesBaseUrl) {
              return;
            }
            context.report({
              node,
              message: `Don't use baseURL in goto, it's added as a prefix automatically. e.g. instead of \`await page.goto(\`\${baseURL}/foo/bar}\`)\`, use \`await page.goto("/foo/bar")\``,
            });
          },
        };
      },
    },
    /**
     * Contract packages (`apps/*-contract/src`) are imported by BOTH server
     * and client (browser) code. They must contain nothing but oRPC contract
     * definitions, Zod schemas, and lightweight client wiring. Pulling in
     * anything heavier — Node built-ins, OpenTelemetry, evlog, vite, the
     * shared barrel, etc. — breaks Vite production builds and bloats client
     * bundles.
     *
     * This rule enforces an explicit allowlist of permitted runtime import
     * sources. Type-only imports (`import type { … }`) are always fine
     * because they're erased at build time.
     *
     * Allowlist entries:
     * - `ALLOWED_RUNTIME_IMPORT_PREFIXES`: exact match or `pkg + "/..."` subpaths.
     * - `ALLOWED_RUNTIME_IMPORT_REGEX`: optional RegExp `source` strings (must match
     *   full specifier). Use only when a prefix is too broad.
     *
     * If you need to add a new package, verify it has ZERO transitive
     * Node/server deps, then add a prefix or regex below.
     */
    "contract-package-imports": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Restrict runtime imports in *-contract packages to a small allowlist of lightweight packages",
        },
      },
      create: (context) => {
        /** @type {string[]} */
        const ALLOWED_RUNTIME_IMPORT_PREFIXES = [
          "zod",
          "@orpc/contract",
          "@orpc/zod",
          "@iterate-com/shared/apps",
          "@orpc/client",
          "@orpc/openapi-client",
        ];
        /** @type {string[]} Full specifier must match (anchored in code). */
        const ALLOWED_RUNTIME_IMPORT_REGEX = [
          // OS's contract needs to share event-stream and codemode wire
          // schemas with the services that persist/execute those payloads.
          // These exact entrypoints are Zod schema modules on their runtime
          // paths; do not broaden to the package prefixes without checking
          // for Node/server transitive imports first.
          "@iterate-com/shared/callable/descriptor-types\\.ts",
          "@iterate-com/shared/codemode/types",
          "@iterate-com/shared/streams/types",
        ];
        const compiledRegex = ALLOWED_RUNTIME_IMPORT_REGEX.map(
          (pattern) => new RegExp(`^${pattern}$`),
        );

        /**
         * @param {string} source
         */
        function isAllowedRuntimeImport(source) {
          if (
            ALLOWED_RUNTIME_IMPORT_PREFIXES.some(
              (pkg) => source === pkg || source.startsWith(pkg + "/"),
            )
          ) {
            return true;
          }
          return compiledRegex.some((re) => re.test(source));
        }

        const filename = context.filename ?? "";
        const isTestFile = /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename);

        const allowedListForMessage =
          ALLOWED_RUNTIME_IMPORT_PREFIXES.map((p) => `  • ${p} (and ${p}/…)`).join("\n") +
          (ALLOWED_RUNTIME_IMPORT_REGEX.length > 0
            ? "\n\n" + ALLOWED_RUNTIME_IMPORT_REGEX.map((p) => `  • /^${p}$/`).join("\n")
            : "");

        return {
          ImportDeclaration: (node) => {
            if (isTestFile) return;
            if (node.importKind === "type") return;

            const allSpecifiersTypeOnly =
              node.specifiers.length > 0 && node.specifiers.every((s) => s.importKind === "type");
            if (allSpecifiersTypeOnly) return;

            const source = node.source.value;

            if (source.startsWith(".") || source.startsWith("/")) return;

            if (isAllowedRuntimeImport(source)) return;

            context.report({
              node,
              message:
                `Forbidden runtime import "${source}" in a contract package.\n\n` +
                `Contract packages are imported by both server and browser code, so they ` +
                `must stay ultra-light. Only these runtime imports are allowed:\n\n` +
                allowedListForMessage +
                `\n\nRelative imports and \`import type\` are always fine.\n` +
                `If "${source}" is genuinely lightweight (zero Node/server deps), add a ` +
                `prefix to ALLOWED_RUNTIME_IMPORT_PREFIXES or a pattern to ` +
                `ALLOWED_RUNTIME_IMPORT_REGEX in oxlint-plugin-iterate.js.`,
            });
          },
        };
      },
    },
    "no-implied-eval": {
      meta: {
        type: "problem",
      },
      create: (context) => {
        return {
          CallExpression: (node) => {
            const calleeName = getCalleeName(node.callee);
            if (
              calleeName !== "setTimeout" &&
              calleeName !== "setInterval" &&
              calleeName !== "execScript"
            ) {
              return;
            }

            const firstArg = node.arguments[0];
            if (!firstArg) {
              return;
            }

            const isStringLiteral =
              firstArg.type === "Literal" && typeof firstArg.value === "string";
            const isTemplateLiteral = firstArg.type === "TemplateLiteral";
            if (!isStringLiteral && !isTemplateLiteral) {
              return;
            }

            context.report({
              node: firstArg,
              message: "Implied eval. Pass a function instead of a string.",
            });
          },
        };
      },
    },
  },
};

export default plugin;
