<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { Download, Github, Globe, Menu, X } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import { useI18n } from '@/composables/useI18n'

const { t, locale, setLocale } = useI18n()
const mobileOpen = ref(false)
const scrolled = ref(false)

function onScroll() {
  scrolled.value = window.scrollY > 50
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
})

onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
})

const navLinks = computed(() => [
  { href: '#features', label: t('nav.features') },
  { href: '#stars', label: t('nav.stars') },
  { href: '#demo', label: t('nav.demo') },
  { href: '#download', label: t('nav.download') },
  { href: '#quickstart', label: t('nav.docs') },
  { href: '#faq', label: t('nav.faq') },
])

function toggleLocale() {
  setLocale(locale.value === 'zh' ? 'en' : 'zh')
}
</script>

<template>
  <header
    :class="[
      'fixed top-0 left-0 right-0 z-50 transition-all duration-500',
      scrolled ? 'py-5 navbar-glass' : 'py-8',
    ]"
  >
    <nav class="mx-auto flex h-20 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
      <!-- Logo -->
      <a href="#" class="flex items-center gap-3 text-2xl font-bold tracking-tight text-white">
        <div class="flex h-12 w-12 items-center justify-center overflow-hidden shadow-lg shadow-accent/20">
          <img src="/app-icon.png" alt="天枢" class="h-12 w-12 object-cover" />
        </div>
        <span>天枢</span>
        <span class="text-white/60 text-lg font-normal hidden sm:inline">/ TianShu</span>
      </a>

      <!-- Center glass pill nav -->
      <div class="hidden md:block">
        <ul class="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-2 backdrop-blur-xl">
          <li v-for="link in navLinks" :key="link.href">
            <a
              :href="link.href"
              class="rounded-full px-6 py-2.5 text-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              {{ link.label }}
            </a>
          </li>
        </ul>
      </div>

      <!-- Right actions -->
      <div class="hidden items-center gap-3 md:flex">
        <Button
          variant="ghost"
          size="lg"
          class="rounded-full text-white/70 hover:bg-white/10 hover:text-white"
          @click="toggleLocale"
        >
          <Globe class="mr-1.5 h-5 w-5" />
          {{ locale === 'zh' ? 'EN' : '中' }}
        </Button>
        <Button
          variant="ghost"
          size="lg"
          href="https://github.com/huiliyi37/Tianshu-harness"
          target="_blank"
          rel="noopener noreferrer"
          class="rounded-full text-white/70 hover:bg-white/10 hover:text-white"
        >
          <Github class="mr-1.5 h-5 w-5" />
          GitHub
        </Button>
        <Button
          size="lg"
          href="https://github.com/huiliyi37/Tianshu-harness/releases"
          target="_blank"
          rel="noopener noreferrer"
          class="rounded-full bg-white text-bg-primary hover:bg-white/90"
        >
          <Download class="mr-1.5 h-5 w-5" />
          {{ t('download.btn') }}
        </Button>
      </div>

      <button
        class="md:hidden text-white/70 hover:text-white"
        @click="mobileOpen = !mobileOpen"
        aria-label="切换菜单"
      >
        <X v-if="mobileOpen" class="h-8 w-8" />
        <Menu v-else class="h-8 w-8" />
      </button>
    </nav>

    <div
      v-if="mobileOpen"
      class="border-t border-white/10 bg-bg-secondary/95 px-4 sm:px-6 py-4 md:hidden backdrop-blur-xl"
    >
      <ul class="flex flex-col gap-4">
        <li v-for="link in navLinks" :key="link.href">
          <a
            :href="link.href"
            class="block text-lg text-white/70 hover:text-white"
            @click="mobileOpen = false"
          >
            {{ link.label }}
          </a>
        </li>
        <li class="pt-2 flex flex-col gap-3">
          <Button
            variant="outline"
            size="lg"
            class="w-full"
            @click="() => { toggleLocale(); mobileOpen = false }"
          >
            <Globe class="mr-2 h-5 w-5" />
            {{ locale === 'zh' ? 'Switch to English' : '切换到中文' }}
          </Button>
          <Button variant="outline" size="lg" class="w-full" href="https://github.com/huiliyi37/Tianshu-harness" target="_blank" rel="noopener noreferrer">
            <Github class="mr-2 h-5 w-5" />
            GitHub
          </Button>
          <Button size="lg" class="w-full" href="https://github.com/huiliyi37/Tianshu-harness/releases" target="_blank" rel="noopener noreferrer">
            <Download class="mr-2 h-5 w-5" />
            {{ t('download.btn') }}
          </Button>
        </li>
      </ul>
    </div>
  </header>
</template>
