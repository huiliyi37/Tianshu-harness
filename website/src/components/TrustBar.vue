<script setup lang="ts">
import { Github, Scale, TestTube, GitBranch, Shield } from 'lucide-vue-next'
import { useI18n } from '@/composables/useI18n'
import { release } from '../release'

const { t } = useI18n()

const stats = [
  { icon: Github, label: t('trust.prefix_cache'), value: '95-99%', href: 'https://github.com/huiliyi37/Tianshu-harness' },
  { icon: Scale, label: t('trust.opensource'), value: release.license },
  { icon: TestTube, label: t('trust.tools'), value: '20+' },
  { icon: GitBranch, label: 'Version', value: `v${release.version}` },
  { icon: Shield, label: t('trust.models'), value: '6+' },
]
</script>

<template>
  <section id="trust" class="border-y border-white/5 bg-bg-secondary/50 px-6 pb-8 pt-16 backdrop-blur-sm">
    <div class="mx-auto max-w-6xl">
      <div class="grid grid-cols-2 gap-6 md:grid-cols-5">
        <template v-for="stat in stats" :key="stat.label">
          <a
            v-if="stat.href"
            :href="stat.href"
            target="_blank"
            rel="noopener noreferrer"
            class="group transition-colors"
          >
            <div class="flex flex-col items-center text-center">
              <div class="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <component :is="stat.icon" class="h-5 w-5" />
              </div>
              <div class="text-lg font-semibold text-text-primary">{{ stat.value }}</div>
              <div class="text-sm text-text-secondary">{{ stat.label }}</div>
            </div>
          </a>
          <div v-else>
            <div class="flex flex-col items-center text-center">
              <div class="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <component :is="stat.icon" class="h-5 w-5" />
              </div>
              <div class="text-lg font-semibold text-text-primary">{{ stat.value }}</div>
              <div class="text-sm text-text-secondary">{{ stat.label }}</div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
