import { expect, type Page } from "@playwright/test";

/**
 * Open a file from the repo IDE's pierre tree by its exact path. Two things
 * make a bare locator click unreliable now that the seeded template holds a
 * couple of app trees: the tree VIRTUALIZES (a row far enough down is not in
 * the DOM at all until its viewport scrolls), and the scroll a click performs
 * re-renders rows mid-gesture, so a neighbouring row can take the hit. Poll
 * the whole gesture instead: materialize the row by paging the tree's
 * scroller, click, and verify the selection actually landed on the requested
 * row — repeating until it did.
 */
export async function openRepoTreeFile(page: Page, path: string) {
  const tree = page.getByRole("tree");
  await tree.waitFor();
  const row = page.locator(`[data-item-path="${path}"]`);
  await expect
    .poll(
      async () => {
        if ((await row.count()) === 0) {
          // Page the tree's virtualized viewport one screen down — wrapping
          // back to the top at the end — until the row exists. Pierre keeps
          // the actual scroller INSIDE its shadow root, so search
          // descendants (crossing shadow boundaries), not ancestors.
          await tree.evaluate((node) => {
            const findScroller = (root: ParentNode): HTMLElement | null => {
              for (const child of root.querySelectorAll("*")) {
                const el = child as HTMLElement;
                if (el.scrollHeight > el.clientHeight + 2) {
                  const overflowY = getComputedStyle(el).overflowY;
                  if (overflowY === "auto" || overflowY === "scroll") return el;
                }
                const inner = el.shadowRoot === null ? null : findScroller(el.shadowRoot);
                if (inner !== null) return inner;
              }
              return null;
            };
            const scroller =
              findScroller(node) ?? findScroller(node.getRootNode() as ShadowRoot | Document);
            if (scroller !== null) {
              const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
              scroller.scrollTop = atEnd ? 0 : scroller.scrollTop + scroller.clientHeight;
            }
          });
          return "row not rendered yet";
        }
        await row.scrollIntoViewIfNeeded();
        await row.click();
        return (await row.getAttribute("aria-selected")) === "true" ? "selected" : "not selected";
      },
      { message: `open repo tree file: ${path}`, timeout: 30_000 },
    )
    .toBe("selected");
}
