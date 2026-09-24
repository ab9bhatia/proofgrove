/**
 * Page sizes, in one place.
 *
 * These were nine separate constants across nine files, three of them just named
 * `PAGE_SIZE`, so "how much does a page hold here?" could only be answered by
 * opening the file. They are not all the same number on purpose — a row of
 * findings is not a row of trace spans — but they should be chosen together.
 */

/** Dense rows a reader scans: keep a page inside one screen. */
export const ROWS_PER_PAGE = 20;

/** Long technical lists where scrolling beats paging. */
export const LONG_LIST_PER_PAGE = 50;

/** Cards, which are far taller than a row. */
export const CARDS_PER_PAGE = 6;

/** Findings, each of which is read and decided on individually. */
export const FINDINGS_PER_PAGE = 8;
