import { SignatureKind } from "@typescript/native-preview/unstable/sync";
import type { Rule } from "eslint";
import type { Node } from "estree";

import { getTypeAwareLintService, type TypeAwareLintFileService } from "../oxlint-type-aware.ts";
import type { StrictRule } from "../types.ts";

type TypeTextReference = {
  start: number;
  text: string;
};

export const mechanicalClassImplRule: StrictRule = {
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
    const filename = context.filename || "";
    if (!filename.endsWith(".ts") && !filename.endsWith(".tsx")) return {};

    let fileService: TypeAwareLintFileService | undefined;

    return {
      "ClassDeclaration, ClassExpression": (node) => {
        const contracts = getMechanicalClassImplContracts(context, node);
        if (!contracts?.length) return;

        fileService ??= getPreparedTypeAwareLintFileService(context);
        if (!fileService) return;
        const typedFileService = fileService;
        const classMethodNames = new Set(
          node.body.body
            .filter((element) => getClassElementImplementationFunction(element))
            .map((element) => getClassElementName(element))
            .filter(Boolean),
        );
        const contract = contracts
          .map((candidate) => ({
            candidate,
            properties: getMechanicalClassImplContractMethods(typedFileService, candidate),
          }))
          .find(({ properties }) =>
            properties?.some((property: any) => classMethodNames.has(property.name)),
          );
        if (!contract?.properties) return;

        const methods = new Map(contract.properties.map((property) => [property!.name, property]));
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
              loc: getRangeLocation(
                context,
                getMethodParameterRange(context, element) as [number, number] | undefined,
              ),
              message: `Infer implementation params from the contract: \`${expectedParameterText}\`.`,
              fix: (fixer: Rule.RuleFixer) =>
                fixMethodParameters(context, element, expectedParameterText, fixer),
            });
          }

          if (hasDisallowedMethodReturnType(context, element)) {
            context.report({
              node: element,
              loc: getMethodReturnTypeLocation(context, element),
              message: `Infer the return type from the contract.`,
              fix: (fixer: Rule.RuleFixer) => fixMethodReturnType(element, fixer),
            });
          }
        }
      },
    };
  },
};

function getMechanicalClassImplContracts(context: Rule.RuleContext, node: any) {
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

function getImplementedContractTypes(classHeader: string) {
  const implementsMatch = classHeader.match(/\bimplements\b/);
  if (!implementsMatch) return [];

  const implementsStart = (implementsMatch.index || 0) + implementsMatch[0].length;
  const implementsText = classHeader.slice(implementsStart);
  return splitTopLevelTypes(implementsText)
    .flatMap((candidate) =>
      getReadableContractTypes(candidate.text, implementsStart + candidate.start),
    )
    .filter(Boolean);
}

type ContractTypeReference = {
  contractStart: number;
  contractText: string;
};

function getReadableContractTypes(text: string, start: number): ContractTypeReference[] {
  const generic = getGenericTypeInfo(text);
  if (!generic) {
    return [{ contractText: text, contractStart: start }];
  }
  return generic.typeArguments.flatMap((argument) =>
    getReadableContractTypes(argument.text, start + argument.start),
  );
}

function splitTopLevelTypes(text: string): TypeTextReference[] {
  const types: TypeTextReference[] = [];
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

function appendTopLevelType(
  types: TypeTextReference[],
  source: string,
  start: number,
  end: number,
) {
  const raw = source.slice(start, end);
  const trimmed = raw.trim();
  if (!trimmed) return;
  types.push({
    text: trimmed,
    start: start + raw.indexOf(trimmed),
  });
}

function getGenericTypeInfo(text: string) {
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

function findMatchingGenericClose(text: string, openBracket: number) {
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

function getClassElementName(node: any) {
  if (!("key" in node)) return undefined;
  return getPropertyName(node.key);
}

function getClassElementImplementationFunction(node: any) {
  if (node.type === "MethodDefinition") return node.value;
  if (node.type !== "PropertyDefinition" && node.type !== "FieldDefinition") return undefined;
  const value = node.value;
  if (value?.type !== "ArrowFunctionExpression" && value?.type !== "FunctionExpression") {
    return undefined;
  }
  return value;
}

function isSimpleImplementationParameterType(text: string) {
  return /^(bigint|boolean|null|number|object|string|symbol|undefined|unknown|void)(\[\])?$/.test(
    compactTypeText(text),
  );
}

function getParameterTypeText(context: Rule.RuleContext, parameter: any) {
  if (parameter.type === "AssignmentPattern") return getParameterTypeText(context, parameter.left);
  if (parameter.type === "RestElement") return getParameterTypeText(context, parameter.argument);
  if (!("typeAnnotation" in parameter)) return undefined;
  const annotation = parameter.typeAnnotation?.typeAnnotation;
  return annotation ? context.sourceCode.getText(annotation) : undefined;
}

function hasOnlySimpleImplementationParameterTypes(context: Rule.RuleContext, element: any) {
  const parameters = getClassElementImplementationFunction(element)?.params || [];
  if (parameters.length !== 1) return false;
  return parameters.every((parameter: any) => {
    const typeText = getParameterTypeText(context, parameter);
    return typeText !== undefined && isSimpleImplementationParameterType(typeText);
  });
}

function getMechanicalClassImplContractMethods(
  fileService: TypeAwareLintFileService,
  candidate: { name: string; position: number },
) {
  const typed = fileService.resolveTypeByName(candidate.name, candidate.position);
  if (!typed) return undefined;

  return fileService.project.checker
    .getPropertiesOfType(typed.type)
    .map((property: any) => {
      const propertyType = fileService.project.checker.getTypeOfSymbol(property);
      if (!propertyType) return undefined;
      const signature = fileService.project.checker.getSignaturesOfType(
        propertyType,
        SignatureKind.Call,
      )[0];
      if (!signature) return undefined;
      return {
        name: property.name,
        parameters: signature.getParameters().map((parameter: any) => parameter.name),
        hasRestParameter: signature.hasRestParameter,
      };
    })
    .filter(Boolean);
}

function expectedMechanicalClassImplParameterText(
  contractMethod: { parameters: string[]; hasRestParameter: boolean },
  contractName: string,
  methodName: string,
  implementationParameters: { defaultText?: string; name: string; optional: boolean }[],
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
      ? implementationParameters.map((parameter: any) => parameter.name)
      : contractMethod.parameters;
  return `...[${names.join(", ")}]: ${parametersType}`;
}

function getMethodParameterText(context: Rule.RuleContext, element: any) {
  return (
    getClassElementImplementationFunction(element)
      ?.params.map((parameter: any) => context.sourceCode.getText(parameter))
      .join(", ") || ""
  );
}

function getMethodParameterInfo(context: Rule.RuleContext, element: any) {
  return (getClassElementImplementationFunction(element)?.params || []).map((parameter: any) => {
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

function getMethodParameterRange(context: Rule.RuleContext, element: any) {
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

function fixMethodParameters(
  context: Rule.RuleContext,
  element: any,
  expectedParameters: string,
  fixer: Rule.RuleFixer,
) {
  const range = getMethodParameterRange(context, element);
  if (!range) return null;
  return fixer.replaceTextRange([range[0], range[1]], expectedParameters);
}

function getRangeLocation(context: Rule.RuleContext, range: [number, number] | undefined) {
  const start = range?.[0];
  const end = range?.[1];
  if (start === undefined || end === undefined) return undefined;
  if (typeof context.sourceCode.getLocFromIndex !== "function") return undefined;
  return {
    start: context.sourceCode.getLocFromIndex(start),
    end: context.sourceCode.getLocFromIndex(end),
  };
}

function getMethodReturnTypeLocation(context: Rule.RuleContext, element: any) {
  const implementationFunction = getClassElementImplementationFunction(element);
  const returnType = implementationFunction?.returnType || implementationFunction?.typeAnnotation;
  return getRangeLocation(context, returnType?.range);
}

function hasDisallowedMethodReturnType(context: Rule.RuleContext, element: any) {
  const implementationFunction = getClassElementImplementationFunction(element);
  const returnType = implementationFunction?.returnType || implementationFunction?.typeAnnotation;
  if (!returnType) return false;
  return compactTypeText(context.sourceCode.getText(returnType)) !== ":never";
}

function fixMethodReturnType(element: any, fixer: Rule.RuleFixer) {
  const implementationFunction = getClassElementImplementationFunction(element);
  const returnType = implementationFunction?.returnType || implementationFunction?.typeAnnotation;
  if (!returnType?.range) return null;
  return fixer.removeRange(returnType.range);
}

function getPreparedTypeAwareLintFileService(context: Rule.RuleContext) {
  const service = getTypeAwareLintService();
  service.setFileText(context.filename, context.sourceCode.getText());
  return service.getFileService(context.filename);
}

function compactTypeText(text: string) {
  return text.replace(/\s+/g, "");
}

function getPropertyName(node: Node | undefined) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}
