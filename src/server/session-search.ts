import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { sessionsDir } from '../config/paths.js'
import { verifyAndExtract } from '../agent/checksum.js'
import { decodeTranscriptText } from '../agent/session-transcript-codec.js'

const SEARCH_CONCURRENCY = 4
const SEARCH_PER_SESSION_MAX = 3
const SEARCH_TOTAL_MAX = 50
const SEARCH_SNIPPET_RADIUS = 60

export type SessionSearchHit = {
  sessionId: string
  title: string
  role: 'user' | 'assistant'
  snippet: string
}

export type SessionSearchRecord = {
  id: string
  title?: string
  cwd: string
}

export type SessionSearchMetrics = {
  durationMs: number
  scannedFiles: number
}

export type SessionSearchResult = {
  results: SessionSearchHit[]
  metadata: SessionSearchMetrics
}

export type SessionSearchOptions = {
  readFile?: (
    path: string,
    options: { signal?: AbortSignal },
  ) => Promise<Buffer>
  filePathFor?: (session: SessionSearchRecord) => string
  yieldControl?: () => Promise<void>
  onMetrics?: (metrics: SessionSearchMetrics) => void
  signal?: AbortSignal
}

function searchSnippet(text: string, lowerQuery: string): string | null {
  const index = text.toLowerCase().indexOf(lowerQuery)
  if (index < 0) return null
  const start = Math.max(0, index - SEARCH_SNIPPET_RADIUS)
  const end = Math.min(text.length, index + lowerQuery.length + SEARCH_SNIPPET_RADIUS)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

async function searchTranscript(
  session: SessionSearchRecord,
  lowerQuery: string,
  read: NonNullable<SessionSearchOptions['readFile']>,
  filePathFor: NonNullable<SessionSearchOptions['filePathFor']>,
  signal?: AbortSignal,
): Promise<SessionSearchHit[]> {
  if (signal?.aborted) return []
  let raw: string
  try {
    const buf = await read(filePathFor(session), { signal })
    raw = decodeTranscriptText(buf)
  } catch {
    return []
  }
  if (signal?.aborted) return []

  const hits: SessionSearchHit[] = []
  for (const line of raw.split('\n')) {
    if (signal?.aborted) break
    if (hits.length >= SEARCH_PER_SESSION_MAX) break
    if (!line.trim()) continue
    const { json } = verifyAndExtract(line)
    let parsed: { role?: unknown; content?: unknown; type?: unknown }
    try {
      parsed = JSON.parse(json) as typeof parsed
    } catch {
      continue
    }
    if (typeof parsed.type === 'string') continue
    if (parsed.role !== 'user' && parsed.role !== 'assistant') continue
    if (typeof parsed.content !== 'string' || !parsed.content) continue
    const snippet = searchSnippet(parsed.content, lowerQuery)
    if (snippet) {
      hits.push({
        sessionId: session.id,
        title: session.title ?? session.id.slice(0, 8),
        role: parsed.role,
        snippet,
      })
    }
  }
  return hits
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export async function searchSessionTranscripts(
  sessions: readonly SessionSearchRecord[],
  query: string,
  options: SessionSearchOptions = {},
): Promise<SessionSearchResult> {
  const startedAt = performance.now()
  const lowerQuery = query.trim().toLowerCase()
  const read = options.readFile ?? readFile
  const filePathFor = options.filePathFor
    ?? ((session: SessionSearchRecord) => join(sessionsDir(session.cwd), `${session.id}.jsonl`))
  const yieldControl = options.yieldControl ?? immediate
  const hitsByIndex: Array<SessionSearchHit[] | undefined> = new Array(sessions.length)
  let scannedFiles = 0
  let nextIndex = 0
  let contiguousIndex = 0
  let contiguousHits = 0
  let capReached = false

  const updateContiguousPrefix = () => {
    while (contiguousIndex < hitsByIndex.length) {
      const hits = hitsByIndex[contiguousIndex]
      if (hits === undefined) break
      contiguousHits += hits.length
      contiguousIndex++
      if (contiguousHits >= SEARCH_TOTAL_MAX) {
        capReached = true
        break
      }
    }
  }

  const worker = async () => {
    while (!options.signal?.aborted && !capReached) {
      const index = nextIndex++
      if (index >= sessions.length) return
      scannedFiles++
      hitsByIndex[index] = await searchTranscript(
        sessions[index]!,
        lowerQuery,
        read,
        filePathFor,
        options.signal,
      )
      updateContiguousPrefix()
      if (options.signal?.aborted || capReached || nextIndex >= sessions.length) return
      await yieldControl()
    }
  }

  if (lowerQuery.length >= 2 && !options.signal?.aborted) {
    const workerCount = Math.min(SEARCH_CONCURRENCY, sessions.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  }

  const results: SessionSearchHit[] = []
  for (const hits of hitsByIndex) {
    if (!hits) break
    results.push(...hits.slice(0, SEARCH_TOTAL_MAX - results.length))
    if (results.length >= SEARCH_TOTAL_MAX) break
  }
  const metadata = { durationMs: performance.now() - startedAt, scannedFiles }
  options.onMetrics?.(metadata)
  return { results, metadata }
}
