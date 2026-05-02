import * as React from 'react';

const LIST_ITEM_ATTR = 'data-list-item';

/**
 * Wire up `j`/`k` (vim-style) keyboard navigation across a list of focusable
 * elements that share a common attribute marker. Items must render with
 * `data-list-item="true"` (or any non-empty value).
 *
 * Why a hook rather than a global handler: each screen has its own list and
 * the items live deep in nested components, so passing refs around is
 * awkward. We attach a single `keydown` listener scoped to the document but
 * gate it on visibility (`enabled` + presence of items in the DOM at the
 * time of the keypress).
 *
 * Pressing `j` from anywhere outside a text field focuses the first item if
 * none is focused, or advances to the next; `k` goes back. `Enter` is
 * intentionally NOT intercepted — focused buttons handle it natively.
 */
export function useListKeyboardNav(enabled: boolean = true): void {
  React.useEffect(() => {
    if (!enabled) return;

    function isInsideEditableField(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    }

    function items(): HTMLElement[] {
      return Array.from(
        document.querySelectorAll<HTMLElement>(`[${LIST_ITEM_ATTR}]`),
      ).filter((el) => !el.hidden && el.offsetParent !== null);
    }

    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      if (isInsideEditableField(e.target)) return;
      const list = items();
      if (list.length === 0) return;
      e.preventDefault();
      const active = document.activeElement;
      let idx = -1;
      if (active instanceof HTMLElement) {
        idx = list.indexOf(active);
      }
      if (idx === -1) {
        list[0]!.focus();
        list[0]!.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const next = e.key === 'j' ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1);
      const target = list[next]!;
      target.focus();
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** Spread onto a focusable list element so `useListKeyboardNav` can find it. */
export const listItemProps = { [LIST_ITEM_ATTR]: 'true' } as const;
