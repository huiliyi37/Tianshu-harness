import { mkdir, readFile, writeFile, rename, readdir, stat, realpath, unlink } from 'node:fs/promises'
import { join, basename, extname, resolve, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ImageGenerationRecord } from '../server/protocol.js'

export const imageDirectory = (cwd: string) => join(cwd, '.rivet', 'artifacts', 'images')
const pending = new Set(['generating', 'downloading', 'saving'])
const validId = (id: string) => /^(?:[0-9a-f-]{36}|legacy-[0-9a-f]{32})$/.test(id)

export class ImageGenerationStore {
  async write(record: ImageGenerationRecord): Promise<void> {
    if (!validId(record.id)) throw new Error('Invalid generation identifier')
    record = { ...record, cwd: await realpath(record.cwd) }
    const directory = imageDirectory(record.cwd)
    await mkdir(directory, { recursive: true })
    const target = join(directory, `${record.id}.json`), temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ ...record, recordSaved: true }), { flag: 'wx' })
      await rename(temporary, target)
    } finally { await unlink(temporary).catch(() => undefined) }
  }
  async read(cwd: string, id: string): Promise<ImageGenerationRecord | undefined> {
    if (!validId(id)) return undefined
    cwd = await realpath(cwd)
    try {
      const record = JSON.parse(await readFile(join(imageDirectory(cwd), `${id}.json`), 'utf8')) as ImageGenerationRecord
      if (record.id !== id || await realpath(resolve(record.cwd)) !== cwd || !record.parameters || typeof record.startedAt !== 'number') return undefined
      if (!['chat', 'workbench', 'test', 'legacy'].includes(record.origin) || !['generating', 'downloading', 'saving', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(record.state) || !['provider', 'model', 'prompt'].every(key => typeof record.parameters[key as keyof typeof record.parameters] === 'string')) return undefined
      record.cwd = cwd
      if (pending.has(record.state)) {
        for (const ext of ['png', 'jpg', 'webp', 'gif']) {
          const path = join(imageDirectory(cwd), `generated-${id}.${ext}`)
          const info = await stat(path).catch(() => undefined)
          if (info?.isFile()) return { ...record, state: 'succeeded', path, bytes: info.size, mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, recordSaved: false, error: { stage: 'record', message: 'Image saved, but the generation record was not completed. Retry saving the record.' } }
        }
        return { ...record, state: 'interrupted', error: { stage: record.state, message: 'Application stopped before this generation completed.' } }
      }
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
      throw error
    }
  }
  async list(cwd: string): Promise<ImageGenerationRecord[]> {
    let names: string[]
    try { names = await readdir(imageDirectory(cwd)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records = (await Promise.all(names.filter(name => name.endsWith('.json')).map(name => this.read(cwd, name.slice(0, -5))))).filter((record): record is ImageGenerationRecord => !!record)
    return records
  }
  async image(record: ImageGenerationRecord): Promise<Uint8Array> {
    if (!record.path) throw new Error('Image is not available')
    const root = await realpath(record.cwd), target = await realpath(record.path)
    const rel = relative(root, target)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Image is outside its workspace')
    const info = await stat(target)
    if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error('Image is unavailable or too large')
    return readFile(target)
  }
}

export async function legacyImages(cwd: string, records: ImageGenerationRecord[]): Promise<ImageGenerationRecord[]> {
  const { createHash } = await import('node:crypto')
  const directory = imageDirectory(cwd), known = new Set(records.map(record => record.path))
  let names: string[]
  try { names = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: ImageGenerationRecord[] = []
  for (const name of names.filter(name => /\.(png|jpe?g|webp|gif)$/i.test(name))) {
    const path = join(directory, name)
    if (known.has(path)) continue
    const info = await stat(path)
    if (!info.isFile()) continue
    const id = `legacy-${createHash('md5').update(basename(path)).digest('hex')}`
    out.push({ id, requestId: id, cwd, origin: 'legacy', parameters: { provider: '', model: '', prompt: '' }, state: 'succeeded', startedAt: info.mtimeMs, path, bytes: info.size, mimeType: `image/${extname(path).slice(1).replace('jpg', 'jpeg')}`, recordSaved: true })
  }
  return out
}
