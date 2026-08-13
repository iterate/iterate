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
          // the actual scroller INSIDE its shadow root today, so search
          // descendants first (crossing shadow boundaries); fall back to the
          // tree's ancestor chain (crossing host boundaries) in case a
          // future pierre scrolls at the host instead.
          await tree.evaluate((node) => {
            const scrolls = (el: HTMLElement) => {
              if (el.scrollHeight <= el.clientHeight + 2) return false;
              const overflowY = getComputedStyle(el).overflowY;
              return overflowY === "auto" || overflowY === "scroll";
            };
            const findScroller = (root: ParentNode): HTMLElement | null => {
              for (const child of root.querySelectorAll("*")) {
                const el = child as HTMLElement;
                if (scrolls(el)) return el;
                const inner = el.shadowRoot === null ? null : findScroller(el.shadowRoot);
                if (inner !== null) return inner;
              }
              return null;
            };
            const findAncestorScroller = (start: Element): HTMLElement | null => {
              let el: Element | null = start;
              while (el !== null) {
                if (el instanceof HTMLElement && scrolls(el)) return el;
                el =
                  el.parentElement ??
                  (el.getRootNode() as ShadowRoot | (Document & { host?: Element })).host ??
                  null;
              }
              return null;
            };
            const scroller =
              findScroller(node) ??
              findScroller(node.getRootNode() as ShadowRoot | Document) ??
              findAncestorScroller(node);
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
      {
        message: `open repo tree file: ${path}`,
        // timeout: expect.poll's own budget — polling sits outside locator actions, so no spinner-waiter applies
        timeout: 30_000,
      },
    )
    .toBe("selected");
}
