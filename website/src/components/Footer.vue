<script setup lang="ts">
import { Github } from 'lucide-vue-next'
import { useI18n } from '@/composables/useI18n'

const { t } = useI18n()
const currentYear = new Date().getFullYear()
</script>

<template>
  <footer class="border-t border-white/5 bg-bg-primary px-6 py-16">
    <div class="mx-auto flex max-w-7xl flex-col items-center justify-between gap-8 md:flex-row">
      <div class="flex items-center gap-3 text-base text-text-secondary">
        <div class="flex h-8 w-8 items-center justify-center overflow-hidden shadow-md shadow-accent/20">
          <img src="/app-icon.png" alt="天枢" class="h-8 w-8 object-cover" />
        </div>
        <span class="font-medium text-text-primary">天枢 / TianShu</span>
        <span class="hidden sm:inline">·</span>
        <span class="hidden sm:inline">© {{ currentYear }}</span>
      </div>

      <nav class="flex flex-wrap items-center justify-center gap-8 text-base text-text-secondary">
        <a href="#features" class="hover:text-text-primary transition-colors">
          {{ t('footer.features') }}
        </a>
        <a href="#download" class="hover:text-text-primary transition-colors">
          {{ t('footer.download') }}
        </a>
        <a href="#quickstart" class="hover:text-text-primary transition-colors">
          {{ t('footer.quickstart') }}
        </a>
        <a
          href="https://github.com/huiliyi37/Tianshu-harness/blob/main/CONTRIBUTING.md"
          target="_blank"
          rel="noopener noreferrer"
          class="hover:text-text-primary transition-colors"
        >
          {{ t('footer.contributing') }}
        </a>
        <a
          href="https://github.com/huiliyi37/Tianshu-harness/blob/main/LICENSE"
          target="_blank"
          rel="noopener noreferrer"
          class="hover:text-text-primary transition-colors"
        >
          {{ t('footer.license') }}
        </a>
      </nav>

      <a
        href="https://github.com/huiliyi37/Tianshu-harness"
        target="_blank"
        rel="noopener noreferrer"
        class="text-text-secondary hover:text-text-primary transition-colors"
        aria-label="GitHub"
      >
        <Github class="h-6 w-6" />
      </a>
    </div>
  </footer>
</template>
