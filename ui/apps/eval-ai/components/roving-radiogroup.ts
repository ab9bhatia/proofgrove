import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export function rovingRadioTabIndex(selected: boolean): 0 | -1 {
  return selected ? 0 : -1;
}

/**
 * Which option owns the group's single tab stop. The selected option keeps it,
 * unless it is disabled or unknown — then the first enabled option takes over so
 * a group with an unavailable selection never drops out of the tab order.
 */
export function rovingRadioTabStop(options: {
  values: readonly string[];
  current: string;
  disabled?: (value: string) => boolean;
}): string | null {
  const { values, current, disabled } = options;
  if (values.includes(current) && !disabled?.(current)) return current;
  return values.find((value) => !disabled?.(value)) ?? null;
}

/**
 * Arrow/Home/End keyboard handling for hand-rolled roving-tabindex widgets
 * (radiogroups by default, tablists via `groupSelector`/`itemSelector`).
 * Moves selection among enabled values and focuses the newly selected control.
 * Both axes are accepted in either direction, as ARIA allows for a radiogroup with no
 * declared orientation — every group using this renders as one row or one grid.
 */
export function handleRovingRadioKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  options: {
    values: readonly string[];
    current: string;
    disabled?: (value: string) => boolean;
    onSelect: (value: string) => void;
    /** Container the newly selected control is looked up inside. */
    groupSelector?: string;
    /** Selector for the control owning `value`, relative to the container. */
    itemSelector?: (value: string) => string;
  },
): void {
  const {
    values,
    current,
    disabled,
    onSelect,
    groupSelector = '[role="radiogroup"]',
    itemSelector = (value: string) => `[role="radio"][data-radio-value="${CSS.escape(value)}"]`,
  } = options;
  const enabled = values.filter((value) => !disabled?.(value));
  if (enabled.length === 0) return;

  const currentIndex = Math.max(0, enabled.indexOf(current));
  let nextIndex: number;
  const key = event.key;

  if (key === "Home") {
    nextIndex = 0;
  } else if (key === "End") {
    nextIndex = enabled.length - 1;
  } else if (key === "ArrowRight" || key === "ArrowDown") {
    nextIndex = (currentIndex + 1) % enabled.length;
  } else if (key === "ArrowLeft" || key === "ArrowUp") {
    nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
  } else {
    return;
  }

  event.preventDefault();
  const next = enabled[nextIndex]!;
  onSelect(next);

  const root = event.currentTarget.closest(groupSelector);
  const target = root?.querySelector<HTMLElement>(itemSelector(next));
  target?.focus();
}
