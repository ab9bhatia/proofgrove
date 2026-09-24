/**
 * The page's horizontal frame.
 *
 * One width, deliberately — 1180, not the widest value in the old set. Unifying
 * on 1320 lined the pages up but pushed content out toward the edges and took the
 * side space off every page that had been narrower. Wide tables scroll inside
 * their own container, so they lose nothing that matters.
 * Seven were in use, and narrowing that to two still left
 * pages starting at two different left edges — a centred 1180px container and a
 * centred 1320px one inset by different amounts on the same screen, which is
 * exactly what reads as inconsistent when you move between them. Content that
 * needs less room constrains itself inside the frame; the frame itself does not
 * move.
 */
export const PAGE_FRAME = "mx-auto max-w-[1180px] px-4 py-8 sm:px-6";

/**
 * A column header row on a list that is laid out with a grid rather than a table.
 *
 * Four such lists each wrote their own: one `font-medium` with no casing, one
 * `uppercase tracking-wide`, one `uppercase tracking-[0.08em]`. Side by side the
 * Datasets columns read as sentence case while Agents shouted, for no reason a
 * reader could infer. This matches what `app/globals.css` already applies to a
 * real `thead`, so a grid list and a table list name their columns identically.
 */
export const COLUMN_HEADER =
  "border-b bg-muted/30 px-5 py-2.5 text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-muted-foreground";
