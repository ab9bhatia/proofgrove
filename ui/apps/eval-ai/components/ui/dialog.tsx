"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@evalai/shared/utils";

/**
 * Every element the dialog focus trap can land on. Kept as a single exported
 * constant so the trap, and any consumer that needs to reason about focus
 * order, share one definition.
 */
export const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export type DialogKeyAction =
  | { type: "close" }
  | { type: "focus"; index: number }
  | { type: "none" }
  /** Trap: prevent the default Tab action, keep focus on the panel. */
  | { type: "trap" };

/**
 * Pure keyboard contract for a modal dialog. Given the pressed key, the index
 * of the currently focused element within the dialog's focusable list (`-1`
 * when focus is outside the panel), and the number of focusable elements,
 * returns what the dialog must do:
 *
 * - `Escape` always closes.
 * - `Tab` on the last element wraps to the first; `Shift+Tab` on the first
 *   wraps to the last.
 * - `Tab` while focus has escaped the panel pulls it back inside (first
 *   element, or last for `Shift+Tab`) so the trap cannot be walked out of.
 * - Everything else is left to the browser.
 */
export function dialogKeyAction(
  key: string,
  shiftKey: boolean,
  activeIndex: number,
  focusableCount: number,
): DialogKeyAction {
  if (key === "Escape") return { type: "close" };
  if (key !== "Tab") return { type: "none" };
  // Zero focusable descendants: swallow Tab so browser focus cannot leave the
  // modal panel for background controls.
  if (focusableCount === 0) return { type: "trap" };
  if (activeIndex === -1) {
    return { type: "focus", index: shiftKey ? focusableCount - 1 : 0 };
  }
  if (shiftKey && activeIndex === 0) {
    return { type: "focus", index: focusableCount - 1 };
  }
  if (!shiftKey && activeIndex === focusableCount - 1) {
    return { type: "focus", index: 0 };
  }
  return { type: "none" };
}

/**
 * True when `el` (and every ancestor up to and including `panel`) is not
 * `display: none` or `[hidden]`. `offsetParent` can't be used here — jsdom
 * (and any layout-less test runner) always reports it as `null`, and the
 * property doesn't exist to check yet in every supported browser either —
 * so the trap walks the ancestor chain's own styling directly instead of
 * relying on computed layout.
 */
function isReachable(el: HTMLElement, panel: HTMLElement): boolean {
  let node: HTMLElement | null = el;
  while (node) {
    if (node.hidden || getComputedStyle(node).display === "none") return false;
    if (node === panel) return true;
    node = node.parentElement;
  }
  return true;
}

const openPanels: HTMLElement[] = [];

/**
 * Locks scrolling on the element whose style is passed (the document body in
 * practice) and returns the undo function. All overlapping callers must pass
 * the same document body style; the lock count is shared within this module.
 */
let scrollLockCount = 0;
let scrollLockOriginal = "";

export function lockBodyScroll(style: { overflow: string }): () => void {
  // Reference-counted: overlapping dialogs may lock/unlock out of order; the
  // original overflow value is restored only when the LAST lock releases, so
  // an unmount race can neither unlock a still-open dialog nor leave
  // overflow: hidden behind after all dialogs close.
  if (scrollLockCount === 0) scrollLockOriginal = style.overflow;
  scrollLockCount += 1;
  style.overflow = "hidden";
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLockCount = Math.max(0, scrollLockCount - 1);
    if (scrollLockCount === 0) style.overflow = scrollLockOriginal;
  };
}

const dialogOverlayVariants = cva("fixed inset-0 z-50", {
  variants: {
    variant: {
      modal: "flex items-center justify-center p-4",
      drawer: "",
    },
  },
  defaultVariants: { variant: "modal" },
});

const dialogScrimVariants = cva("absolute inset-0 h-full w-full cursor-default", {
  variants: {
    variant: {
      modal: "bg-black/40 backdrop-blur-sm",
      drawer: "bg-black/35 backdrop-blur-[1px]",
    },
  },
  defaultVariants: { variant: "modal" },
});

const dialogPanelVariants = cva(
  "flex flex-col overscroll-contain bg-background shadow-2xl outline-none motion-reduce:animate-none motion-reduce:transition-none",
  {
    variants: {
      variant: {
        modal:
          "relative max-h-[min(760px,90vh)] w-full overflow-hidden rounded-2xl border",
        drawer:
          "animate-in slide-in-from-right absolute inset-y-0 right-0 w-full border-l duration-200",
      },
    },
    defaultVariants: { variant: "modal" },
  },
);

export interface DialogProps extends VariantProps<typeof dialogPanelVariants> {
  /** id of the element that titles the dialog (`aria-labelledby`). */
  labelledBy: string;
  /** id of optional supporting text (`aria-describedby`). */
  describedBy?: string;
  /** Close request: Escape key or a click on the scrim. */
  onClose: () => void;
  /** Accessible label for the scrim close button. */
  scrimLabel: string;
  /**
   * Width classes for the panel — e.g. `"sm:w-[92vw] xl:w-[820px]"` for a
   * drawer or `"w-[min(64rem,calc(100vw-2rem))]"` for a modal.
   */
  width?: string;
  /** Extra classes merged onto the panel. */
  className?: string;
  /** Extra classes merged onto the scrim. */
  scrimClassName?: string;
  /** Extra classes merged onto the fixed overlay container. */
  overlayClassName?: string;
  /** Element rendered as the dialog panel. Defaults to `div`. */
  as?: "div" | "aside";
  /**
   * Element focused when the dialog opens. Falls back to the panel itself,
   * which carries `tabIndex={-1}` for that purpose.
   */
  initialFocusRef?: { readonly current: HTMLElement | null };
  children: ReactNode;
}

/**
 * Dialog used by Proofgrove overlay surfaces.
 *
 * Renders through a portal on the client (inline during server rendering, so
 * static-markup tests still see the dialog), locks body scroll while open,
 * traps Tab focus inside the panel, closes on Escape or a scrim click, and
 * restores focus to the previously focused element on unmount.
 * Only Dialog instances share the topmost Escape guard. Migrate legacy
 * document-level Escape handlers before nesting them with this component.
 *
 * Variants: `"modal"` centers the panel; `"drawer"` slides it in as a
 * right-hand sheet whose width comes from the `width` prop.
 */
export function Dialog({
  variant = "modal",
  labelledBy,
  describedBy,
  onClose,
  scrimLabel,
  width,
  className,
  scrimClassName,
  overlayClassName,
  as = "div",
  initialFocusRef,
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const initialFocusRefRef = useRef(initialFocusRef);
  useEffect(() => {
    initialFocusRefRef.current = initialFocusRef;
  }, [initialFocusRef]);

  // Mount-only: lock scroll, move focus in, trap Tab, close on Escape, and
  // restore both scroll and focus when the dialog unmounts.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unlock = lockBodyScroll(document.body.style);
    openPanels.push(panel);
    (initialFocusRefRef.current?.current ?? panel).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (openPanels.at(-1) !== panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
      ).filter((candidate) => isReachable(candidate, panel));
      const activeIndex =
        document.activeElement instanceof HTMLElement
          ? focusable.indexOf(document.activeElement)
          : -1;
      const action = dialogKeyAction(
        event.key,
        event.shiftKey,
        activeIndex,
        focusable.length,
      );
      if (action.type === "close") {
        event.preventDefault();
        onCloseRef.current();
      } else if (action.type === "focus") {
        event.preventDefault();
        focusable[action.index]?.focus();
      } else if (action.type === "trap") {
        event.preventDefault();
        panelRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const wasTopmost = openPanels.at(-1) === panel;
      openPanels.splice(openPanels.indexOf(panel), 1);
      unlock();
      if (wasTopmost && previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const setPanelRef = (node: HTMLElement | null) => {
    panelRef.current = node;
  };
  const panelProps = {
    role: "dialog",
    "aria-modal": true,
    "aria-labelledby": labelledBy,
    "aria-describedby": describedBy,
    tabIndex: -1,
    className: cn(dialogPanelVariants({ variant }), width, className),
  } as const;

  const overlay = (
    <div className={cn(dialogOverlayVariants({ variant }), overlayClassName)}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={scrimLabel}
        onClick={onClose}
        className={cn(dialogScrimVariants({ variant }), scrimClassName)}
      />
      {as === "aside" ? (
        <aside ref={setPanelRef} {...panelProps}>
          {children}
        </aside>
      ) : (
        <div ref={setPanelRef} {...panelProps}>
          {children}
        </div>
      )}
    </div>
  );

  // Server rendering (and node-env static-markup tests) has no document to
  // portal into; the overlay is position:fixed, so inline rendering is
  // visually identical.
  if (typeof document === "undefined") return overlay;
  return createPortal(overlay, document.body);
}
