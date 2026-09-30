import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGenerateImageTool } from '../generate-image.js'
import { createDefaultToolRegistry } from '../default-registry.js'
import { registerImageGenModelConfig } from '../../config/image-gen-model.js'
import type { ImageGenModelConfigSnapshot } from '../../config/image-gen-schema.js'

// 1×1 透明 PNG。
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_B64, 'base64'))

/** 图片落盘路径的判据：POSIX 以 / 开头；Windows 以盘符开头（C:\...）。
 *  两形态都要认得——此前只认 POSIX 形态，Windows 上「应含绝对路径」恒红。 */
const ABS_IMG_PATH_RE = process.platform === 'win32'
  ? /[A-Za-z]:\\[^\s：]*\.png/
  : /\/[^\s：]*\.png/

const CONFIGURED: ImageGenModelConfigSnapshot = {
  provider: 'imagegen-test',
  model: 'flux-pro',
}

function makeConfig() {
  return {
    provider: {
      default: 'deepseek',
      providers: {
        'imagegen-test': {
          name: 'imagegen-test',
          baseUrl: 'https://api.siliconflow.com/v1',
          protocol: 'openai' as const,
          models: [],
        },
      },
    },
  }
}

describe('generate_image tool — fail-closed (issue #8 §5)', () => {
  it('is disabled when no image-gen slot is configured', () => {
    const tool = createGenerateImageTool({ getConfig: () => undefined })
    assert.equal(tool.isEnabled(), false, '未配置时必须不注册——模型看不到它才不会产生无效调用')
  })

  it('is enabled once the slot is configured', () => {
    const tool = createGenerateImageTool({ getConfig: () => CONFIGURED })
    assert.equal(tool.isEnabled(), true)
  })

  it('returns a specific, actionable error if invoked while unconfigured', async () => {
    const tool = createGenerateImageTool({ getConfig: () => undefined })
    const result = await tool.execute({ input: { prompt: 'a cat' } } as never)
    assert.equal(result.isError, true)
    assert.match(result.content, /未配置/)
    // 错误文案要告诉用户去哪儿配，而不是笼统的 "not available"。
    assert.match(result.content, /设置|config image-gen|生图模型/)
  })

  // 审查发现（MEDIUM）：这是全库唯一会读配置的 isEnabled（其余都是 () => true），
  // 而 registry.getDefinitions() 的 `.filter(t => t.isEnabled())` 没有 try/catch
  // —— 配置损坏时异常会冒穿整个 filter，让**整张工具表**构造失败。必须降级到
  // "这一个工具不可用"。
  it('isEnabled 在配置读取抛异常时降级为 false，而不是把异常抛给 getDefinitions()', () => {
    const tool = createGenerateImageTool({
      getConfig: () => { throw new Error('config.json 损坏：schema 校验失败') },
    })
    assert.equal(tool.isEnabled(), false)
  })
})

describe('generate_image tool — base64 never reaches the transcript (§10 反证 2)', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-genimg-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns a file path, not image bytes', async () => {
    const tool = createGenerateImageTool({
      getConfig: () => CONFIGURED,
      cwd: dir,
      loadConfig: makeConfig as never,
      resolveApiKey: () => 'sk-test',
      generateImage: async () => ({ bytes: PNG_BYTES, mimeType: 'image/png', source: 'b64_json' }),
    })

    const result = await tool.execute({ input: { prompt: 'a red circle' } } as never)
    assert.equal(result.isError, undefined)

    // ① 不含 base64 的任何形态
    assert.equal(result.content.includes('base64'), false)
    assert.equal(result.content.includes(PNG_B64), false, '图片 base64 绝不能出现在对话内容里')
    assert.equal(result.content.includes('data:image'), false)
    // ② 长度上限是关键——即使不含关键词，塞了长 base64 也会被打红
    assert.ok(result.content.length < 500, `content 应简短，实际 ${result.content.length} 字符`)
    // ③ 必须给出可用的本地路径
    assert.ok(ABS_IMG_PATH_RE.test(result.content), `应含绝对路径，实际：${result.content}`)
  })

  it('actually writes the image bytes to disk', async () => {
    const tool = createGenerateImageTool({
      getConfig: () => CONFIGURED,
      cwd: dir,
      loadConfig: makeConfig as never,
      resolveApiKey: () => 'sk-test',
      generateImage: async () => ({ bytes: PNG_BYTES, mimeType: 'image/png', source: 'b64_json' }),
    })

    const result = await tool.execute({ input: { prompt: 'a red circle' } } as never)
    const match = result.content.match(ABS_IMG_PATH_RE)
    assert.ok(match)
    const written = match[0] as string
    assert.ok(existsSync(written), `文件应真实落盘：${written}`)
    assert.deepEqual(new Uint8Array(readFileSync(written)), PNG_BYTES, '落盘字节应与客户端返回一致')
  })

  it('honors an explicit output_path outside the workspace', async () => {
    const target = join(dir, 'nested', 'custom-name.png')
    const tool = createGenerateImageTool({
      getConfig: () => CONFIGURED,
      cwd: join(dir, 'workspace'),
      loadConfig: makeConfig as never,
      resolveApiKey: () => 'sk-test',
      generateImage: async () => ({ bytes: PNG_BYTES, mimeType: 'image/png', source: 'url' }),
    })

    const result = await tool.execute({ input: { prompt: 'x', output_path: target } } as never)
    assert.equal(result.isError, undefined)
    assert.ok(existsSync(target), '显式路径应被尊重（含父目录自动创建）')
  })

  it('surfaces generation failures as isError without dumping the payload', async () => {
    const tool = createGenerateImageTool({
      getConfig: () => CONFIGURED,
      cwd: dir,
      loadConfig: makeConfig as never,
      resolveApiKey: () => 'sk-test',
      generateImage: async () => {
        throw new Error('Rate limited or quota exhausted (HTTP 429) — server said: TPM limit reached.')
      },
    })

    const result = await tool.execute({ input: { prompt: 'x' } } as never)
    assert.equal(result.isError, true)
    assert.match(result.content, /429|Rate limited/)
    assert.ok(result.content.length < 500, '错误文案也要简短')
  })

  // 审查发现（MEDIUM）：字节上限的第二道防线。客户端那层已经拦，但客户端是可注入
  // 的——写盘前必须再核一次，否则换一个生成器实现就绕过去了。
  it('注入的客户端返回超限字节时拒绝写盘', async () => {
    const tool = createGenerateImageTool({
      getConfig: () => CONFIGURED,
      cwd: dir,
      loadConfig: makeConfig as never,
      resolveApiKey: () => 'sk-test',
      maxBytes: 1024,
      generateImage: async () => ({ bytes: new Uint8Array(4096), mimeType: 'image/png', source: 'b64_json' }),
    })

    const result = await tool.execute({ input: { prompt: 'x' } } as never)
    assert.equal(result.isError, true)
    assert.match(result.content, /过大|too large/)
    assert.equal(
      existsSync(join(dir, '.rivet', 'artifacts', 'images')),
      false,
      '超限时连输出目录都不该建——拒绝要在写盘动作之前',
    )
  })
})

// issue #8 闭环的关键前提：工具定义是**动态求值**的（getDefinitions 每次 filter
// isEnabled），所以配置一变、只要让 agent 重算一次就生效——**不需要重建 agent**。
// 这条测试在同一个 registry 实例上验证配置前后的差异；没有它，「刷新工具表」这个
// 接线就只是推测。
describe('generate_image — 配置生效的机制（无需重建 registry）', () => {
  let cfgDir = ''

  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), 'rivet-genimg-registry-'))
    process.env.RIVET_CONFIG_PATH = join(cfgDir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(cfgDir, { recursive: true, force: true })
  })

  it('同一 registry 上：配置槽之前不出现，配置之后出现', () => {
    const registry = createDefaultToolRegistry([], { preset: 'full', desktopTools: true })
    const has = (): boolean => registry.getDefinitions().some(t => t.name === 'generate_image')

    assert.equal(has(), false, '未配置槽时不该出现在工具定义里')

    registerImageGenModelConfig({
      providerName: 'imagegen-registry',
      baseUrl: 'https://api.siliconflow.com/v1',
      apiKeyEnv: 'IMAGE_GEN_KEY',
      modelId: 'flux-pro',
    })

    assert.equal(
      has(),
      true,
      '同一实例、不重建 registry，配置后即出现——这正是 refreshAgentTools 能生效的前提',
    )
  })
})

describe('generate_image tool — request wiring', () => {
  it('passes slot fields (model/size/sizeField/prompt prefix) to the client', async () => {
    let seen: Record<string, unknown> | undefined
    const tool = createGenerateImageTool({
      getConfig: () => ({
        provider: 'imagegen-test',
        model: 'flux-pro',
        size: '512x512',
        sizeField: 'image_size',
        prompt: '水彩风格',
        timeoutMs: 90_000,
      }),
      cwd: tmpdir(),
      loadConfig: makeConfig as never,
      resolveApiKey: () => 'sk-test',
      generateImage: async (options) => {
        seen = options as unknown as Record<string, unknown>
        return { bytes: PNG_BYTES, mimeType: 'image/png', source: 'b64_json' }
      },
    })

    await tool.execute({ input: { prompt: '一只猫' } } as never)
    assert.equal(seen?.baseUrl, 'https://api.siliconflow.com/v1', 'baseUrl 取自 provider 配置，不是槽')
    assert.equal(seen?.model, 'flux-pro')
    assert.equal(seen?.size, '512x512')
    assert.equal(seen?.sizeField, 'image_size')
    assert.equal(seen?.timeoutMs, 90_000)
    assert.equal(seen?.apiKey, 'sk-test')
    // 提示词前缀拼在用户 prompt 之前。
    assert.match(String(seen?.prompt), /水彩风格/)
    assert.match(String(seen?.prompt), /一只猫/)
  })

  it('lets an explicit size argument override the slot default', async () => {
    let seen: Record<string, unknown> | undefined
    const tool = createGenerateImageTool({
      getConfig: () => ({ provider: 'imagegen-test', model: 'flux-pro', size: '512x512' }),
      cwd: tmpdir(),
      loadConfig: makeConfig as never,
      resolveApiKey: () => 'sk-test',
      generateImage: async (options) => {
        seen = options as unknown as Record<string, unknown>
        return { bytes: PNG_BYTES, mimeType: 'image/png', source: 'b64_json' }
      },
    })

    await tool.execute({ input: { prompt: 'x', size: '1024x1024' } } as never)
    assert.equal(seen?.size, '1024x1024')
  })
})
