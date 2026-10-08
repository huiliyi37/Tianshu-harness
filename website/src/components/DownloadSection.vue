<script setup lang="ts">
import { Check, Download, Monitor, Apple } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import WindowsIcon from '@/components/icons/WindowsIcon.vue'
import LinuxIcon from '@/components/icons/LinuxIcon.vue'
import { useScrollAnimation } from '@/composables/useScrollAnimation'
import { useI18n } from '@/composables/useI18n'

interface Platform {
  icon: typeof Apple | typeof WindowsIcon
  name: string
  ext: string
  href: string
  available: boolean
}

const platforms: Platform[] = [
  { icon: Apple, name: 'macOS', ext: '.dmg', href: 'https://github.com/huiliyi37/Tianshu-harness/releases/latest', available: true },
  { icon: WindowsIcon, name: 'Windows', ext: '.exe', href: 'https://github.com/huiliyi37/Tianshu-harness/releases/latest', available: true },
  { icon: LinuxIcon, name: 'Linux', ext: '.AppImage', href: 'https://github.com/huiliyi37/Tianshu-harness/releases/latest', available: true },
]

const desktopFeatures = [
  'download.feature1',
  'download.feature2',
  'download.feature3',
  'download.feature4',
  'download.feature5',
]

const { ref: scrollRef, isVisible } = useScrollAnimation(0.1)
const { t } = useI18n()
</script>

<template>
  <section id="download" class="relative bg-bg-primary px-6 py-24">
    <div class="pointer-events-none absolute inset-0 bg-glow opacity-40" />

    <div
      ref="scrollRef"
      :class="['relative mx-auto max-w-6xl animate-on-scroll', isVisible ? 'visible' : '']"
    >
      <div class="mb-12 text-center">
        <div class="mb-4 inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/5 px-3 py-1 text-sm text-accent-glow">
          <Monitor class="h-4 w-4" />
          {{ t('download.badge') }}
        </div>
        <h2 class="mb-4 text-3xl font-bold tracking-tight md:text-5xl">
          {{ t('download.title') }}
        </h2>
        <p class="mx-auto max-w-2xl text-lg text-text-secondary">
          {{ t('download.desc') }}
        </p>
      </div>

      <div class="grid items-start gap-8 lg:grid-cols-2">
        <!-- Download cards -->
        <div class="grid gap-4 grid-cols-2 sm:grid-cols-3 stagger-children">
          <Card
            v-for="platform in platforms"
            :key="platform.name"
            :class="['shine-border border-white/10 bg-bg-secondary/50 backdrop-blur-sm', platform.available ? '' : 'opacity-70']"
          >
            <CardContent class="flex flex-col items-center p-4 sm:p-6">
              <div class="mb-3 sm:mb-4 flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent/20 to-accent-purple/10 text-accent">
                <component :is="platform.icon" class="h-5 w-5 sm:h-6 sm:w-6" />
              </div>
              <h3 class="mb-1 font-semibold text-sm sm:text-base">{{ platform.name }}</h3>
              <p class="mb-3 sm:mb-4 text-xs text-text-secondary">{{ platform.ext }}</p>
              <Button
                v-if="platform.available"
                size="sm"
                :href="platform.href"
                target="_blank"
                rel="noopener noreferrer"
                class="w-full text-xs sm:text-sm"
              >
                <Download class="mr-1.5 h-3 w-3 sm:h-4 sm:w-4" />
                {{ t('download.btn') }}
              </Button>
              <Button
                v-else
                size="sm"
                variant="outline"
                class="w-full text-xs sm:text-sm"
                disabled
              >
                {{ t('download.coming_soon') }}
              </Button>
            </CardContent>
          </Card>
        </div>

        <!-- Feature list -->
        <Card class="shine-border border-white/10 bg-bg-secondary/50 backdrop-blur-sm">
          <CardContent class="p-6 md:p-8">
            <h3 class="mb-6 text-xl font-semibold">{{ t('download.features_title') }}</h3>
            <ul class="space-y-4">
              <li v-for="item in desktopFeatures" :key="item" class="flex items-start gap-3">
                <div class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-success mt-0.5">
                  <Check class="h-3 w-3" />
                </div>
                <span class="text-text-secondary">{{ t(item) }}</span>
              </li>
            </ul>

            <div class="mt-8 rounded-xl border border-white/10 bg-bg-tertiary p-4">
              <div class="flex items-center justify-between rounded-lg bg-bg-secondary p-3">
                <div>
                  <div class="text-sm font-medium">重构认证模块</div>
                  <div class="text-xs text-text-secondary">phase: verifying</div>
                </div>
                <span class="rounded-full bg-warning/10 px-2 py-1 text-xs text-warning">
                  审批中
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  </section>
</template>
