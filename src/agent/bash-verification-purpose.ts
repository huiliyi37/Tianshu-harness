import { basename } from 'node:path'
import { classifyVerificationCommand, verificationArgv } from '../tools/verification-command.js'
import { unwrapVerification } from '../tools/verification-invocation.js'
import type { VerificationMetadata } from '../tools/types.js'

/** Maven/Gradle「阶段/任务序列」的目标词前瞻——VERIFICATION_SEGMENT /
 *  NON_JS_VERIFICATION_RUNNER / kind 判定共用同一套词法，逐处换目标词组。
 *  目标词三种落点：
 *  1. 裸目标词（`mvn clean test`、`gradle testDebugUnitTest`）：目标词可在任意位置，
 *     前面排生命周期阶段（clean）或全局选项（-q/-B）都不改语义；允许 camelCase 续写
 *     （gradle 任务命名惯例 `test<Flavor>UnitTest`）。裸任务未限定模块 = 全反应堆执行。
 *  2. gradle 模块任务（`:app:test`）：token 以 `:` 开头，与 `mvn -pl` 同义——只跑
 *     反应堆子集；识别入账，scope 由 NON_JS 分支经 GRADLE_MODULE_TASK 判 unknown。
 *  3. maven plugin:goal（`surefire:test`、`checkstyle:check`）：只认精确 goal 词，
 *     不给 camelCase 续写——`compiler:testCompile` 只编译不跑测试，放行会伪造
 *     test 覆盖（白名单优于黑名单：枚举「可以」，不反向封堵已知坏名）。
 *  冒号边界要求 `:` 前是 2+ 个词字符——排除 Windows 盘符（`C:test`）与
 *  `-pl a:b` 这类参数值里的冒号。 */
const mvnGradleGoal = (goals: string): string =>
  String.raw`(?=[^;&|]*(?:\s(?:${goals})(?:[A-Z][A-Za-z0-9]*)*(?=\s|$)|\s:(?:[\w.-]*:)+(?:${goals})(?:[A-Z][A-Za-z0-9]*)*(?=\s|$)|[\w.-]{2,}:(?:${goals})(?=\s|$)))`
const MVN_GRADLE_GOALS = 'test|verify|build|check|assemble|compile|package|install'

/** 受支持运行器出现在**命令位置**（段首，可带 cd/rtk/npx 前缀）的判据。
 *  先剥离引号内容——`grep -rn "npm test" src/` 是查询，不是验证。 */
const VERIFICATION_SEGMENT = new RegExp(
  String.raw`(?:^|[;&|]\s*)(?:cd\s+[^\s;|&]+\s*&&\s*)?(?:rtk\s+(?:proxy\s+)?)?(?:(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|lint|build))\b|(?:npx\s+)?(?:node|tsx)\b[^;&|]*--test\b|(?:npx\s+)?(?:node|tsx)\b[^;&|]*(?:scripts/run-node-tests\.ts|desktop/scripts/run-tests\.ts)\b|(?:npx\s+)?(?:tsc|vitest|jest|pytest|eslint|mocha|ava)\b|cargo\s+(?:test|check)\b|go\s+(?:test|vet|build)\b|dotnet\s+(?:test|build|run)\b|(?:\./)?(?:mvn|mvnw|gradle|gradlew)\b${mvnGradleGoal(MVN_GRADLE_GOALS)})`
)

/** 非 JS 生态 runner（.NET / Maven / Gradle）的验证调用。
 *  dotnet 的目标子命令紧跟可执行名（flag 在后）：`dotnet test tests/X.csproj`。
 *  Maven/Gradle 的目标词落点见 mvnGradleGoal（裸阶段 / :module:task / plugin:goal）。
 *  项目路径等定位参数同样不改「全量」语义；只有明确的选择/过滤/跳过标志
 *  （或 gradle 模块限定任务）才表示只跑了子集（→ unknown）。 */
const NON_JS_VERIFICATION_RUNNER = new RegExp(
  String.raw`^(?:dotnet (?:test|build|run)(?:\s|$)|(?:mvn|mvnw|gradle|gradlew)\b${mvnGradleGoal(MVN_GRADLE_GOALS)})`
)
/** 选择/过滤/跳过标志：出现即表示只跑了子集（或根本没跑测试）→ unknown。
 *  含 Maven 反应堆选择器（-pl/--projects、-rf/--resume-from，及只与 -pl 搭配使用的
 *  -am/-amd/--also-make*）与测试跳过（-DskipTests/-DskipITs/-Dmaven.test.skip[.exec]）
 *  ——漏列会把「反应堆子集 / 零测试执行」误记为全量证据（失效方向：过度举证，#380 收尾）。
 *  skip 标志按词首判：`-DskipTests=false` 同样被降级——漏记是 safe side，伪造覆盖才是错侧。 */
const NON_JS_SELECTION_FLAG = /(?:^|\s)(?:--filter|--testcasefilter|--tests|--test-case-filter|-Dtest=|-pl\b|--projects\b|-rf\b|--resume-from\b|-am\b|-amd\b|--also-make\b|--also-make-dependents\b|-DskipTests\b|-DskipITs\b|-Dmaven\.test\.skip\b)/i
/** gradle 模块限定任务（`:app:test`、`:core:lib:check`）——与 `mvn -pl` 同义的
 *  反应堆子集选择；只用于 scope 降级（token 以 `:` 开头是 gradle 独有语法，
 *  maven 的 `-pl :artifact` 值只有一个冒号，不会误中）。 */
const GRADLE_MODULE_TASK = /(?:^|\s):(?:[\w.-]*:)+(?:test|verify|build|check|assemble|compile|package|install)/
/** 逐 kind 的 Maven/Gradle 归因其一：与 NON_JS_VERIFICATION_RUNNER 同词法、收窄目标词组。 */
const MVN_GRADLE_TEST = new RegExp(String.raw`^(?:mvn|mvnw|gradle|gradlew)\b${mvnGradleGoal('test|verify')}`)
const MVN_GRADLE_BUILD = new RegExp(String.raw`^(?:mvn|mvnw|gradle|gradlew)\b${mvnGradleGoal('build|assemble|compile|package|install')}`)
const MVN_GRADLE_CHECK = new RegExp(String.raw`^(?:mvn|mvnw|gradle|gradlew)\b${mvnGradleGoal('check')}`)

function containsVerificationInvocation(command: string): boolean {
  return VERIFICATION_SEGMENT.test(command.replace(/'[^']*'|"[^"]*"/g, ' '))
}

/** This parser only classifies an already executed command; it never executes it.
 *
 *  Returns null when the command is **not a verification invocation at all**
 *  (pure queries like `wc -l foo.test.ts`, `ls scripts/build-*.sh`,
 *  `gh run list --workflow=build-*.yml`). 以前记账入口用一条宽松文本正则
 *  （命令里出现 test/build/check 字样即记），于是纯查询也被记进 verification
 * 台账（blocked 一片），反过来污染交付报表（2026-10-06 实测：一轮 21 条
 * blocked 里大半是纯查询）。 */
export function classifyBashVerificationPurpose(command: string, cwd = ''): Pick<VerificationMetadata, 'scope' | 'targetFiles' | 'kind'> | null {
  command = unwrapVerification(command, cwd)?.command ?? command
  const tokens = verificationArgv(command)
  if (!tokens) {
    // 复合 shell 不能充当证据，但「段首有受支持运行器」仍是验证意图 →
    // 保留 unknown（上层标 blocked 并给写法指引）；纯查询则完全不进台账。
    return containsVerificationInvocation(command) ? { scope: 'unknown' } : null
  }
  const invocationInfo = classifyVerificationCommand(command, cwd)
  if (invocationInfo.nodeTest || invocationInfo.batchRunner) {
    return { kind: 'test', scope: invocationInfo.filtered ? 'unknown' : invocationInfo.targets.length ? 'targeted' : 'full', ...(invocationInfo.targets.length ? { targetFiles: invocationInfo.targets } : {}) }
  }
  if (tokens.some(arg => arg === '--version' || arg === '--help')) return null
  if (tokens[0] === 'rtk') { tokens.shift(); if (String(tokens[0]) === 'proxy') tokens.shift() }
  if (tokens[0] === 'rtk') return { scope: 'unknown' }
  const executable = basename((tokens[0] ?? '').replaceAll('\\', '/')).replace(/\.(?:exe|cmd|bat)$/i, '')
  const args = tokens.slice(1)
  const invocation = [executable, ...args].join(' ')
  const kind: VerificationMetadata['kind'] =
    (/^(?:(?:npm|pnpm|yarn|bun) (?:test|(?:run |run-script )?test(?::[\w-]+)?)|(?:npx )?(?:(?:node|tsx) --test|vitest(?: run)?|jest|pytest|mocha|ava)|cargo test|go test|dotnet test|python(?:3)? -m pytest|bun test|make (?:test|check))(?:\s|$)/.test(invocation) || MVN_GRADLE_TEST.test(invocation)) ? 'test'
    : /^(?:(?:npm|pnpm|yarn|bun) (?:run |run-script )?typecheck(?::[\w-]+)?|(?:npx )?tsc)(?:\s|$)/.test(invocation) ? 'typecheck'
    : /^(?:(?:npm|pnpm|yarn|bun) run lint|(?:npx )?(?:eslint|oxlint))(?:\s|$)/.test(invocation) ? 'lint'
    : (/^(?:(?:npm|pnpm|yarn|bun) run build|cargo build|go build|dotnet (?:build|run))(?:\s|$)/.test(invocation) || MVN_GRADLE_BUILD.test(invocation)) ? 'build'
    : (/^(?:cargo check|go vet)(?:\s|$)/.test(invocation) || MVN_GRADLE_CHECK.test(invocation)) ? 'check' : undefined
  // A name/tag selector proves only a subset within each selected file.
  if (kind === 'test' && /(?:^|\s)(?:--test-name-pattern|--testNamePattern|--grep|-t|-k|-m)(?:[=\s]|$)/.test(invocation)) {
    return { scope: 'unknown', kind }
  }
  const targetFiles = [...new Set(args.filter(arg => !arg.startsWith('-')
    && /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|sh)$/.test(arg)))]
  // 只有识别出受支持运行器，路径参数才算「目标文件」——否则 `wc -l foo.test.ts`
  // 也会被当成 targeted 验证（旧行为，台账污染的来源之一）。
  if (kind && targetFiles.length > 0) return { scope: 'targeted', targetFiles, kind }

  // Full describes an unfiltered invocation, not proof of every suite's
  // coverage. Unknown scripts and selectors retain unknown scope.
  if (/^(?:npm|pnpm|yarn|bun) (?:test|run test)$/.test(invocation)
    || /^(?:node|tsx) --test$/.test(invocation)
    || /^(?:npx )?(?:vitest(?: run)?|jest|pytest)$/.test(invocation)
    || /^(?:cargo test|go test \.\/\.\.\.)$/.test(invocation)) return { scope: 'full', kind: 'test' }
  if (/^(?:npm|pnpm|yarn|bun) run typecheck$/.test(invocation)
    || /^(?:npx )?tsc(?: --noEmit)?$/.test(invocation)) return { scope: 'full', kind: 'typecheck' }
  if (/^(?:npm|pnpm|yarn|bun) run lint$/.test(invocation)) return { scope: 'full', kind: 'lint' }
  if (/^(?:npm|pnpm|yarn|bun) run build$/.test(invocation)
    || /^go build \.\/\.\.\.$/.test(invocation)) return { scope: 'full', kind: 'build' }
  if (/^(?:cargo check|go vet \.\/\.\.\.)$/.test(invocation)) return { scope: 'full', kind: 'check' }
  // 非 JS 生态 runner：项目路径等定位参数不改变「全量」语义；带选择/过滤/跳过标志，
  // 或 gradle 模块限定任务（`:app:test` 与 `mvn -pl` 同义），才是只跑了反应堆子集。
  if (NON_JS_VERIFICATION_RUNNER.test(invocation)) {
    return NON_JS_SELECTION_FLAG.test(invocation) || GRADLE_MODULE_TASK.test(invocation)
      ? { scope: 'unknown', kind }
      : { scope: 'full', kind }
  }
  // 仍未识别出 kind：区分「验证意图但归因不了」与「根本不是验证」。
  // 前者（`custom node --test a.test.ts`、`node --test --unknown`）要留在台账里
  // 标 blocked 并给写法指引；后者（wc / ls / grep / sed / gh run list）不得进台账。
  const hasTestFlag = args.some(arg => arg === '--test' || arg.startsWith('--test='))
  return kind || hasTestFlag || containsVerificationInvocation(command) ? { scope: 'unknown', ...(kind ? { kind } : {}) } : null
}
