import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, link, unlink, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { generateImage, MAX_IMAGE_BYTES, type GenerateImageOptions, type GeneratedImage } from './image-gen-client.js'
import { imageDimensions } from './image-dimensions.js'
import { ImageGenerationStore, imageDirectory, legacyImages } from './image-generation-store.js'
import type { ImageGenerationRecord, ImageGenerationParameters } from '../server/protocol.js'

export interface ImageGenerationInput {
  cwd: string
  requestId: string
  origin: 'chat' | 'workbench' | 'test'
  sessionId?: string
  parameters: ImageGenerationParameters
  connection: Pick<GenerateImageOptions, 'baseUrl' | 'apiKey' | 'proxy' | 'trustProxyFakeIp'>
  outputPath?: string
  signal?: AbortSignal
}
interface Entry { record: ImageGenerationRecord; fingerprint: string; controller: AbortController; done: Promise<ImageGenerationRecord> }
export const imageGenerationPending = (state: ImageGenerationRecord['state']) => ['generating', 'downloading', 'saving'].includes(state)

export class ImageGenerationService {
  private entries = new Map<string, Entry>()
  private starting = new Map<string, { fingerprint: string; promise: Promise<ImageGenerationRecord> }>()
  constructor(private store = new ImageGenerationStore(), private generate: (options: GenerateImageOptions) => Promise<GeneratedImage> = generateImage) {}
  async start(input: ImageGenerationInput): Promise<ImageGenerationRecord> {
    input = { ...input, parameters: { ...input.parameters }, connection: { ...input.connection, ...(input.connection.proxy ? { proxy: { ...input.connection.proxy } } : {}) } }
    if (!input.parameters.prompt.trim() || input.parameters.prompt.length > 20_000) throw new Error('A description of 1–20000 characters is required')
    if (!input.requestId || input.requestId.length > 200) throw new Error('A request identifier is required')
    input.signal?.throwIfAborted()
    const cwd = await realpath(resolve(input.cwd)), key = `${cwd}:${input.requestId}`
    const fingerprint = createHash('sha256').update(JSON.stringify([input.parameters, input.connection.baseUrl, input.outputPath, input.origin, input.sessionId])).digest('hex')
    const reservation = this.starting.get(key)
    if (reservation) {
      if (reservation.fingerprint !== fingerprint) throw new Error('Request identifier already used with different parameters')
      return reservation.promise
    }
    const promise = this.prepare(input, cwd, key, fingerprint).finally(() => this.starting.delete(key))
    this.starting.set(key, { fingerprint, promise })
    return promise
  }
  private async prepare(input: ImageGenerationInput, cwd: string, key: string, fingerprint: string): Promise<ImageGenerationRecord> {
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Request identifier already used with different parameters')
      return { ...existing.record }
    }
    const persisted = (await this.store.list(cwd)).find(record => record.requestId === input.requestId)
    if (persisted) {
      if (persisted.requestFingerprint && persisted.requestFingerprint !== fingerprint) throw new Error('Request identifier already used with different parameters')
      return persisted
    }
    const record: ImageGenerationRecord = { id: randomUUID(), requestId: input.requestId, requestFingerprint: fingerprint, cwd, origin: input.origin, ...(input.sessionId ? { sessionId: input.sessionId } : {}), parameters: { ...input.parameters }, state: 'generating', startedAt: Date.now(), recordSaved: false }
    const controller = new AbortController()
    const entry: Entry = { record, fingerprint, controller, done: Promise.resolve(record) }
    this.entries.set(key, entry)
    if (this.entries.size > 128) for (const [oldKey, old] of this.entries) {
      if (oldKey !== key && old.record.recordSaved && !imageGenerationPending(old.record.state)) this.entries.delete(oldKey)
      if (this.entries.size <= 128) break
    }
    entry.done = this.run(input, entry)
    return { ...record }
  }
  private async run(input: ImageGenerationInput, entry: Entry): Promise<ImageGenerationRecord> {
    const record = entry.record
    const signal = input.signal ? AbortSignal.any([input.signal, entry.controller.signal]) : entry.controller.signal
    let phase: string = 'record'
    try {
      await this.store.write(record)
      phase = 'generating'
      const p = record.parameters
      const image = await this.generate({ ...input.connection, model: p.model, prompt: p.prefix?.trim() ? `${p.prefix.trim()}，${p.prompt}` : p.prompt, size: p.size, sizeField: p.sizeField, timeoutMs: p.timeoutMs, signal, onStage: stage => { record.state = stage; phase = stage } })
      signal.throwIfAborted()
      if (image.bytes.length > MAX_IMAGE_BYTES) throw new Error('Generated image exceeds the 50MB limit')
      record.state = 'saving'
      phase = 'saving'
      const ext = ({ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[image.mimeType] ?? 'png'
      const target = input.outputPath ? resolve(input.outputPath) : join(imageDirectory(record.cwd), `generated-${record.id}.${ext}`)
      await mkdir(dirname(target), { recursive: true })
      signal.throwIfAborted()
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, image.bytes, { flag: 'wx' })
        signal.throwIfAborted()
        await link(temporary, target)
      } finally { await unlink(temporary).catch(() => undefined) }
      Object.assign(record, { state: 'succeeded', path: target, mimeType: image.mimeType, bytes: image.bytes.length, ...imageDimensions(image.bytes), finishedAt: Date.now(), recordSaved: true })
      try { await this.store.write(record) } catch {
        record.recordSaved = false
        record.error = { stage: 'record', message: 'Image saved, but generation history could not be saved. Retry saving the record.' }
      }
    } catch (error) {
      record.state = signal.aborted ? 'cancelled' : 'failed'
      record.finishedAt = Date.now()
      const raw = error instanceof Error ? error.message : String(error)
      record.error = { stage: phase, message: input.connection.apiKey ? raw.split(input.connection.apiKey).join('***') : raw }
      try { await this.store.write(record); record.recordSaved = true } catch { record.recordSaved = false }
    }
    return { ...record }
  }
  async wait(cwd: string, id: string): Promise<ImageGenerationRecord | undefined> {
    cwd = await realpath(resolve(cwd))
    const entry = [...this.entries.values()].find(entry => entry.record.cwd === resolve(cwd) && entry.record.id === id)
    return entry ? entry.done : this.get(cwd, id)
  }
  async get(cwd: string, id: string): Promise<ImageGenerationRecord | undefined> {
    cwd = await realpath(resolve(cwd))
    const entry = [...this.entries.values()].find(entry => entry.record.cwd === resolve(cwd) && entry.record.id === id)
    if (entry) return { ...entry.record }
    if (id.startsWith('legacy-')) return (await legacyImages(cwd, await this.store.list(cwd))).find(record => record.id === id)
    return this.store.read(cwd, id)
  }
  async cancel(cwd: string, id: string): Promise<ImageGenerationRecord | undefined> {
    cwd = await realpath(resolve(cwd))
    const entry = [...this.entries.values()].find(entry => entry.record.cwd === resolve(cwd) && entry.record.id === id)
    if (entry && imageGenerationPending(entry.record.state)) entry.controller.abort()
    return this.get(cwd, id)
  }
  async repair(cwd: string, id: string): Promise<ImageGenerationRecord> {
    const record = await this.get(cwd, id)
    if (!record?.path || record.state !== 'succeeded') throw new Error('No completed image to save')
    await this.store.write({ ...record, error: undefined })
    const entry = [...this.entries.values()].find(entry => entry.record.id === id)
    if (entry) { entry.record.recordSaved = true; delete entry.record.error }
    return { ...record, recordSaved: true, error: undefined }
  }
  async list(cwd: string, query = '', offset = 0, limit = 24) {
    cwd = await realpath(resolve(cwd))
    const saved = await this.store.list(cwd)
    const merged = new Map(saved.map(record => [record.id, record]))
    for (const entry of this.entries.values()) if (entry.record.cwd === resolve(cwd)) merged.set(entry.record.id, { ...entry.record })
    for (const record of await legacyImages(cwd, [...merged.values()])) merged.set(record.id, record)
    const records = [...merged.values()].filter(record => `${record.parameters.prompt} ${record.parameters.model} ${record.path ?? ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
    return { records: records.slice(offset, offset + limit), total: records.length }
  }
  async image(cwd: string, id: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const record = await this.get(cwd, id)
    if (!record) throw new Error('Image not found')
    return { bytes: await this.store.image(record), mimeType: record.mimeType ?? 'image/png' }
  }
}
export const imageGenerationService = new ImageGenerationService()
