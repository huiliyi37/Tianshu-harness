<script setup lang="ts">
import { ref } from 'vue'
import { Check, Copy, Download, Terminal, Github } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import { useI18n } from '@/composables/useI18n'
import Galaxy from '@/components/Galaxy.vue'

const installCommand = 'npm install -g tianshu-tui && rivet'
const copied = ref(false)
const { t } = useI18n()

async function copyInstall() {
  await navigator.clipboard.writeText(installCommand)
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 2000)
}
</script>

<template>
  <section class="relative min-h-screen overflow-hidden bg-bg-primary">
    <!-- Galaxy background -->
    <div class="pointer-events-none absolute inset-0">
      <Galaxy
        :density="1"
        :glow-intensity="0.35"
        :saturation="0"
        :speed="0.8"
        :star-speed="0.4"
        :mouse-repulsion="true"
        :repulsion-strength="2.5"
        :twinkle-intensity="0.15"
        :rotation-speed="0.05"
      />
      <div class="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-bg-primary" />
    </div>

    <div class="relative mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center px-6 pt-28 pb-32 text-center">
      <!-- Badge -->
      <div
        class="mb-8 inline-flex animate-fade-in-up items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-1.5 py-1 pr-4 text-sm text-white/70 opacity-0 backdrop-blur-md"
        style="animation-delay: 0.1s"
      >
        <span class="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-bg-primary">
          NEW
        </span>
        <span>{{ t('hero.badge') }}</span>
      </div>

      <!-- Headline -->
      <h1
        class="mb-6 animate-fade-in-up text-5xl font-semibold tracking-tight text-white opacity-0 md:text-7xl lg:text-8xl"
        style="animation-delay: 0.2s"
      >
        <span class="hero-gradient-title block">{{ t('hero.title') }}</span>
      </h1>

      <!-- Subtitle -->
      <p
        class="mx-auto mb-4 max-w-2xl animate-fade-in-up text-xl text-white/60 opacity-0 md:text-2xl"
        style="animation-delay: 0.3s"
      >
        {{ t('hero.subtitle') }}
      </p>

      <!-- Description -->
      <p
        class="mx-auto mb-10 max-w-2xl animate-fade-in-up text-base text-white/40 opacity-0 md:text-lg"
        style="animation-delay: 0.35s"
      >
        {{ t('hero.desc') }}
      </p>

      <!-- CTA buttons -->
      <div
        class="mb-12 flex flex-col items-center justify-center gap-4 sm:flex-row animate-fade-in-up opacity-0"
        style="animation-delay: 0.4s"
      >
        <Button
          size="lg"
          href="https://github.com/huiliyi37/Tianshu-harness"
          target="_blank"
          rel="noopener noreferrer"
          class="h-12 rounded-full px-8 text-base bg-white text-bg-primary hover:bg-white/90"
        >
          <Github class="mr-2 h-5 w-5" />
          {{ t('nav.github') }}
        </Button>
        <Button
          variant="outline"
          size="lg"
          href="#quickstart"
          class="h-12 rounded-full px-8 text-base border-white/10 bg-white/[0.03] text-white hover:bg-white/10 hover:text-white"
        >
          {{ t('hero.learn_more') }}
        </Button>
      </div>

      <!-- Command bar -->
      <div
        class="mx-auto w-full max-w-2xl animate-fade-in-up opacity-0"
        style="animation-delay: 0.5s"
      >
        <div class="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-2 py-2 pl-5 backdrop-blur-md">
          <Terminal class="h-4 w-4 shrink-0 text-white/40" />
          <code class="flex-1 truncate text-left font-mono text-sm text-white/80">
            <span class="text-white/40">$</span> {{ installCommand }}
          </code>
          <Button
            variant="ghost"
            size="icon"
            class="h-9 w-9 shrink-0 rounded-full text-white/60 hover:bg-white/10 hover:text-white"
            @click="copyInstall"
            aria-label="Copy install command"
          >
            <Check v-if="copied" class="h-4 w-4 text-success" />
            <Copy v-else class="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            href="https://github.com/huiliyi37/Tianshu-harness/releases"
            target="_blank"
            rel="noopener noreferrer"
            class="hidden h-9 rounded-full bg-white px-4 text-sm text-bg-primary hover:bg-white/90 sm:inline-flex"
          >
            <Download class="mr-1.5 h-4 w-4" />
            {{ t('hero.cta_download') }}
          </Button>
        </div>
        <p class="mt-3 text-sm text-white/40">
          {{ t('hero.install_hint') }}
          <a href="#download" class="text-white/70 hover:text-white hover:underline">
            {{ t('hero.download_desktop') }}
          </a>
        </p>
      </div>
    </div>
  </section>
</template>
