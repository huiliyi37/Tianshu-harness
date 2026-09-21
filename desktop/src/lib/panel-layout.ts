const SIDEBAR_W_KEY = 'rivet:sidebar-w'
const REVIEW_W_KEY = 'rivet:review-w'

export interface PanelLayout {
  sidebar: number
  review: number
}

export interface PanelSizeLike {
  asPercentage: number
  inPixels: number
}

const DEFAULTS: PanelLayout = { sidebar: 16, review: 26 }
const MIN_SIDEBAR = 12
const MAX_SIDEBAR = 35
const MIN_REVIEW = 15
const MAX_REVIEW = 45

/** Pixel floor for a usable expanded sidebar (labels, search, nav). */
export const MIN_SIDEBAR_PX = 200
export const MIN_REVIEW_PX = 180

/** Clamp a panel width to its valid range. */
export function clampSidebar(value: number): number {
  return Math.min(Math.max(value, MIN_SIDEBAR), MAX_SIDEBAR)
}

export function clampReview(value: number): number {
  return Math.min(Math.max(value, MIN_REVIEW), MAX_REVIEW)
}

/**
 * react-resizable-panels v4: numeric `resize(n)` is pixels, not percent.
 * Persisted layout values are percentages (0–100); always pass an explicit `%`.
 */
export function sizeForPanelResize(pct: number): `${number}%` {
  return `${pct}%`
}

/**
 * Decide whether an onResize payload is a real expanded size worth persisting.
 * Skip collapse frames and the 0-width glitch Windows emits on maximize/restore
 * of a frameless window (client area briefly reports 0 before the restore rect).
 */
export function persistablePanelPct(
  size: PanelSizeLike,
  opts: { minPx: number; clamp: (n: number) => number },
): number | null {
  if (!Number.isFinite(size.asPercentage) || !Number.isFinite(size.inPixels)) return null
  if (size.asPercentage <= 0) return null
  if (size.inPixels < opts.minPx) return null
  return opts.clamp(Math.round(size.asPercentage))
}

export function persistableSidebarPct(size: PanelSizeLike): number | null {
  return persistablePanelPct(size, { minPx: MIN_SIDEBAR_PX, clamp: clampSidebar })
}

export function persistableReviewPct(size: PanelSizeLike): number | null {
  return persistablePanelPct(size, { minPx: MIN_REVIEW_PX, clamp: clampReview })
}

/** True when the panel is actually collapsed, not a one-frame chrome glitch. */
export function isCollapsedSize(size: PanelSizeLike): boolean {
  return size.asPercentage <= 0 || size.inPixels <= 0
}

/**
 * Read persisted panel sizes from localStorage, clamping to sane bounds.
 * Ensures the main panel always has at least 30% (matches WorkspaceSurface minSize).
 */
export function loadPanelLayout(): PanelLayout {
  let sidebar = DEFAULTS.sidebar
  let review = DEFAULTS.review
  try {
    sidebar = clampSidebar(parseInt(localStorage.getItem(SIDEBAR_W_KEY) ?? String(DEFAULTS.sidebar), 10))
    review = clampReview(parseInt(localStorage.getItem(REVIEW_W_KEY) ?? String(DEFAULTS.review), 10))
  } catch {
    // ignore corrupted storage
  }
  // Ensure combined width doesn't squeeze main below 30%.
  if (sidebar + review > 70) {
    const excess = sidebar + review - 70
    // Shrink review first (it has more max headroom), then sidebar.
    const shrinkReview = Math.min(excess, review - MIN_REVIEW)
    review -= shrinkReview
    sidebar -= excess - shrinkReview
    sidebar = clampSidebar(sidebar)
  }
  return { sidebar, review }
}

/** Persist a panel size to localStorage. */
export function saveSidebarWidth(value: number): void {
  try {
    localStorage.setItem(SIDEBAR_W_KEY, String(clampSidebar(value)))
  } catch {
    // ignore
  }
}

export function saveReviewWidth(value: number): void {
  try {
    localStorage.setItem(REVIEW_W_KEY, String(clampReview(value)))
  } catch {
    // ignore
  }
}

/** Reset panel sizes to defaults. */
export function resetPanelLayout(): PanelLayout {
  try {
    localStorage.removeItem(SIDEBAR_W_KEY)
    localStorage.removeItem(REVIEW_W_KEY)
  } catch {
    // ignore
  }
  return { ...DEFAULTS }
}
