<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { GitBranch, Network, Sparkles } from 'lucide-vue-next'

type StarDomain = '北斗七星域' | '南斗星域' | '辅星' | '附录徽记'

interface CouncilStar {
  id: string
  name: string
  english: string
  astro: string
  icon: string
  domain: StarDomain
  role: string
  description: string
  color: string
}

const stars: CouncilStar[] = [
  {
    id: 'tianshu',
    name: '天枢',
    english: 'Tianshu',
    astro: '北斗一 · Dubhe / 贪狼',
    icon: '/council-icons/tianshu.svg',
    domain: '北斗七星域',
    role: '定向 · 结构 · 判断',
    description: '星图枢纽，执中调度。在复杂中守住轴心，把意图转化为可执行、可验证、可维护的结构。全貌不是为了快，是为了对。',
    color: 'from-amber-300/24 via-orange-400/14 to-rose-400/16',
  },
  {
    id: 'tianxuan',
    name: '天璇',
    english: 'Tianxuan',
    astro: '北斗二 · Merak / 寻迹',
    icon: '/council-icons/tianxuan.svg',
    domain: '北斗七星域',
    role: '跨域视角 · 边界行走',
    description: '卡住或遇硬边界时，到无关领域找碎片求收敛。在层与层之间发现温跃层，在看似无关的领域之间找到共振。当你陷入循环，停下来，换个维度。',
    color: 'from-sky-300/24 via-cyan-300/14 to-blue-500/16',
  },
  {
    id: 'tianquan',
    name: '天权',
    english: 'Tianquan',
    astro: '北斗四 · Megrez / 文曲',
    icon: '/council-icons/tianquan.svg',
    domain: '北斗七星域',
    role: '称量 · 校准 · 执行',
    description: '秤杆上的支点。先读完代码再规划，scope check 先行，调研背书重于任务列表。每一次 tool call 都是一次称量，让选择在代码内被校准。',
    color: 'from-blue-300/24 via-indigo-400/14 to-cyan-300/16',
  },
  {
    id: 'yaoguang',
    name: '瑶光',
    english: 'Yaoguang',
    astro: '北斗七 · Alkaid / 破军别称',
    icon: '/council-icons/yaoguang.svg',
    domain: '北斗七星域',
    role: '验证 · 复现 · 反身自审',
    description: '绿非证明，复现即证。面对“已修复”“测试通过”“方案已落地”的声称，或怀疑某个机制静默失效时，独立复现、缺陷归族、静音审计。对自己刚下的结论同样保持怀疑。',
    color: 'from-lime-300/22 via-emerald-400/12 to-teal-300/16',
  },
  {
    id: 'pojun',
    name: '破军',
    english: 'Pojun',
    astro: '北斗七别称 · 先锋',
    icon: '/council-icons/pojun.svg',
    domain: '北斗七星域',
    role: '突破 · 探索 · 破旧立新',
    description: '先锋之星，率先冲入未知领地。用并行探索覆盖更多可能，把“不可能”变成“这里有一条路”。',
    color: 'from-rose-300/24 via-red-400/14 to-orange-300/16',
  },
  {
    id: 'tianfu',
    name: '天府',
    english: 'Tianfu',
    astro: '南斗令星',
    icon: '/council-icons/tianfu.svg',
    domain: '南斗星域',
    role: '守护 · 承载 · 记忆',
    description: '厚土之星。fail-closed：遇歧义大声失败而非咽下，结构是承诺。不变更不破坏既有契约，改动前确认调用方。评估每一轮改动对全局的影响，保卫整个系统，不是局部最优。',
    color: 'from-emerald-300/22 via-teal-400/12 to-stone-300/16',
  },
  {
    id: 'tianliang',
    name: '天梁',
    english: 'Tianliang',
    astro: '南斗荫星',
    icon: '/council-icons/tianliang.svg',
    domain: '南斗星域',
    role: '执行落地 · 全链路闭环',
    description: '事实锚点核验，分波节奏。执行计划、落地改动时，先归因再修复。失败不绕过，先定位根因。交付必须覆盖三项：做了什么、遗留什么、设计偏差。',
    color: 'from-yellow-300/22 via-amber-400/12 to-emerald-300/14',
  },
  {
    id: 'tianji',
    name: '天机',
    english: 'Tianji',
    astro: '南斗益算星',
    icon: '/council-icons/tianji.svg',
    domain: '南斗星域',
    role: '质疑 · 洞察 · 发现缝隙',
    description: '主智慧与变动。不是画路线图的人，而是问“这条路线图对吗”的人。证据否定假设时，放下它，实证比审美重要。',
    color: 'from-violet-300/24 via-fuchsia-400/12 to-sky-300/16',
  },
  {
    id: 'fu',
    name: '辅',
    english: 'Fu',
    astro: '北斗伴星',
    icon: '/council-icons/fu.svg',
    domain: '辅星',
    role: '认知调校 · 场域校准',
    description: 'agent 行为偏离预期、提示词需要深化、或需要诊断“为什么模型没有展现应有的深度”时，调校认知场，让星域对齐。',
    color: 'from-cyan-300/22 via-slate-200/10 to-indigo-300/16',
  },
  {
    id: 'wenqu',
    name: '文曲',
    english: 'Wenqu',
    astro: '天权别称 · 文脉徽记',
    icon: '/council-icons/wenqu.svg',
    domain: '附录徽记',
    role: '文脉 · 归档 · 表述',
    description: '作为天权的文脉侧影，承接“称量之后如何表达”。用于文档、报告、命名和知识沉淀的视觉席位。',
    color: 'from-indigo-200/22 via-blue-400/12 to-amber-200/16',
  },
  {
    id: 'huagai',
    name: '华盖',
    english: 'Huagai',
    astro: '旁星徽记 · 屏障',
    icon: '/council-icons/huagai.svg',
    domain: '附录徽记',
    role: '遮蔽 · 边界 · 静默保护',
    description: '不是主链路中的执行星，而是边界与静默保护的视觉徽记。用于提醒系统在开放探索之外仍需保留遮蔽层与安全余量。',
    color: 'from-stone-200/22 via-slate-400/12 to-teal-200/16',
  },
]

const activeIndex = ref(0)
const activeStar = computed(() => stars[activeIndex.value])
const viewportWidth = ref(1440)

const groups: StarDomain[] = ['北斗七星域', '南斗星域', '辅星', '附录徽记']

const relationships = [
  {
    title: '规划链路',
    path: ['天枢', '天权', '天梁'],
    detail: '定向之后称量规划，再分波执行。',
  },
  {
    title: '验证链路',
    path: ['天机', '瑶光', '天府'],
    detail: '先质疑前提，再复现验证，最后守住防线。',
  },
  {
    title: '突破链路',
    path: ['天璇', '破军', '天枢'],
    detail: '跨域寻路，并行探索，回到轴心收敛。',
  },
  {
    title: '调校链路',
    path: ['辅', '天权'],
    detail: '诊断偏离后重新校准执行尺度。',
  },
]

function starsInGroup(group: StarDomain) {
  return stars.filter((star) => star.domain === group)
}

function updateViewportWidth() {
  viewportWidth.value = window.innerWidth
}

onMounted(() => {
  updateViewportWidth()
  window.addEventListener('resize', updateViewportWidth, { passive: true })
})

onUnmounted(() => {
  window.removeEventListener('resize', updateViewportWidth)
})

function arcStyle(index: number) {
  const totalAngle = 168
  const startAngle = -totalAngle / 2
  const angle = startAngle + (index * totalAngle) / (stars.length - 1)
  const rad = (angle * Math.PI) / 180
  const radiusX = Math.min(680, Math.max(300, viewportWidth.value * 0.36))
  const radiusY = Math.min(390, Math.max(230, viewportWidth.value * 0.2))
  const x = Math.sin(rad) * radiusX
  const y = -Math.cos(rad) * radiusY
  const depth = Math.cos(rad)
  const scale = 0.82 + depth * 0.18

  return {
    transform: `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${angle / 3.8}deg) scale(${scale})`,
    zIndex: `${Math.round(40 + depth * 20)}`,
  }
}
</script>

<template>
  <section id="stars" class="relative isolate overflow-hidden bg-bg-primary px-6 py-24 lg:py-32">
    <div class="pointer-events-none absolute inset-0">
      <div class="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:72px_72px]" />
      <div class="absolute inset-0 bg-[radial-gradient(ellipse_70%_40%_at_50%_8%,rgba(250,204,21,0.14),transparent_65%),radial-gradient(ellipse_44%_36%_at_84%_42%,rgba(34,211,238,0.14),transparent_70%),radial-gradient(ellipse_42%_36%_at_12%_58%,rgba(16,185,129,0.12),transparent_70%)]" />
      <div class="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
    </div>

    <div class="relative mx-auto max-w-[1680px]">
      <div class="relative min-h-[760px] overflow-hidden">
        <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_54%_42%_at_50%_52%,rgba(99,102,241,0.18),transparent_62%),radial-gradient(ellipse_70%_38%_at_50%_0%,rgba(180,151,207,0.18),transparent_56%)]" />
        <div class="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-bg-primary to-transparent" />
        <div class="pointer-events-none absolute left-1/2 top-[500px] h-[780px] w-[1480px] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-white/[0.045]" />

        <button
          v-for="(star, index) in stars"
          :key="star.id"
          type="button"
          class="group absolute left-1/2 top-[505px] transition duration-300"
          :class="activeIndex === index ? 'opacity-100' : 'opacity-62 hover:opacity-100'"
          :style="arcStyle(index)"
          @click="activeIndex = index"
          @mouseenter="activeIndex = index"
        >
          <span
            :class="[
              'relative flex h-20 w-20 items-center justify-center rounded-[22px] border bg-[#07101d]/90 p-3 shadow-2xl shadow-black/50 backdrop-blur-md transition duration-300 sm:h-24 sm:w-24',
              activeIndex === index ? 'border-cyan-100/80 shadow-cyan-200/24' : 'border-white/14 group-hover:border-cyan-100/60',
            ]"
          >
            <span class="absolute inset-[3px] rounded-[19px] border border-white/10 bg-gradient-to-br from-white/12 via-transparent to-cyan-200/8" />
            <span :class="['absolute inset-0 rounded-[22px] bg-gradient-to-br opacity-0 transition duration-300', star.color, activeIndex === index ? 'opacity-32' : 'group-hover:opacity-18']" />
            <img :src="star.icon" :alt="star.name" class="relative h-full w-full object-contain opacity-95 [filter:drop-shadow(0_0_8px_rgba(226,245,255,0.55))]" />
          </span>
          <span
            class="mt-2 hidden text-center text-xs font-medium text-white/72 opacity-0 transition duration-300 group-hover:opacity-100 sm:block"
            :class="activeIndex === index ? 'opacity-100' : ''"
          >
            {{ star.name }}
          </span>
        </button>

        <div class="absolute left-1/2 top-[330px] z-10 w-[min(92%,680px)] -translate-x-1/2 text-center">
          <div class="mb-5 inline-flex items-center gap-2 rounded-full border border-violet-200/18 bg-violet-300/10 px-3 py-1 text-sm text-violet-100/88 backdrop-blur-xl">
            <Sparkles class="h-4 w-4" />
            天枢 · 星域名册 · 议事会
          </div>
          <h2 class="text-4xl font-bold text-white md:text-5xl">
            {{ activeStar.name }}
            <span class="text-2xl font-medium text-white/45 md:text-3xl">{{ activeStar.english }}</span>
          </h2>
          <p class="mt-3 text-base font-medium text-cyan-100/80">
            {{ activeStar.astro }} · {{ activeStar.role }}
          </p>
          <p class="mx-auto mt-5 max-w-xl text-base leading-7 text-white/62">
            {{ activeStar.description }}
          </p>
        </div>

        <div class="absolute bottom-10 left-1/2 z-10 flex w-[min(92%,860px)] -translate-x-1/2 flex-wrap items-center justify-center gap-3 rounded-3xl border border-white/10 bg-black/26 px-5 py-4 text-sm text-white/56 backdrop-blur-xl">
          <span v-for="group in groups" :key="group" class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5">
            {{ group }}：{{ starsInGroup(group).length }}
          </span>
        </div>
      </div>

      <div class="mt-8 rounded-[28px] border border-white/10 bg-[#0d1018]/82 p-6 backdrop-blur-xl sm:p-8">
        <div class="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <div class="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-200/16 bg-cyan-300/8 px-3 py-1 text-sm text-cyan-100/82">
              <Network class="h-4 w-4" />
              关系速览
            </div>
            <h3 class="text-3xl font-bold text-white">四条链路组成完整认知闭环</h3>
          </div>
        </div>

        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <article
            v-for="relationship in relationships"
            :key="relationship.title"
            class="rounded-[22px] border border-white/10 bg-white/[0.045] p-5"
          >
            <div class="mb-4 flex items-center gap-2 text-sm font-semibold text-amber-100/82">
              <GitBranch class="h-4 w-4" />
              {{ relationship.title }}
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <template v-for="(node, index) in relationship.path" :key="node">
                <span class="rounded-full border border-white/12 bg-black/20 px-3 py-1.5 text-sm text-white">
                  {{ node }}
                </span>
                <span v-if="index < relationship.path.length - 1" class="text-white/34">→</span>
              </template>
            </div>
            <p class="mt-4 text-sm leading-6 text-white/58">{{ relationship.detail }}</p>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>
