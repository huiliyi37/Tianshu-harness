import type { ContinuityFailureDetails } from './continuation-prefix.js'

export function continuityGuidance(details: ContinuityFailureDetails | undefined, surface: string): string {
  if (details?.kind === 'persistence') return '本地历史保存尚未完成，后续执行已暂停。请保持会话打开，检查磁盘空间、目录权限或文件占用；存储恢复后可重试，无需删除历史或重建前缀。'
  if (details?.historyIntegrity || details?.kind === 'source_history') return surface === 'desktop'
    ? '历史证据无法核对；原会话和工作文件已保留。请导出救援副本，预览后在新会话续接；缺失内容不能靠重试恢复。'
    : '历史证据无法核对；请用 /repair-prefix --rescue 导出救援副本并预览新会话续接。原会话保留，禁止盲目回滚或重放工具。'
  const stage = details?.stage === 'transport' ? '源历史与冻结投影未变，发送层字节发生变化。'
    : details?.stage === 'render' ? '冻结投影无法与已发布字节核对。' : ''
  return stage + (surface === 'desktop'
    ? '本地连续性校验受阻，重复发送不会修复；请到 设置 → 运行时环境 →「检查运行环境」查看运行时状态，或导出救援副本并在新会话续接，原会话保留。执行绑定或源历史异常时禁止重建。'
    : '本地连续性校验受阻，重复发送不会修复；请用 /repair-prefix 检查恢复资格，或用 /repair-prefix --rescue 导出并预览新会话续接。执行绑定或源历史异常时禁止重建。')
}
