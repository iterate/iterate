type CodemodeProcedureLike = {
  rpcToolName: string;
  runtimePath: string[];
  kind: string;
};

type ProcedureTreeNode = {
  children: Map<string, ProcedureTreeNode>;
  rpcToolName?: string;
};

export function buildCtxTreeExpressions<TProcedure extends CodemodeProcedureLike>(
  procedures: TProcedure[],
  providerName: string,
) {
  const procedureByToolName = new Map(
    procedures.map((procedure) => [procedure.rpcToolName, procedure] as const),
  );
  const root: ProcedureTreeNode = {
    children: new Map(),
  };

  for (const procedure of procedures) {
    let current = root;

    for (const segment of procedure.runtimePath) {
      let child = current.children.get(segment);
      if (!child) {
        child = {
          children: new Map(),
        };
        current.children.set(segment, child);
      }

      current = child;
    }

    current.rpcToolName = procedure.rpcToolName;
  }

  const emitRuntimeTree = (node: ProcedureTreeNode): string => {
    const entries: string[] = [];

    for (const [segment, child] of node.children) {
      if (child.rpcToolName) {
        const procedure = procedureByToolName.get(child.rpcToolName);
        const rootProviderName =
          procedure?.kind === "stream" ? `${providerName}_stream` : providerName;
        entries.push(
          `${JSON.stringify(segment)}: (input) => ${rootProviderName}.${child.rpcToolName}(input ?? {})`,
        );
        continue;
      }

      entries.push(`${JSON.stringify(segment)}: ${emitRuntimeTree(child)}`);
    }

    return `{ ${entries.join(", ")} }`;
  };

  const emitTypeTree = (node: ProcedureTreeNode): string => {
    const lines: string[] = ["{"];

    for (const [segment, child] of node.children) {
      if (child.rpcToolName) {
        const procedure = procedureByToolName.get(child.rpcToolName);
        const rootProviderName =
          procedure?.kind === "stream" ? `${providerName}_stream` : providerName;
        lines.push(
          `  ${JSON.stringify(segment)}: typeof ${rootProviderName}.${child.rpcToolName};`,
        );
        continue;
      }

      const nested = emitTypeTree(child)
        .split("\n")
        .map((line, index) => (index === 0 ? line : `  ${line}`))
        .join("\n");
      lines.push(`  ${JSON.stringify(segment)}: ${nested};`);
    }

    lines.push("}");
    return lines.join("\n");
  };

  return {
    ctxExpression: emitRuntimeTree(root),
    ctxTypeExpression: emitTypeTree(root),
  };
}
