<script setup lang="ts">
import { Github, BookOpen, MessageCircle, Heart, Sparkles } from 'lucide-vue-next'
import Button from '@/components/ui/Button.vue'
import Card from '@/components/ui/Card.vue'
import CardContent from '@/components/ui/CardContent.vue'
import { useScrollAnimation } from '@/composables/useScrollAnimation'
import { useI18n } from '@/composables/useI18n'

const { ref: scrollRef, isVisible } = useScrollAnimation(0.1)
const { t } = useI18n()

const cards = [
  {
    icon: Github,
    title: 'community.github',
    desc: 'community.github_desc',
    btn: 'community.github_btn',
    href: 'https://github.com/huiliyi37/Tianshu-harness',
  },
  {
    icon: BookOpen,
    title: 'community.docs',
    desc: 'community.docs_desc',
    btn: 'community.docs_btn',
    href: 'https://github.com/huiliyi37/Tianshu-harness/tree/main/docs',
  },
  {
    icon: MessageCircle,
    title: 'community.discuss',
    desc: 'community.discuss_desc',
    btn: 'community.discuss_btn',
    href: 'https://github.com/huiliyi37/Tianshu-harness/discussions',
  },
]
</script>

<template>
  <section id="community" class="relative bg-bg-secondary px-4 sm:px-6 py-16 sm:py-24">
    <div class="pointer-events-none absolute inset-0 bg-glow opacity-30" />

    <div
      ref="scrollRef"
      :class="['relative mx-auto max-w-5xl text-center animate-on-scroll', isVisible ? 'visible' : '']"
    >
      <div class="mb-4 inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/5 px-3 py-1 text-sm text-accent-glow">
        <Sparkles class="h-4 w-4" />
        {{ t('community.badge') }}
      </div>
      <h2 class="mb-3 sm:mb-4 text-2xl sm:text-3xl font-bold tracking-tight md:text-5xl">
        {{ t('community.title') }}
      </h2>
      <p class="mx-auto mb-8 sm:mb-12 max-w-2xl text-base sm:text-lg text-text-secondary">
        {{ t('community.desc') }}
      </p>

      <div class="grid gap-4 sm:gap-6 grid-cols-1 sm:grid-cols-3 stagger-children">
        <Card
          v-for="card in cards"
          :key="card.title"
          class="shine-border border-white/10 bg-bg-primary/80 backdrop-blur-sm transition-colors hover:border-accent/30"
        >
          <CardContent class="flex flex-col items-center p-4 sm:p-6">
            <div class="mb-3 sm:mb-4 flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent/20 to-accent-purple/10 text-accent">
              <component :is="card.icon" class="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <h3 class="mb-2 font-semibold text-sm sm:text-base">{{ t(card.title) }}</h3>
            <p class="mb-3 sm:mb-4 text-xs sm:text-sm text-text-secondary">{{ t(card.desc) }}</p>
            <Button variant="secondary" size="sm" :href="card.href" target="_blank" rel="noopener noreferrer">
              {{ t(card.btn) }}
            </Button>
          </CardContent>
        </Card>
      </div>

      <div class="mt-8 sm:mt-12 inline-flex items-center gap-2 rounded-full border border-white/10 bg-bg-primary/80 px-4 py-2 text-xs sm:text-sm text-text-secondary">
        <Heart class="h-4 w-4 text-danger" />
        <span>{{ t('community.footer') }}</span>
      </div>
    </div>
  </section>
</template>
