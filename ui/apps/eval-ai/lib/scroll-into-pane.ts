/**
 * Scroll an element into view inside the workspace pane, and nowhere else.
 *
 * `Element.scrollIntoView` walks up and scrolls *every* scrollable ancestor,
 * including the document. `overflow: hidden` does not prevent that — it stops the
 * user scrolling, not the program — so a call meant for the pane could shift the
 * whole fixed-height shell out of view and leave the user staring at bare
 * background with no way to scroll back.
 *
 * Scrolling the pane by hand keeps the effect where it belongs. Falls back to the
 * native call when the element is not inside a pane (dialogs, tests, SSR).
 */
export function scrollIntoPane(
  element: Element | null | undefined,
  options: { behavior?: ScrollBehavior; block?: "start" | "center" } = {},
): void {
  if (!(element instanceof HTMLElement)) return;
  const { behavior = "auto", block = "start" } = options;
  const pane = element.closest<HTMLElement>(".proofgrove-workspace-scroll");
  if (!pane) {
    element.scrollIntoView({ behavior, block });
    return;
  }

  // Honour what the native call would have honoured. Sections carry `scroll-mt-*`
  // so a heading does not land flush against the top of the pane, and the pane
  // itself sets scroll-padding to keep a target clear of the sticky run bar —
  // hand-rolled offset maths silently threw both away.
  const rect = element.getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();
  const elementStyle = getComputedStyle(element);
  const paneStyle = getComputedStyle(pane);
  const scrollMarginTop = Number.parseFloat(elementStyle.scrollMarginTop) || 0;
  const scrollPaddingTop = Number.parseFloat(paneStyle.scrollPaddingTop) || 0;
  const scrollPaddingBottom = Number.parseFloat(paneStyle.scrollPaddingBottom) || 0;

  const offset = rect.top - paneRect.top + pane.scrollTop;
  const top = block === "center"
    ? offset - (pane.clientHeight - scrollPaddingTop - scrollPaddingBottom) / 2 + rect.height / 2
    : offset - scrollMarginTop - scrollPaddingTop;
  pane.scrollTo({ top: Math.max(0, top), behavior });
}
