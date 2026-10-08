<script setup lang="ts">
import { ref } from 'vue'
import { Check, Copy } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import { useScrollAnimation } from '@/composables/useScrollAnimation'
import { useI18n } from '@/composables/useI18n'

const copiedIndex = ref<number | null>(null)
const { ref: scrollRef, isVisible } = useScrollAnimation(0.1)
const { t } = useI18n()

const installSteps = [
  {
    title: 'quickstart.step1_title',
    code: 'git clone https://github.com/huiliyi37/Tianshu-harness.git\ncd Tianshu-harness\nnpm install && npm run build',
  },
  {
    title: 'quickstart.step2_title',
    code: 'export DEEPSEEK_API_KEY=sk-xxx\n# 或使用交互式配置：rivet config',
  },
  {
    title: 'quickstart.step3_title',
    code: 'npm start\n# 或：rivet -p "解释 src/agent/loop.ts"',
  },
]

async function copy(code: string, index: number) {
  await navigator.clipboard.writeText(code)
  copiedIndex.value = index
  setTimeout(() => {
    copiedIndex.value = null
  }, 2000)
}
</script>

<template>
  <section id="quickstart" class="relative bg-bg-primary px-4 sm:px-6 py-16 sm:py-24">
    <div class="pointer-events-none absolute inset-0 bg-glow opacity-40" />

    <div
      ref="scrollRef"
      :class="['relative mx-auto max-w-4xl animate-on-scroll', isVisible ? 'visible' : '']"
    >
      <div class="mb-8 sm:mb-12 text-center">
        <h2 class="mb-3 sm:mb-4 text-2xl sm:text-3xl font-bold tracking-tight md:text-5xl">
          {{ t('quickstart.title') }}
        </h2>
        <p class="mx-auto max-w-2xl text-base sm:text-lg text-text-secondary">
          {{ t('quickstart.desc') }}
        </p>
      </div>

      <div class="space-y-4 sm:space-y-6 stagger-children">
        <div v-for="(step, index) in installSteps" :key="step.title">
          <h3 class="mb-2 text-xs sm:text-sm font-medium text-text-secondary">
            <span class="mr-2 inline-flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full bg-accent/10 text-xs text-accent-glow">
              {{ index + 1 }}
            </span>
            {{ t(step.title) }}
          </h3>
          <div class="group relative overflow-hidden rounded-lg sm:rounded-xl border border-white/10 bg-bg-secondary/80 backdrop-blur-sm">
            <pre class="overflow-x-auto p-3 sm:p-5 font-mono text-sm sm:text-base leading-relaxed text-text-primary md:text-lg"><code>{{ step.code }}</code></pre>
            <Button
              variant="ghost"
              size="icon"
              class="absolute top-2 right-2 sm:top-3 sm:right-3 opacity-0 transition-opacity group-hover:opacity-100"
              @click="copy(step.code, index)"
              aria-label="复制"
            >
              <Check v-if="copiedIndex === index" class="h-3 w-3 sm:h-4 sm:w-4 text-success" />
              <Copy v-else class="h-3 w-3 sm:h-4 sm:w-4" />
            </Button>
          </div>
        </div>
      </div>

      <div class="mt-8 sm:mt-10 text-center">
        <p class="text-xs sm:text-sm text-text-secondary">
          {{ t('quickstart.docs_hint') }}
          <a
            href="https://github.com/huiliyi37/Tianshu-harness/blob/main/docs/user-guide.md"
            target="_blank"
            rel="noopener noreferrer"
            class="text-accent-glow hover:underline"
          >
            {{ t('quickstart.docs_link') }}
          </a>
        </p>
      </div>
    </div>
  </section>
</template>
