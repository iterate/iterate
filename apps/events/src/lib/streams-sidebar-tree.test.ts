import { describe, expect, test } from "vitest";
import { StreamPath } from "@iterate-com/events-contract";
import { getStreamsSidebarState } from "./streams-sidebar-tree.ts";

describe("getStreamsSidebarState", () => {
  test("keeps root streams as siblings and materializes missing ancestors", () => {
    expect(
      getStreamsSidebarState({
        streamPaths: [
          StreamPath.parse("/1/2/3/4/5"),
          StreamPath.parse("/jonastemplestein/hello-world"),
          StreamPath.parse("/hello-world"),
          StreamPath.parse("/jonas/proofs/proof-1775346973863"),
          StreamPath.parse("/someone-else/proofs/proof-1775346973863"),
        ],
        currentStreamPath: StreamPath.parse("/jonas/proofs/proof-1775346973863"),
      }),
    ).toEqual({
      root: {
        path: "/",
        children: [
          {
            path: "/1",
            children: [
              {
                path: "/1/2",
                children: [
                  {
                    path: "/1/2/3",
                    children: [
                      {
                        path: "/1/2/3/4",
                        children: [{ path: "/1/2/3/4/5", children: [] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          { path: "/hello-world", children: [] },
          {
            path: "/jonas",
            children: [
              {
                path: "/jonas/proofs",
                children: [{ path: "/jonas/proofs/proof-1775346973863", children: [] }],
              },
            ],
          },
          {
            path: "/jonastemplestein",
            children: [{ path: "/jonastemplestein/hello-world", children: [] }],
          },
          {
            path: "/someone-else",
            children: [
              {
                path: "/someone-else/proofs",
                children: [{ path: "/someone-else/proofs/proof-1775346973863", children: [] }],
              },
            ],
          },
        ],
      },
      defaultExpandedPaths: ["/", "/jonas", "/jonas/proofs", "/jonas/proofs/proof-1775346973863"],
    });
  });

  test("defaults to only the root stream when there is no selected path", () => {
    expect(
      getStreamsSidebarState({
        streamPaths: [StreamPath.parse("/jonas/proofs/proof-1775346973863/a")],
        currentStreamPath: null,
      }),
    ).toEqual({
      root: {
        path: "/",
        children: [
          {
            path: "/jonas",
            children: [
              {
                path: "/jonas/proofs",
                children: [
                  {
                    path: "/jonas/proofs/proof-1775346973863",
                    children: [{ path: "/jonas/proofs/proof-1775346973863/a", children: [] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      defaultExpandedPaths: ["/"],
    });
  });
});
