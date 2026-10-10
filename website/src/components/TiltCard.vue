<script setup lang="ts">
import { ref, type HTMLAttributes } from 'vue'
import { usePrefersReducedMotion } from '@/composables/usePrefersReducedMotion'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()

const cardRef = ref<HTMLDivElement | null>(null)
const prefersReducedMotion = usePrefersReducedMotion()

function onMouseMove(e: MouseEvent) {
  if (prefersReducedMotion.value || !cardRef.value) return
  const card = cardRef.value
  const rect = card.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const centerX = rect.width / 2
  const centerY = rect.height / 2
  const rotateX = ((y - centerY) / centerY) * -8
  const rotateY = ((x - centerX) / centerX) * 8

  card.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`
  card.style.setProperty('--glow-x', `${(x / rect.width) * 100}%`)
  card.style.setProperty('--glow-y', `${(y / rect.height) * 100}%`)
}

function onMouseLeave() {
  if (!cardRef.value) return
  cardRef.value.style.transform = 'perspective(800px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)'
}
</script>

<template>
  <div
    ref="cardRef"
    :class="['group relative transition-transform duration-200 ease-out', props.class]"
    @mousemove="onMouseMove"
    @mouseleave="onMouseLeave"
    style="transform-style: preserve-3d"
  >
    <!-- Glossy highlight layer -->
    <div
      class="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
      :style="{
        background: 'radial-gradient(circle at var(--glow-x, 50%) var(--glow-y, 50%), rgba(129, 140, 248, 0.15) 0%, transparent 60%)',
      }"
    />
    <slot />
  </div>
</template>
