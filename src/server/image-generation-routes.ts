import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withAuth } from './routes.js'
import { allowedCorsOrigin } from './cors.js'
import type { RouteHandler } from './index.js'
import type { ImageGenerationParameters } from './protocol.js'
import { resolveImageGeneration, imageSizeSchema, imageGenerationNetwork } from '../api/image-generation-parameters.js'
import { loadConfig } from '../config/manager.js'
import type { ImageGenerationInput } from '../api/image-generation-service.js'
import { z } from 'zod'
import { imageGenerationService, type ImageGenerationService } from '../api/image-generation-service.js'

const draftSchema = z.object({
  baseUrl: z.string().trim().url(), modelId: z.string().trim().min(1), providerName: z.string().trim().optional(),
  apiKey: z.string().optional(), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  sizeField: z.enum(['size', 'image_size']).optional(), size: z.union([z.literal(''), imageSizeSchema]).optional(),
})

export function buildImageGenerationRoutes(apiToken?: string, knownWorkspaces: () => string[] = () => [], service: ImageGenerationService = imageGenerationService): Record<string, RouteHandler> {
  const scoped = (handler: (cwd: string, body: Record<string, unknown>, params: Record<string, string>, headers: Record<string, string>, res: Parameters<RouteHandler>[3]) => ReturnType<RouteHandler>): RouteHandler => withAuth(async (body, params, headers, res) => {
    const data = (body ?? {}) as Record<string, unknown>, raw = typeof data.cwd === 'string' ? data.cwd : params?.cwd
    if (!raw) return { status: 400, body: { error: 'Choose a workspace before generating' } }
    try {
      const cwd = await realpath(resolve(raw))
      const known = await Promise.all(knownWorkspaces().map(path => realpath(path).catch(() => '')))
      if (!known.includes(cwd)) return { status: 403, body: { error: 'Workspace is not registered' } }
      return await handler(cwd, data, params ?? {}, headers ?? {}, res)
    } catch (error) { return { status: 400, body: { error: (error as Error).message } } }
  }, apiToken)
  return {
    'POST /image-generations': scoped(async (cwd, data) => {
      const raw = (data.parameters ?? {}) as Partial<ImageGenerationParameters>
      const origin = data.origin === 'test' ? 'test' : 'workbench'
      let selected: Pick<ImageGenerationInput, 'parameters' | 'connection'>
      if (origin === 'test' && data.draft && typeof data.draft === 'object') {
        const draft = draftSchema.parse(data.draft)
        if (draft.apiKey && draft.apiKeyEnv) throw new Error('Use either a key or an environment variable')
        const baseUrl = String(draft.baseUrl ?? '').trim(), model = String(draft.modelId ?? '').trim()
        const url = new URL(baseUrl)
        if (!['https:', 'http:'].includes(url.protocol) || !model) throw new Error('Enter an endpoint and model')
        const size = typeof draft.size === 'string' && draft.size ? draft.size : undefined
        if (draft.apiKeyEnv && !process.env[draft.apiKeyEnv]) throw new Error('The configured environment variable is not set')
        selected = { parameters: { provider: String(draft.providerName ?? 'test'), model, prompt: 'a red circle on a white background', size, sizeField: draft.sizeField === 'image_size' ? 'image_size' : 'size', timeoutMs: 180_000 }, connection: { baseUrl, apiKey: typeof draft.apiKey === 'string' && draft.apiKey ? draft.apiKey : typeof draft.apiKeyEnv === 'string' ? process.env[draft.apiKeyEnv] : undefined, ...imageGenerationNetwork(loadConfig()) } }
      } else selected = resolveImageGeneration({ ...raw, ...(origin === 'test' ? { prompt: 'a red circle on a white background' } : {}) })
      const requestId = z.string().min(1).max(200).parse(data.requestId)
      const record = await service.start({ cwd, requestId, origin, ...selected, ...(typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : {}) })
      return { status: 202, body: record }
    }),
    'GET /image-generations': scoped(async (cwd, _body, params) => ({ status: 200, body: await service.list(cwd, (params.q ?? '').slice(0, 500), Math.max(0, Number(params.offset) || 0), Math.min(100, Math.max(1, Number(params.limit) || 24))) })),
    'GET /image-generations/:id': scoped(async (cwd, _body, params) => {
      const record = await service.get(cwd, params.id!)
      return record ? { status: 200, body: record } : { status: 404, body: { error: 'Generation not found' } }
    }),
    'POST /image-generations/:id/cancel': scoped(async (cwd, _body, params) => {
      const record = await service.cancel(cwd, params.id!)
      return record ? { status: 200, body: record } : { status: 404, body: { error: 'Generation not found' } }
    }),
    'POST /image-generations/:id/repair': scoped(async (cwd, _body, params) => ({ status: 200, body: await service.repair(cwd, params.id!) })),
    'GET /image-generations/:id/image': scoped(async (cwd, _body, params, headers, res) => {
      const image = await service.image(cwd, params.id!)
      if (!res) return { status: 500, body: { error: 'Response stream is unavailable' } }
      const origin = allowedCorsOrigin(headers)
      res.writeHead(200, { 'Content-Type': image.mimeType, 'Content-Length': image.bytes.length, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff', ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) })
      res.end(image.bytes)
      return { status: 200, handled: true }
    }),
  }
}
