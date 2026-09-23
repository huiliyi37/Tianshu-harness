import type { SearchResult } from '../../types.js'

/**
 * cn.bing.com 真实 SERP 样本（2026-09-23 本机实测，联通网络直连）。
 *
 * 采集方式：脚本请求 `https://cn.bing.com/search?q=…`（Chrome UA +
 * `Accept-Language: zh-CN,zh;q=0.9,en;q=0.8`），解析 `b_algo` 块的
 * h2 标题与摘要，逐字记录（snippet 按 60 字符截断，含'…'标记）。
 *
 * 用途：`looksOffTopic` 判据的回归基线——判据是「过半数」形式，
 * 条数影响判定，故每组保留**完整 10 条**批。
 *
 * 注意：url 为占位（采集时未存），判据不消费 url（见 relevance.ts 注释）。
 */

export interface SerpSample {
  query: string
  results: SearchResult[]
}

/**
 * 相关批：结果覆盖多个查询词——判据必须放行（放行业 = false）。
 * 三组分别是 2/2/3 个查询词的正常中文查询。
 */
export const RELEVANT_SERPS: SerpSample[] = [
  {
    query: "量子计算 原理",
    results: [
    { title: "彻底读懂量子计算机背后的原理 - 知乎", url: 'https://example.com/r0', snippet: "2021年6月15日 你或许听说过这样一种说法，量子计算机是一种「违背常识的」机器——通过在不同的 平行宇宙 中「计算」…" },
    { title: "一文读懂：量子计算—未来的算力 - 知乎", url: 'https://example.com/r1', snippet: "2026年5月19日 量子计算是基于量子力学原理的一种新型计算方式。 它与 经典计算 方法—传统的比特（bit）的不同之…" },
    { title: "量子计算（遵循量子力学规律的计算模式）_百度百科", url: 'https://example.com/r2', snippet: "2023年12月26日 量子计算（Quantum Computing，QC），是一种遵循量子力学规律调控量子信息单元进行…" },
    { title: "量子计算详解：从原理到应用的完整指南", url: 'https://example.com/r3', snippet: "2026年4月26日 文章系统介绍了量子计算原理、硬件路线（超导/光量子/离子阱等）、算法应用（Shor/Grover算…" },
    { title: "一文看懂量子计算：原理、应用、行业现状-36氪", url: 'https://example.com/r4', snippet: "2019年1月28日 现在，包括D-Wave Systems、阿里巴巴、IBM和Rigetti Quantum Comp…" },
    { title: "量子计算原理与应用-CSDN博客", url: 'https://example.com/r5', snippet: "2017年10月25日 文章浏览阅读7.2w次，点赞18次，收藏80次。 本文介绍了量子计算的基本原理，包括量子比特的特…" },
    { title: "量子计算机_百度百科", url: 'https://example.com/r6', snippet: "量子计算机是一种可以实现量子计算的机器，它通过量子力学规律实现数学和逻辑运算，处理和储存信息。 理论上，它是一个物理系 …" },
    { title: "什么是量子计算？| IBM", url: 'https://example.com/r7', snippet: "2025年6月10日 量子计算的定义 量子计算是计算机科学与工程的新兴领域，利用量子力学特性解决即便最强大经典计算机也无…" },
    { title: "量子计算的基本原理是什么？ - 知乎", url: 'https://example.com/r8', snippet: "2024年5月16日 量子计算的基本原理是量子力学的五大基本假设，分别为 1.指微观体系的 运动状态 由相应的归一化 波…" },
    { title: "怎么通俗的解释量子计算机的工作原理？ - 知乎", url: 'https://example.com/r9', snippet: "现在，让我们进入量子世界，那里的一切规则都和我们熟悉的宏观世界不太一样。 在量子世界里，有一个神奇的现象叫做“叠加态”，…" },
    ],
  },
  {
    query: "杭州西湖 门票预约",
    results: [
    { title: "2026杭州西湖景区门票预约购买入口汇总（持续更新）", url: 'https://example.com/r0', snippet: "2026年9月16日 杭州本地宝杭州旅游提供2026杭州西湖景区门票预约购买入口汇总（持续更新）有关的信息，1985年，…" },
    { title: "2026杭州西湖景区预约指南 (附图解)- 杭州本地宝", url: 'https://example.com/r1', snippet: "2026年3月24日 杭州本地宝杭州旅游频道提供2026杭州西湖景区预约指南 (附图解)有关的信息，春日与美景不可辜负，…" },
    { title: "2026杭州西湖景区门票预约购买入口汇总 (持续更新)- 杭州 ...", url: 'https://example.com/r2', snippet: "6 天之前 温馨提示：微信搜索关注公众号【杭州本地宝】，在对话框回复【中秋国庆】获取杭州中秋国庆放假调休、寺庙游玩、热门…" },
    { title: "2026杭州西湖景区门票预约购买入口汇总 (持续更新)", url: 'https://example.com/r3', snippet: "2026年4月17日 2026杭州西湖景区门票预约购买入口汇总（持续更新） 2026-03-24 17:14 杭州本地宝…" },
    { title: "杭州西湖门票需要预约吗？2026最新预约政策与避坑指南", url: 'https://example.com/r4', snippet: "杭州西湖门票需要预约吗？2026最新预约政策与避坑指南-杭州西湖门票需要预约吗？2026最新预约政策与避坑指南 很多游客…" },
    { title: "2026杭州西湖景区预约指南(附图解)- 杭州本地宝", url: 'https://example.com/r5', snippet: "2026年7月28日 ①、关注“杭州西湖西溪景区”，然后点击菜单栏“当地玩乐”-“预约购票平台”，进入西湖景区预约页面。…" },
    { title: "杭州西湖门票多少钱？景区攻略+免费入口全揭秘！", url: 'https://example.com/r6', snippet: "2025年9月16日 杭州西湖是国家5A级旅游景区，被誉为“人间天堂”。 许多人关心“西湖门票贵不贵”“哪些地方要收费”…" },
    { title: "2026杭州西湖景区预约指南 (附图解)- 杭州本地宝", url: 'https://example.com/r7', snippet: "2026年9月15日 ①、关注“杭州西湖西溪景区”，然后点击菜单栏“当地玩乐”-“预约购票平台”，进入西湖景区预约页面。…" },
    { title: "去杭州西湖旅游需要预约吗？一篇讲清免费区、收费点与预约 ...", url: 'https://example.com/r8', snippet: "游览杭州西湖本身不需要预约，因为其主体景区（包括苏堤、白堤、湖滨公园等）自2003年起就实行免费开放政策，它是中国首个免…" },
    { title: "2024杭州西湖景区预约指南（附图解） - Manmankan", url: 'https://example.com/r9', snippet: "2024年2月1日 ①关注微信公众号“西湖旅游”，点击菜单栏“预约购票”-“景点购票”，进入西湖景点预约页面。 ②上下滑…" },
    ],
  },
  {
    query: "上海 天气 预报",
    results: [
    { title: "上海天气预报,上海7天天气预报,上海15天天气预报,上海天气查询", url: 'https://example.com/r0', snippet: "2 小时之前 上海天气预报，及时准确发布中央气象台天气信息，便捷查询上海今日天气，上海周末天气，上海一周天气预报，上海蓝…" },
    { title: "【上海天气预报】上海天气预报一周,上海天气预报15天,30天 ...", url: 'https://example.com/r1', snippet: "2 小时之前 天气网提供上海天气预报15天,30天,今日天气,明天天气,上海未来一周的天气预报,上海天气,上海实时天气查…" },
    { title: "上海-天气预报", url: 'https://example.com/r2', snippet: "1 天前 Created with Highcharts 温度 (C) 降水 (mm) 1981年-2010年（上海）月…" },
    { title: "今日天气-上海市气象局", url: 'https://example.com/r3', snippet: "当前位置： 首页 &gt; 上海市气象局 &gt; 气象服务 &gt; 今日天气 灾害天气预警 上海今日天气 上海中心气…" },
    { title: "【上海天气】上海40天天气预报,上海更长预报,上海天气日历 ...", url: 'https://example.com/r4', snippet: "2 小时之前 16-40天预报数据来源于国家气候中心，是根据全球数值天气预报模式客观预报系统加工而成，未经预报员主观订正…" },
    { title: "上海 天气预报15天", url: 'https://example.com/r5', snippet: "2 小时之前 上海天气网提供上海天气预报15天，上海天气预报15天查询，上海未来15天天气预报，通过上海天气预报15天查…" },
    { title: "上海天气", url: 'https://example.com/r6', snippet: "2 小时之前 上海迪士尼乐园拥有七大主题园区：米奇大街、奇想花园、探险岛、宝藏湾、明日世界、梦幻世界、玩具总 动员 ；两…" },
    { title: "上海市天气预报24小时 - 上海天气预报未来15天", url: 'https://example.com/r7', snippet: "2 小时之前 上海市的实时天气状况，上海天气预报24小时详情分阶段统计图。未来十五天天气数据列表内含上海天气预报一周查询…" },
    { title: "【上海市天气预报15天】_上海市天气预报15天查询 - 预报查询 ...", url: 'https://example.com/r8', snippet: "1 天前 ★墨迹天气★提供【上海市】15天天气预报查询，让你及时了解【上海市】半月天气，助您放心出行。 弱 紫外线 较易…" },
    { title: "【上海天气预报】上海天气预报一周,15天,30天天气查询 ...", url: 'https://example.com/r9', snippet: "2 小时之前 2345天气预报提供上海天气预报，未来上海15天天气，通过2345天气预报详细了解上海天气预报以及上海周边…" },
    ],
  },
]

/**
 * 降级/低质批：结果只覆盖查询中最泛的单个词——判据必须拦截（判跑题 = true）。
 *
 * 前四组是 cn.bing.com 对脚本请求的降级返回（只匹配查询中最泛的词：
 * 「量子」「美国」「苹果」），第五组 `TypeScript 类型体操 教程` 是边界样本 ——
 * 结果全部只覆盖 "typescript" 一个词，核心限定词「类型体操」零命中，
 * 按新判据同样计为跑题（走低置信兜底路径，见 tool.ts）。
 */
export const LOW_QUALITY_SERPS: SerpSample[] = [
  {
    query: "量子计算 原理 区别 应用",
    results: [
    { title: "量子（现代物理概念）_百度百科", url: 'https://example.com/r0', snippet: "“量子” 是微观世界能量、物质的最小离散基本单元，是现代量子理论的核心基础概念。 对“量子”的最早研究始于1900 年，…" },
    { title: "潘建伟院士：一分钟说清楚什么是量子 - 知乎", url: 'https://example.com/r1', snippet: "2026年2月4日 光子虽无 静质量，却携带 动量 与能量，参与相互作用时表现出粒子性。 原子 、分子乃至我们自身，归根…" },
    { title: "量子究竟是什么？一文搞懂，拒绝被坑 - 知乎", url: 'https://example.com/r2', snippet: "2020年10月16日 原子、质子、电子都是构成物质的实物粒子，可量子却不是粒子，它是一种物理概念，不是实物。 在微观世…" },
    { title: "量子力学（描述微观尺度物质的基本物理规律的物理学理论 ...", url: 'https://example.com/r3', snippet: "2025年10月7日 量子力学是描述微观尺度物质的基本物理规律的物理学理论。 量子力学的现象与经典力学不同，它用概率来描…" },
    { title: "什么是量子科技？都有哪些应用？一文了解_新闻频道_央视网 ...", url: 'https://example.com/r4', snippet: "2025年9月21日 量子科技的三大主要应用包括，量子计算、量子通信和量子精密测量。 去看一台我国比特数最高的超导量子计…" },
    { title: "量子 _ 百科", url: 'https://example.com/r5', snippet: "一个物理量如果存在 最小的 不可分割的基本单位，则这个物理量是量子化的，并把最小单位称为量子。 量子英文名称量子一词来自…" },
    { title: "量子是什么？哪些事物符合量子的定义？ - 知乎", url: 'https://example.com/r6', snippet: "“量子”这个词之于“量子力学”，就跟“欧式几何”里的“欧几里得”差不多。 我们会说：“一个量子理论”、“量子微扰论”、“…" },
    { title: "量子，究竟是个啥？", url: 'https://example.com/r7', snippet: "2020年10月20日 首先，直截了当地抛出量子（quantum）的概念：科普中国科学百科对量子的定义是——现代物理的重…" },
    { title: "量子力学中的 “量子” 到底什么意思？是一种基本粒子吗 ...", url: 'https://example.com/r8', snippet: "2025年10月23日 就像 “硬币” 是具体的物体，而 “一元” 是描述硬币面值的单位，“量子” 更接近 “单位” 的…" },
    { title: "量子，究竟是什么？ _光明网", url: 'https://example.com/r9', snippet: "2026年2月26日 物理学家正全力以赴地寻找能够统一宏观与微观的量子引力理论。 与此同时，日益精密的实验也在不断探索经…" },
    ],
  },
  {
    query: "美国 AI 实验室",
    results: [
    { title: "美国（美国）_百度百科", url: 'https://example.com/r0', snippet: "百度百科是一部内容开放、自由的网络百科全书，旨在创造一个涵盖所有领域知识，服务所有互联网用户的中文知识性百科全书。在这 …" },
    { title: "美国历史（美利坚合众国的发展历史）_百度百科", url: 'https://example.com/r1', snippet: "美国历史是美利坚合众国自殖民时期至现代的发展历程。 北美洲原始居民为印第安人。 16世纪起欧洲殖民者开始在北美建立定居 …" },
    { title: "中文 (中国) - United States Department of State", url: 'https://example.com/r2', snippet: "2026年9月16日 订阅 中文翻译 宣布对与太子集团跨国犯罪组织及其他诈骗美国人的团伙有关联的32名个人实施签证限制的…" },
    { title: "国家概况_中华人民共和国外交部", url: 'https://example.com/r3', snippet: "2025年，美国前五大货物贸易伙伴为墨西哥、加拿大、中国、德国、日本。 美国前五大货物和服务出口市场为加拿大、墨西哥、英…" },
    { title: "美国（美利坚合众国）_百度百科", url: 'https://example.com/r4', snippet: "2019年2月28日 美国原为印第安人的聚居地，15世纪末，西班牙、荷兰、法国、英国等相继移民至此。 18世纪前，英国在…" },
    { title: "美国50州分布图、重要城市分布图、大学分布图、NBA球队 ...", url: 'https://example.com/r5', snippet: "5 天之前 本文提供美国50州、重要城市、大学、NBA球队及著名景点的分布图，揭示美国一半人口集中生活的9个州，并列出各…" },
    { title: "美国简介 - 美国驻华大使馆和领事馆", url: 'https://example.com/r6', snippet: "2021年7月29日 此外，数百万移民从世界各地来到美国，带来各自的文化和价值观，使美国的生活更加丰富多元。 虽然美国人…" },
    { title: "美国签证服务 - 美国驻华大使馆和领事馆 - Use our new U.S ...", url: 'https://example.com/r7', snippet: "2025年10月30日 希望入境美国的外国公民通常须先获得美国签证，附在旅行者所在国签发的护照内。 特定国际旅客若符合免…" },
    { title: "浅谈美国历史：从殖民地到超级大国的240年 - 知乎", url: 'https://example.com/r8', snippet: "2025年6月16日 美国历史虽短，却充满戏剧性—— 殖民、独立、内战、崛起、称霸，每一步都深刻影响了世界格局。 本文以…" },
    { title: "国家趣谈：美国是什么样的国家？十个方面读懂这个超级大国 ...", url: 'https://example.com/r9', snippet: "2026年5月12日 美国全称美利坚合众国（the United States of America，缩写USA），面积…" },
    ],
  },
  {
    query: "美国 AI 实验室 出逃 事件 7月 智能体",
    results: [
    { title: "美国（美国）_百度百科", url: 'https://example.com/r0', snippet: "百度百科是一部内容开放、自由的网络百科全书，旨在创造一个涵盖所有领域知识，服务所有互联网用户的中文知识性百科全书。在这 …" },
    { title: "美国历史（美利坚合众国的发展历史）_百度百科", url: 'https://example.com/r1', snippet: "美国历史是美利坚合众国自殖民时期至现代的发展历程。 北美洲原始居民为印第安人。 16世纪起欧洲殖民者开始在北美建立定居 …" },
    { title: "中文 (中国) - United States Department of State", url: 'https://example.com/r2', snippet: "2026年9月16日 订阅 中文翻译 宣布对与太子集团跨国犯罪组织及其他诈骗美国人的团伙有关联的32名个人实施签证限制的…" },
    { title: "国家概况_中华人民共和国外交部", url: 'https://example.com/r3', snippet: "2025年，美国前五大货物贸易伙伴为墨西哥、加拿大、中国、德国、日本。 美国前五大货物和服务出口市场为加拿大、墨西哥、英…" },
    { title: "美国（美利坚合众国）_百度百科", url: 'https://example.com/r4', snippet: "2019年2月28日 美国原为印第安人的聚居地，15世纪末，西班牙、荷兰、法国、英国等相继移民至此。 18世纪前，英国在…" },
    { title: "美国50州分布图、重要城市分布图、大学分布图、NBA球队 ...", url: 'https://example.com/r5', snippet: "5 天之前 本文提供美国50州、重要城市、大学、NBA球队及著名景点的分布图，揭示美国一半人口集中生活的9个州，并列出各…" },
    { title: "美国简介 - 美国驻华大使馆和领事馆", url: 'https://example.com/r6', snippet: "2021年7月29日 此外，数百万移民从世界各地来到美国，带来各自的文化和价值观，使美国的生活更加丰富多元。 虽然美国人…" },
    { title: "美国签证服务 - 美国驻华大使馆和领事馆 - Use our new U.S ...", url: 'https://example.com/r7', snippet: "2025年10月30日 希望入境美国的外国公民通常须先获得美国签证，附在旅行者所在国签发的护照内。 特定国际旅客若符合免…" },
    { title: "浅谈美国历史：从殖民地到超级大国的240年 - 知乎", url: 'https://example.com/r8', snippet: "2025年6月16日 美国历史虽短，却充满戏剧性—— 殖民、独立、内战、崛起、称霸，每一步都深刻影响了世界格局。 本文以…" },
    { title: "国家趣谈：美国是什么样的国家？十个方面读懂这个超级大国 ...", url: 'https://example.com/r9', snippet: "2026年5月12日 美国全称美利坚合众国（the United States of America，缩写USA），面积…" },
    ],
  },
  {
    query: "苹果 发布会 时间 9月",
    results: [
    { title: "Apple (中国大陆) - 官方网站", url: 'https://example.com/r0', snippet: "2026年7月15日 探索 Apple 充满创新的世界，选购各式 iPhone、iPad、Apple Watch 和 M…" },
    { title: "iPhone - Apple (中国大陆)", url: 'https://example.com/r1', snippet: "2026年2月1日 iPhone 由超瓷晶面板守护，这种材质的坚固度超过玻璃或微晶玻璃面板。我们最新款的 iPhone …" },
    { title: "Apple", url: 'https://example.com/r2', snippet: "Discover the innovative world of Apple and shop everything i…" },
    { title: "iCloud", url: 'https://example.com/r3', snippet: "Log in to iCloud to access your photos, mail, notes, documen…" },
    { title: "苹果（蔷薇科苹果属植物）_百度百科", url: 'https://example.com/r4', snippet: "苹果（学名Malus pumila Mill.）是蔷薇科、苹果属植物，别称西洋苹果、柰，属于蔷薇科苹果属的植物。 苹果是…" },
    { title: "Apple (香港)", url: 'https://example.com/r5', snippet: "發掘 Apple 的創新世界，選購各款 iPhone、iPad、Apple Watch、Mac 和 Apple TV，並…" },
    { title: "苹果公司_百度百科", url: 'https://example.com/r6', snippet: "[658] 历史沿革：1976年4月，苹果由史蒂夫乔布斯、史蒂夫沃兹尼亚克、罗纳德韦恩共同创立。 1977年正式注册为苹…" },
    { title: "Apple 账户 - 官方 Apple 支持", url: 'https://example.com/r7', snippet: "2026年8月19日 Apple 账户支持 Apple 账户，以前叫作 Apple ID，可供你访问所有 Apple 服…" },
    { title: "官方 Apple 支持", url: 'https://example.com/r8', snippet: "2026年8月19日 每个 AppleCare 计划都可为你的 Apple 产品提供一站式服务。当发生跌落、液体泼溅等意…" },
    { title: "五分钟了解我国十大苹果品种 - 知乎", url: 'https://example.com/r9', snippet: "2021年3月12日 中国是苹果生产大国，苹果种类很多，那么，天天吃苹果的你，知道我国常见的苹果品种吗？ 我国常见的十大…" },
    ],
  },
  {
    query: "TypeScript 类型体操 教程",
    results: [
    { title: "TypeScript: JavaScript With Syntax For Types.", url: 'https://example.com/r0', snippet: "5 天之前 TypeScript is JavaScript with syntax for types. TypeSc…" },
    { title: "TypeScript 教程 | 菜鸟教程", url: 'https://example.com/r1', snippet: "TypeScript 教程 TypeScript 是 JavaScript 的一个超集，支持 ECMAScript 6 …" },
    { title: "typescript_百度百科", url: 'https://example.com/r2', snippet: "2026年3月23日 TypeScript是微软于2012年10月发布的开源编程语言，它是JavaScript的一个超集…" },
    { title: "TypeScript中文网 TypeScript——JavaScript的超集", url: 'https://example.com/r3', snippet: "2021年1月11日 TypeScript has helped ensure that Dojo 2 will be …" },
    { title: "TypeScript", url: 'https://example.com/r4', snippet: "2 天之前 TypeScript 是一种构建在 JavaScript 之上的强类型编程语言，提供更好的工具支持，适用于各…" },
    { title: "TypeScript 中文文档：Handbook - TypeScript 手册", url: 'https://example.com/r5', snippet: "2026年2月17日 TypeScript 手册旨在向普通程序员详细解释 TypeScript。 你可以按照左侧导航从上…" },
    { title: "《TypeScript 教程》发布了 - 阮一峰的网络日志", url: 'https://example.com/r6', snippet: "2023年8月10日 长话短说，我写了一本 《TypeScript 教程》，已经发布在 网道，欢迎大家访问。 我以前写过…" },
    { title: "TypeScript 简介 - 菜鸟教程", url: 'https://example.com/r7', snippet: "TypeScript 简介 TypeScript 是由微软开发并开源的编程语言，它是 JavaScript 的超集，在完…" },
    { title: "GitHub - microsoft/TypeScript: TypeScript is a superset of …", url: 'https://example.com/r8', snippet: "TypeScript is a language for application-scale JavaScript. T…" },
    { title: "TypeScript是什么，为什么要使用它？ - 知乎", url: 'https://example.com/r9', snippet: "2020年10月22日 目前最大的 前端框架 之一的 Angular 正在使用TypeScript，而在大约60％的前端…" },
    ],
  },
]
