import type { OverlayNavState } from './overlay-controller.js'
import type { PagerData } from '../format/overlay.js'
import { ANSI_SEQ_RE } from './ansi.js'

interface PagerContext { nav: OverlayNavState; data: PagerData; rows: number; rerender: () => void; preview: boolean }
const searchOrigins = new WeakMap<OverlayNavState, { mode: 'page' | 'message'; offset: number; selected: number }>()

/** Reflow the suspended reading position together with the visible document. */
export function remapPagerOffsets(nav: OverlayNavState, map: (offset: number) => number): void {
  if (nav.pagerLineOffset !== undefined) nav.pagerLineOffset = map(nav.pagerLineOffset)
  if (nav.pagerBeforeSearch !== undefined) nav.pagerBeforeSearch = map(nav.pagerBeforeSearch)
  const origin = searchOrigins.get(nav)
  if (origin) origin.offset = map(origin.offset)
}

export function pagerSearchLines(content: string, query: string): number[] {
  return query ? content.split('\n').flatMap((line, i) => line.replace(ANSI_SEQ_RE, '').toLowerCase().includes(query.toLowerCase()) ? [i] : []) : []
}

/** One focus owner for the legacy plan/job/worker text pager. */
export function handlePagerKey(key: {name:string;char:string;ctrl?:boolean;meta?:boolean}, ctx: PagerContext): boolean {
  const { nav, data } = ctx
  const lines = data.content.split('\n')
  const messages = data.messages ?? []
  const size = Math.max(1, ctx.rows - 4)
  let offset = nav.pagerLineOffset ?? nav.pagerPage * size
  const currentMessage = (): number => messages.reduce((selected, message, index) => message.startLine <= offset ? index : selected, 0)
  const selectMessage = (index: number): void => {
    nav.pagerSelectedMessage = Math.max(0, Math.min(messages.length - 1, index))
    offset = messages[nav.pagerSelectedMessage]?.startLine ?? 0
  }
  const messageEnd = (index: number, visible: number): number => {
    const message = messages[index]
    return message ? message.startLine + Math.max(0, message.lines.length - visible) : Math.max(0, lines.length - visible)
  }
  const matches = (): number[] => data.searchRows?.(nav.pagerSearchQuery) ?? pagerSearchLines(data.content, nav.pagerSearchQuery)
  const jump = (delta: number): void => {
    const hits = matches()
    nav.pagerSearchCurrent = hits.length ? ((nav.pagerSearchCurrent - 1 + delta + hits.length) % hits.length) + 1 : 0
    offset = hits[nav.pagerSearchCurrent - 1] ?? offset
  }
  if (nav.pagerMode === 'search') {
    if (key.name === 'escape') nav.pagerMode = 'results'
    else if (key.name === 'return') { nav.pagerMode = 'results'; nav.pagerSearchCurrent = 0; jump(1) }
    else if (key.name === 'backspace') { nav.pagerSearchQuery = Array.from(nav.pagerSearchQuery).slice(0, -1).join(''); nav.pagerSearchCurrent = 0 }
    else if (!key.ctrl && !key.meta && key.char) { nav.pagerSearchQuery += key.char; nav.pagerSearchCurrent = 0 }
    else return true
  } else if (nav.pagerMode === 'results') {
    if (key.name === 'escape') {
      const origin = searchOrigins.get(nav)
      nav.pagerMode = origin?.mode ?? 'page'; offset = origin?.offset ?? nav.pagerBeforeSearch ?? 0
      nav.pagerSelectedMessage = origin?.selected ?? nav.pagerSelectedMessage
      nav.pagerSearchQuery = ''; nav.pagerSearchCurrent = 0; searchOrigins.delete(nav)
    }
    else if (key.char === 'n' || key.name === 'down') jump(1)
    else if (key.char === 'N' || key.name === 'up') jump(-1)
    else if (key.char === '/') nav.pagerMode = 'search'
    else return false
  } else if (key.char === '/') {
    searchOrigins.set(nav, { mode: nav.pagerMode === 'message' ? 'message' : 'page', offset, selected: nav.pagerSelectedMessage })
    nav.pagerBeforeSearch = offset; nav.pagerMode = 'search'; nav.pagerSearchQuery = ''; nav.pagerSearchCurrent = 0
  } else if (key.char === 'v' && !ctx.preview) {
    nav.pagerVerbose = !nav.pagerVerbose; offset = 0
  } else if (key.name === 'down' || key.char === 'j') {
    if (nav.pagerMode === 'message' && messages.length) selectMessage(nav.pagerSelectedMessage + 1)
    else offset++
  } else if (key.name === 'up' || key.char === 'k') {
    if (nav.pagerMode === 'message' && messages.length) selectMessage(nav.pagerSelectedMessage - 1)
    else offset--
  }
  else if (key.name === 'pagedown') offset += Math.max(1, Math.floor(size / 2))
  else if (key.name === 'pageup') offset -= Math.max(1, Math.floor(size / 2))
  else if (key.name === 'home' || key.name === 'end') {
    if (nav.pagerMode === 'message' && messages.length) {
      if (key.ctrl) selectMessage(key.name === 'home' ? 0 : messages.length - 1)
      offset = key.name === 'home' ? messages[nav.pagerSelectedMessage]!.startLine : messageEnd(nav.pagerSelectedMessage, Math.max(1, size - 1))
    } else {
      const selected = currentMessage()
      offset = key.ctrl ? key.name === 'home' ? 0 : Math.max(0, lines.length - size)
        : key.name === 'home' ? messages[selected]?.startLine ?? 0 : messageEnd(selected, size)
    }
  } else if (key.char === 'm' && messages.length && !ctx.preview) {
    selectMessage(currentMessage()); nav.pagerMode = 'message'
  } else if (key.name === 'escape' && nav.pagerMode === 'message') nav.pagerMode = 'page'
  else return false
  if (nav.pagerMode === 'message' && messages.length) {
    const start = messages[nav.pagerSelectedMessage]?.startLine ?? 0
    nav.pagerLineOffset = Math.max(start, Math.min(messageEnd(nav.pagerSelectedMessage, Math.max(1, size - 1)), offset))
  } else nav.pagerLineOffset = Math.max(0, Math.min(Math.max(0, lines.length - size), offset))
  nav.pagerPage = Math.floor(nav.pagerLineOffset / size)
  ctx.rerender()
  return true
}
