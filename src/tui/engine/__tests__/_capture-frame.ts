import { stripVTControlCharacters } from 'node:util'
import type { TuiApp } from '../app.js'
import type { LiveEngine, LiveRegionLine } from '../live-engine.js'

export interface CapturedLiveFrame {
  current(): readonly LiveRegionLine[]
  lines(): string[]
  text(): string
}

/** Observe complete frames while retaining the real terminal renderer and its diff path. */
export function captureLiveFrame(app: TuiApp): CapturedLiveFrame {
  const live = (app as unknown as { live: LiveEngine }).live
  const render = live.render.bind(live)
  let current: LiveRegionLine[] = []
  live.render = (lines, options) => {
    current = lines.map(line => ({ ...line }))
    render(lines, options)
  }
  const plainLines = () => current.flatMap(line => stripVTControlCharacters(line.text).split('\n'))
  return { current: () => current, lines: plainLines, text: () => plainLines().join('\n') }
}
