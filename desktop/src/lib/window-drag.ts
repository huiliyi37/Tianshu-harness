/** Interactive chrome that must not start a frameless-window drag. */
export const WINDOW_NO_DRAG_SELECTOR =
  'button, a, input, textarea, select, option, [data-no-drag], [data-tauri-drag-region="false"]'

/**
 * True when a mousedown should call `startDragging()` on a Tauri window.
 *
 * Frameless Windows (`decorations: false`) only move when a
 * `data-tauri-drag-region` is hit. Nested buttons/inputs must be skipped, and
 * `data-tauri-drag-region="false"` is treated as an exclusion — some Tauri
 * versions still match the attribute via `closest()`.
 */
export function isWindowDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest(WINDOW_NO_DRAG_SELECTOR)) return false
  const region = target.closest('[data-tauri-drag-region]')
  if (!(region instanceof Element)) return false
  return region.getAttribute('data-tauri-drag-region') !== 'false'
}

export function startWindowDrag(): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  void import('@tauri-apps/api/window')
    .then((m) => m.getCurrentWindow().startDragging())
    .catch(() => {})
}

export function onWindowDragMouseDown(e: { button: number; target: EventTarget | null }): void {
  if (e.button !== 0) return
  if (!isWindowDragTarget(e.target)) return
  startWindowDrag()
}
