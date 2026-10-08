import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, setupProvider, registerProvider } from '../manager.js'
import { contractModels } from '../contract-models.js'
import { addProviderKey } from '../provider-key-store.js'
import type { ModelConfig, ProviderProtocol } from '../schema.js'
import type { ProviderPresetKey } from '../provider-presets.js'

interface RepresentativeConfig {
  label: string
  providerName: string
  preset?: ProviderPresetKey
  protocol: ProviderProtocol
  baseUrl: string
  apiKeyEnv: string
  initialModel: ModelConfig
  secondaryModel: ModelConfig
  reconnectReplaceModels: ModelConfig[]
  reconnectAppendModels: ModelConfig[]
}

const REPRESENTATIVE_CONFIGS: RepresentativeConfig[] = [
  {
    label: 'preset OpenAI (glm)',
    providerName: 'glm',
    preset: 'glm',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apiKeyEnv: 'TEST_GLM_API_KEY',
    initialModel: {
      id: 'glm-5.2',
      description: 'GLM 5.2 coding flagship',
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      tier: 'strong',
      supportsVision: true,
    },
    secondaryModel: {
      id: 'glm/edge:fast',
      description: 'Secondary pool model with slash and colon',
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    reconnectReplaceModels: [
      {
        id: 'glm-5.2',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
      {
        id: 'zhipu/glm-4v:plus',
        description: 'GLM 4V Plus with slash and colon',
        contextWindow: 500_000,
        maxTokens: 32_000,
        tier: 'strong',
      },
    ],
    reconnectAppendModels: [
      {
        id: 'zhipu/glm-zero:preview',
        description: 'GLM Zero Preview with slash and colon',
        contextWindow: 200_000,
        maxTokens: 16_000,
      },
    ],
  },
  {
    label: 'preset Anthropic (opencode-go-anthropic)',
    providerName: 'opencode-go-anthropic',
    preset: 'opencode-go-anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://opencode.ai/zen/go',
    apiKeyEnv: 'TEST_OPENCODE_API_KEY',
    initialModel: {
      id: 'qwen3.7-max',
      description: 'Qwen 3.7 Max Anthropic Messages protocol',
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      tier: 'strong',
      supportsVision: true,
    },
    secondaryModel: {
      id: 'anthropic/claude-3.5:haiku',
      description: 'Secondary pool model with slash and colon',
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    reconnectReplaceModels: [
      {
        id: 'qwen3.7-max',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
      {
        id: 'opencode/minimax:m2.5',
        description: 'MiniMax M2.5 with slash and colon',
        contextWindow: 500_000,
        maxTokens: 32_000,
        tier: 'strong',
      },
    ],
    reconnectAppendModels: [
      {
        id: 'opencode/kimi:k3',
        description: 'Kimi K3 with slash and colon',
        contextWindow: 250_000,
        maxTokens: 16_000,
      },
    ],
  },
  {
    label: 'aggregator relay preset (openrouter)',
    providerName: 'openrouter',
    preset: 'openrouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'TEST_OPENROUTER_API_KEY',
    initialModel: {
      id: 'anthropic/claude-sonnet-4.5',
      description: 'OpenRouter aggregator model with slash',
      contextWindow: 200_000,
      maxTokens: 32_768,
      tier: 'strong',
      supportsVision: true,
    },
    secondaryModel: {
      id: 'deepseek/deepseek-r1:free',
      description: 'Secondary pool model with slash and colon',
      contextWindow: 64_000,
      maxTokens: 8_192,
    },
    reconnectReplaceModels: [
      {
        id: 'anthropic/claude-sonnet-4.5',
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
      {
        id: 'meta-llama/llama-3.3-70b-instruct:nitro',
        description: 'Llama 3.3 with slash and colon',
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
    reconnectAppendModels: [
      {
        id: 'google/gemini-2.5-pro:exp',
        description: 'Gemini with slash and colon',
        contextWindow: 1_000_000,
        maxTokens: 32_000,
      },
    ],
  },
  {
    label: 'custom relay openai-responses',
    providerName: 'custom-relay-responses',
    protocol: 'openai-responses',
    baseUrl: 'https://relay.custom-responses.example.com/v1',
    apiKeyEnv: 'TEST_CUSTOM_RESPONSES_KEY',
    initialModel: {
      id: 'responses/o3-mini:high',
      description: 'Responses protocol model with slash and colon',
      contextWindow: 200_000,
      maxTokens: 64_000,
      tier: 'strong',
      supportsVision: true,
    },
    secondaryModel: {
      id: 'relay/extra:secondary',
      description: 'Secondary pool model with slash and colon',
      contextWindow: 64_000,
      maxTokens: 4_096,
    },
    reconnectReplaceModels: [
      {
        id: 'responses/o3-mini:high',
        contextWindow: 200_000,
        maxTokens: 100_000,
      },
      {
        id: 'custom/responses:fast',
        description: 'Custom responses model with slash and colon',
        contextWindow: 128_000,
        maxTokens: 16_000,
      },
    ],
    reconnectAppendModels: [
      {
        id: 'custom/append:stream',
        description: 'Appended custom model with slash and colon',
        contextWindow: 100_000,
        maxTokens: 8_000,
      },
    ],
  },
]

describe('provider model sync matrix across official providers and relays', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-matrix-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    delete process.env.TEST_GLM_API_KEY
    delete process.env.TEST_OPENCODE_API_KEY
    delete process.env.TEST_OPENROUTER_API_KEY
    delete process.env.TEST_CUSTOM_RESPONSES_KEY
    rmSync(dir, { recursive: true, force: true })
  })

  function initProviderFixture(c: RepresentativeConfig): void {
    process.env[c.apiKeyEnv] = 'dummy-key-value'
    if (c.preset) {
      setupProvider({
        providerName: c.providerName,
        preset: c.preset,
        apiKeyEnv: c.apiKeyEnv,
        baseUrl: c.baseUrl,
        models: [c.initialModel],
      })
    } else {
      registerProvider({
        providerName: c.providerName,
        baseUrl: c.baseUrl,
        protocol: c.protocol,
        apiKeyEnv: c.apiKeyEnv,
        models: [c.initialModel],
      })
    }

    // Materialize external provider-keys.json before secondary key addition
    loadConfig()

    addProviderKey(c.providerName, {
      label: 'secondary',
      apiKey: 'sk-secondary-dummy',
      models: [c.secondaryModel],
    })

    // Materialize external provider-keys.json before reconnect mutations
    loadConfig()
  }

  describe('reconnect replace (selection update)', () => {
    for (const c of REPRESENTATIVE_CONFIGS) {
      it(`updates contractModels, preserves protocol/baseUrl, metadata, and secondary keys for ${c.label}`, () => {
        initProviderFixture(c)

        setupProvider({
          providerName: c.providerName,
          models: c.reconnectReplaceModels,
          modelsMode: 'replace',
        })

        const reloaded = loadConfig().provider.providers[c.providerName]!
        assert.ok(reloaded, `Provider ${c.providerName} must exist after reconnect`)

        // 1. Contract models updated to union of replaced default key + preserved secondary key
        const effectiveModels = contractModels(reloaded)
        const effectiveIds = effectiveModels.map(m => m.id)
        const expectedDefaultIds = c.reconnectReplaceModels.map(m => m.id)
        const expectedSecondaryIds = [c.secondaryModel.id]
        assert.deepEqual(effectiveIds, [...expectedDefaultIds, ...expectedSecondaryIds])

        // 2. Default key and top-level models snapshot stay in sync
        const defaultKey = reloaded.keys?.find(k => k.id === 'default') ?? reloaded.keys?.[0]
        assert.ok(defaultKey, 'Default key must exist')
        assert.deepEqual(defaultKey.models.map(m => m.id), expectedDefaultIds)
        assert.deepEqual(reloaded.models.map(m => m.id), expectedDefaultIds)

        // 3. Secondary key pool preserved
        assert.equal(reloaded.keys?.length, 2, 'Both default and secondary keys must be preserved')
        const secondaryKey = reloaded.keys?.find(k => k.label === 'secondary')
        assert.ok(secondaryKey, 'Secondary key must be present')
        assert.deepEqual(secondaryKey.models.map(m => m.id), expectedSecondaryIds)

        // 4. Provider protocol and base URL preserved
        assert.equal(reloaded.protocol, c.protocol, 'Protocol must be preserved')
        assert.equal(reloaded.baseUrl, c.baseUrl, 'Base URL must be preserved')

        // 5. Explicit metadata preserved on updated initial model via mergeModelUpdate
        const mergedInitial = effectiveModels.find(m => m.id === c.initialModel.id)
        assert.ok(mergedInitial, 'Initial model should exist after reconnect')
        assert.equal(mergedInitial.supportsVision, c.initialModel.supportsVision, 'supportsVision must be preserved')
        assert.equal(mergedInitial.tier, c.initialModel.tier, 'tier must be preserved')

        // 6. Model IDs with colons and slashes remain exact
        for (const id of [...expectedDefaultIds, ...expectedSecondaryIds]) {
          const match = effectiveModels.find(m => m.id === id)
          assert.ok(match, `Model id "${id}" must exist in contract models`)
          assert.equal(match.id, id, `Model id "${id}" must match exact string`)
        }
      })
    }
  })

  describe('reconnect append (batch append)', () => {
    for (const c of REPRESENTATIVE_CONFIGS) {
      it(`merges into contractModels, preserves protocol/baseUrl, metadata, and secondary keys for ${c.label}`, () => {
        initProviderFixture(c)

        setupProvider({
          providerName: c.providerName,
          models: c.reconnectAppendModels,
          modelsMode: 'append',
        })

        const reloaded = loadConfig().provider.providers[c.providerName]!
        assert.ok(reloaded, `Provider ${c.providerName} must exist after append`)

        // 1. Contract models merged: initial + appended on default key + preserved secondary key
        const effectiveModels = contractModels(reloaded)
        const effectiveIds = effectiveModels.map(m => m.id)
        const expectedDefaultIds = [c.initialModel.id, ...c.reconnectAppendModels.map(m => m.id)]
        const expectedSecondaryIds = [c.secondaryModel.id]
        assert.deepEqual(effectiveIds, [...expectedDefaultIds, ...expectedSecondaryIds])

        // 2. Default key and top-level models snapshot stay in sync
        const defaultKey = reloaded.keys?.find(k => k.id === 'default') ?? reloaded.keys?.[0]
        assert.ok(defaultKey, 'Default key must exist')
        assert.deepEqual(defaultKey.models.map(m => m.id), expectedDefaultIds)
        assert.deepEqual(reloaded.models.map(m => m.id), expectedDefaultIds)

        // 3. Secondary key pool preserved
        assert.equal(reloaded.keys?.length, 2, 'Both default and secondary keys must be preserved')
        const secondaryKey = reloaded.keys?.find(k => k.label === 'secondary')
        assert.ok(secondaryKey, 'Secondary key must be present')
        assert.deepEqual(secondaryKey.models.map(m => m.id), expectedSecondaryIds)

        // 4. Provider protocol and base URL preserved
        assert.equal(reloaded.protocol, c.protocol, 'Protocol must be preserved')
        assert.equal(reloaded.baseUrl, c.baseUrl, 'Base URL must be preserved')

        // 5. Explicit metadata preserved
        const initial = effectiveModels.find(m => m.id === c.initialModel.id)
        assert.ok(initial, 'Initial model must exist')
        assert.equal(initial.supportsVision, c.initialModel.supportsVision)
        assert.equal(initial.tier, c.initialModel.tier)

        // 6. Model IDs with colons and slashes remain exact
        for (const id of [...expectedDefaultIds, ...expectedSecondaryIds]) {
          const match = effectiveModels.find(m => m.id === id)
          assert.ok(match, `Model id "${id}" must exist`)
          assert.equal(match.id, id, `Model id "${id}" must match exact string`)
        }
      })
    }
  })

  describe('keyless local provider (ollama)', () => {
    it('reconnect replace and append update contractModels without key pools and preserve exact IDs', () => {
      // 1. Initial setup of keyless ollama
      setupProvider({
        providerName: 'ollama',
        preset: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        models: [
          {
            id: 'qwen2.5:7b',
            contextWindow: 32_768,
            maxTokens: 8_192,
            tier: 'balanced',
            supportsVision: true,
          },
        ],
      })

      // Materialize config before inspecting/reconnecting
      loadConfig()

      let prov = loadConfig().provider.providers.ollama!
      assert.ok(prov, 'ollama provider must exist')
      assert.equal(prov.protocol, 'openai')
      assert.equal(prov.baseUrl, 'http://127.0.0.1:11434/v1')
      assert.equal(prov.keys, undefined, 'keyless provider should not generate key pool')
      assert.deepEqual(contractModels(prov).map(m => m.id), ['qwen2.5:7b'])

      // 2. Reconnect replace
      setupProvider({
        providerName: 'ollama',
        models: [
          {
            id: 'qwen2.5:7b',
            contextWindow: 32_768,
            maxTokens: 16_000,
          },
          {
            id: 'deepseek-r1:14b',
            contextWindow: 64_000,
            maxTokens: 16_000,
            tier: 'strong',
          },
          {
            id: 'library/custom:latest',
            contextWindow: 32_000,
            maxTokens: 4_000,
          },
        ],
        modelsMode: 'replace',
      })

      prov = loadConfig().provider.providers.ollama!
      assert.equal(prov.keys, undefined, 'still keyless without key pool')
      assert.equal(prov.protocol, 'openai')
      assert.equal(prov.baseUrl, 'http://127.0.0.1:11434/v1')
      const replacedModels = contractModels(prov)
      assert.deepEqual(
        replacedModels.map(m => m.id),
        ['qwen2.5:7b', 'deepseek-r1:14b', 'library/custom:latest'],
      )
      const qwen = replacedModels.find(m => m.id === 'qwen2.5:7b')!
      assert.equal(qwen.maxTokens, 16_000)
      assert.equal(qwen.tier, 'balanced', 'tier metadata preserved')
      assert.equal(qwen.supportsVision, true, 'supportsVision metadata preserved')

      // 3. Reconnect append
      setupProvider({
        providerName: 'ollama',
        models: [
          {
            id: 'mistralai/mistral-nemo:12b',
            contextWindow: 128_000,
            maxTokens: 8_000,
          },
        ],
        modelsMode: 'append',
      })

      prov = loadConfig().provider.providers.ollama!
      assert.equal(prov.keys, undefined, 'remains keyless')
      assert.equal(prov.protocol, 'openai')
      assert.equal(prov.baseUrl, 'http://127.0.0.1:11434/v1')
      const appendedModels = contractModels(prov)
      assert.deepEqual(
        appendedModels.map(m => m.id),
        ['qwen2.5:7b', 'deepseek-r1:14b', 'library/custom:latest', 'mistralai/mistral-nemo:12b'],
      )

      // Verify all model IDs with colons and slashes remain exact
      for (const id of ['qwen2.5:7b', 'deepseek-r1:14b', 'library/custom:latest', 'mistralai/mistral-nemo:12b']) {
        const found = appendedModels.find(m => m.id === id)
        assert.ok(found, `Model "${id}" must exist`)
        assert.equal(found.id, id, `Model "${id}" must match exact ID`)
      }
    })
  })
})
