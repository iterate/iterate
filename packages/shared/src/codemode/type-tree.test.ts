/**
 * Tests for the declaration tree used to emit nested TypeScript ambient declarations.
 *
 * Adapted from @cloudflare/codemode (cloudflare/agents):
 * https://github.com/cloudflare/agents/blob/main/packages/codemode/src/type-tree.ts
 */

import { describe, it, expect } from "vitest";
import {
  createDeclTree,
  countDeclNodes,
  insertDecl,
  insertDeclTree,
  emitDeclTree,
} from "./type-tree.ts";

describe("createDeclTree", () => {
  it("returns a node with no self and an empty children map", () => {
    const tree = createDeclTree();
    expect(tree.self).toBeUndefined();
    expect(tree.children.size).toBe(0);
  });
});

describe("countDeclNodes", () => {
  it("returns 0 for an empty tree", () => {
    expect(countDeclNodes(createDeclTree())).toBe(0);
  });

  it("counts a single leaf node", () => {
    const tree = createDeclTree();
    insertDecl(tree, ["foo"], "leaf");
    expect(countDeclNodes(tree)).toBe(1);
  });

  it("counts nested nodes", () => {
    const tree = createDeclTree();
    insertDecl(tree, ["a", "b"], "leaf");
    // "a" has no self but has a child, so it counts as 1
    // "b" has self, so it counts as 1
    expect(countDeclNodes(tree)).toBe(2);
  });

  it("counts multiple siblings", () => {
    const tree = createDeclTree();
    insertDecl(tree, ["a"], "leaf-a");
    insertDecl(tree, ["b"], "leaf-b");
    expect(countDeclNodes(tree)).toBe(2);
  });

  it("skips children with no self and no children of their own", () => {
    const tree = createDeclTree();
    // Manually add an empty child
    tree.children.set("empty", { children: new Map() });
    expect(countDeclNodes(tree)).toBe(0);
  });
});

describe("insertDecl", () => {
  it("inserts a leaf at a single-segment path", () => {
    const tree = createDeclTree();
    insertDecl(tree, ["tool"], "decl-text");
    const child = tree.children.get("tool");
    expect(child).toBeDefined();
    expect(child!.self).toBe("decl-text");
    expect(child!.children.size).toBe(0);
  });

  it("inserts a leaf at a multi-segment path", () => {
    const tree = createDeclTree();
    insertDecl(tree, ["a", "b", "c"], "deep-leaf");

    const a = tree.children.get("a");
    expect(a).toBeDefined();
    expect(a!.self).toBeUndefined();

    const b = a!.children.get("b");
    expect(b).toBeDefined();
    expect(b!.self).toBeUndefined();

    const c = b!.children.get("c");
    expect(c).toBeDefined();
    expect(c!.self).toBe("deep-leaf");
  });

  it("preserves existing siblings when inserting", () => {
    const tree = createDeclTree();
    insertDecl(tree, ["a", "x"], "leaf-x");
    insertDecl(tree, ["a", "y"], "leaf-y");

    const a = tree.children.get("a")!;
    expect(a.children.size).toBe(2);
    expect(a.children.get("x")!.self).toBe("leaf-x");
    expect(a.children.get("y")!.self).toBe("leaf-y");
  });

  it("overwrites an existing leaf at the same path", () => {
    const tree = createDeclTree();
    insertDecl(tree, ["tool"], "old-decl");
    insertDecl(tree, ["tool"], "new-decl");
    expect(tree.children.get("tool")!.self).toBe("new-decl");
  });
});

describe("insertDeclTree", () => {
  it("merges a subtree at an empty path (root merge)", () => {
    const target = createDeclTree();
    const source = createDeclTree();
    insertDecl(source, ["tool"], "leaf");

    insertDeclTree(target, [], source);
    expect(target.children.get("tool")!.self).toBe("leaf");
  });

  it("merges a subtree at a nested path", () => {
    const target = createDeclTree();
    const source = createDeclTree();
    insertDecl(source, ["doIt"], "leaf");

    insertDeclTree(target, ["ns", "sub"], source);

    const ns = target.children.get("ns")!;
    const sub = ns.children.get("sub")!;
    expect(sub.children.get("doIt")!.self).toBe("leaf");
  });

  it("does not insert anything when the source tree is empty", () => {
    const target = createDeclTree();
    const source = createDeclTree();

    insertDeclTree(target, ["ns"], source);
    // "ns" should not be created because source has nothing
    expect(target.children.size).toBe(0);
  });

  it("copies self from source when merging at root", () => {
    const target = createDeclTree();
    const source = createDeclTree();
    source.self = "root-decl";

    insertDeclTree(target, [], source);
    expect(target.self).toBe("root-decl");
  });
});

describe("emitDeclTree", () => {
  it("emits a single leaf using the __PROP__ placeholder", () => {
    const tree = createDeclTree();
    insertDecl(tree, ["myTool"], "\t/**\n\t * Does stuff\n\t */\n\t__PROP__: () => void;");

    const result = emitDeclTree(tree);
    expect(result).toContain("myTool: () => void;");
    expect(result).toContain("* Does stuff");
    expect(result).not.toContain("__PROP__");
  });

  it("emits nested namespaces", () => {
    const tree = createDeclTree();
    insertDecl(tree, ["ns", "tool"], "\t__PROP__: () => void;");

    const result = emitDeclTree(tree);
    expect(result).toContain("\tns: {");
    expect(result).toContain("\t\ttool: () => void;");
    expect(result).toContain("\t};");
  });

  it("emits $call when a node has both self and children", () => {
    const tree = createDeclTree();
    insertDecl(tree, ["files"], "\t__PROP__: (input: FilesInput) => Promise<FilesOutput>;");
    insertDecl(
      tree,
      ["files", "read"],
      "\t__PROP__: (input: FilesReadInput) => Promise<FilesReadOutput>;",
    );

    const result = emitDeclTree(tree);
    expect(result).toContain("$call: (input: FilesInput) => Promise<FilesOutput>;");
    expect(result).toContain("read: (input: FilesReadInput) => Promise<FilesReadOutput>;");
  });

  it("returns empty string for an empty tree", () => {
    const tree = createDeclTree();
    expect(emitDeclTree(tree)).toBe("");
  });

  it("quotes non-identifier property names", () => {
    const tree = createDeclTree();
    insertDecl(tree, ["get-item"], "\t__PROP__: () => void;");

    const result = emitDeclTree(tree);
    expect(result).toContain('"get-item"');
  });

  it("respects the indent parameter", () => {
    const tree = createDeclTree();
    insertDecl(tree, ["tool"], "\t__PROP__: () => void;");

    const result = emitDeclTree(tree, "\t\t");
    expect(result).toContain("\t\ttool: () => void;");
  });
});
