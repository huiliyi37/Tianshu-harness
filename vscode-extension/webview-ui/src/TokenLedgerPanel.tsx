import { useEffect, useRef, useState } from 'react'
import { onHostMessage, send, type TokenLedgerReceipt, type TokenLedgerSnapshot } from './bridge.js'

let nextRequestId = 0
const number = (value: number) => value.toLocaleString('en-US')
const date = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '尚无'

function receiptText(receipt?: TokenLedgerReceipt): string {
  if (!receipt) return '尚未同步'
  if (receipt.ok) return '成功'
  if (receipt.status === 401 || receipt.status === 403) return '密钥无效或已撤销，请重新设置同步密钥'
  if (receipt.code === 'timeout') return '连接超时，请稍后重试'
  if (receipt.code === 'network') return '网络连接失败，请稍后重试'
  if (receipt.code === 'http_4xx') return '请求被拒绝，请检查同步设置'
  return '同步失败，请稍后重试'
}

export function TokenLedgerPanel() {
  const [snapshot, setSnapshot] = useState<TokenLedgerSnapshot | null>(null)
  const [busy, setBusy] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [autoSync, setAutoSync] = useState(false)
  const [interval, setInterval] = useState('30')
  const [endpoint, setEndpoint] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [enabled, setEnabled] = useState(true)
  const pending = useRef<{ id: number; mutation: boolean } | null>(null)

  const request = (type: string, fields: Record<string, unknown> = {}) => {
    if (pending.current) return
    const requestId = ++nextRequestId
    pending.current = { id: requestId, mutation: type !== 'getTokenLedger' }
    setBusy(true)
    setError('')
    setMessage('')
    send({ type, requestId, ...fields })
  }

  useEffect(() => {
    const off = onHostMessage(msg => {
      if ((msg.type !== 'tokenLedger' && msg.type !== 'tokenLedgerResult') || msg.requestId !== pending.current?.id) return
      if (msg.type === 'tokenLedger') {
        setSnapshot({ summary: msg.summary, status: msg.status, settings: msg.settings })
        setUnavailable(false)
        setAutoSync(msg.settings.forum.autoSync)
        setInterval(String(msg.settings.forum.intervalMinutes))
        setEndpoint(msg.settings.forum.endpoint)
        setDeviceName(msg.settings.deviceName)
        setEnabled(msg.settings.enabled)
        if (!pending.current.mutation) { pending.current = null; setBusy(false) }
      } else {
        pending.current = null
        setBusy(false)
        setUnavailable(msg.unavailable === true)
        if (msg.ok) setMessage(msg.message ?? '已完成。')
        else setError(msg.message ?? '账本操作失败，请重试。')
      }
    })
    request('getTokenLedger')
    return () => { off(); pending.current = null }
  }, [])

  const save = () => {
    const minutes = Number(interval)
    if (!/^\d+$/.test(interval.trim()) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) {
      setError('同步间隔必须是 1–1440 的正整数分钟。')
      return
    }
    try {
      const url = new URL(endpoint.trim())
      if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error()
    } catch {
      setError('请输入有效的同步端点，不得包含密钥、查询参数或登录信息。')
      return
    }
    request('saveTokenLedgerSettings', { enabled, deviceName: deviceName.trim(), forum: { endpoint: endpoint.trim(), autoSync, intervalMinutes: minutes } })
  }

  const keyConfigured = snapshot?.settings.forum.apiKeyConfigured === true
  const totals = snapshot?.summary.totals
  const allTime = snapshot?.summary.allTime
  const status = snapshot?.status
  const disabled = busy || unavailable || !snapshot
  return (
    <section className="settings-block token-ledger" aria-labelledby="token-ledger-title" aria-busy={busy}>
      <h3 id="token-ledger-title">Token 账本</h3>
      <p>默认只保存在本机。立即同步或开启自动同步后，才上传 Token 计数、模型名与设备信息。</p>
      {busy && !snapshot && <p role="status">正在读取本地账本…</p>}
      {totals && allTime && <>
        <dl className="ledger-totals">
          <dt>最近 {snapshot.summary.windowDays} 天 · 总 Token</dt><dd>{number(totals.input + totals.output)}</dd>
          <dt>全部累计 · 总 Token</dt><dd>{number(allTime.input + allTime.output)}</dd>
          <dt>输入 / 输出</dt><dd>{number(totals.input)} / {number(totals.output)}</dd>
          <dt>缓存读取（已含在输入）</dt><dd>{number(totals.cacheRead)}</dd>
          <dt>缓存创建（已含在输入）</dt><dd>{number(totals.cacheCreate)}</dd>
          <dt>计费请求</dt><dd>{number(totals.requests)}</dd>
          <dt>估算计价值</dt><dd>{totals.cost.toFixed(4)}</dd>
        </dl>
        <p>按各模型原始计价单位汇总，可能混合币种，不是统一费用或账单；未定价模型不计入。</p>
      </>}
      {status && <dl className="ledger-status">
        <dt>同步状态</dt><dd>{status.pending ? '有本地变更待同步' : '无待同步变更'}</dd>
        <dt>最近成功</dt><dd>{date(status.lastPushAt)}</dd>
        <dt>最近尝试</dt><dd>{date(status.lastPushResult?.at)} · {receiptText(status.lastPushResult)}</dd>
        <dt>自动同步运行状态</dt><dd>{status.autoSync ? '定时器运行中' : snapshot.settings.forum.autoSync ? '已开启，等待定时器启动' : '关闭'}</dd>
      </dl>}
      {snapshot && <div className="ledger-form">
        <label className="ledger-checkbox"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={disabled} />记录本地账本</label>
        <label>设备名称<input value={deviceName} onChange={e => setDeviceName(e.target.value)} disabled={disabled} /></label>
        <label>同步端点<input value={endpoint} onChange={e => setEndpoint(e.target.value)} disabled={disabled} autoComplete="off" spellCheck={false} /></label>
        <p>同步密钥：{keyConfigured ? '已配置' : '未配置'}。密钥在 VS Code 密码框中输入。</p>
        <div className="settings-actions">
          <button onClick={() => request('setTokenLedgerKey')} disabled={disabled}>设置同步密钥</button>
          <button onClick={() => request('clearTokenLedgerKey')} disabled={disabled || !keyConfigured}>清除同步密钥</button>
        </div>
        <label className="ledger-checkbox"><input type="checkbox" checked={autoSync} onChange={e => setAutoSync(e.target.checked)} disabled={disabled || ((!keyConfigured || !enabled) && !autoSync)} />开启自动同步（将上传用量）</label>
        <label>同步间隔（分钟）<input value={interval} onChange={e => setInterval(e.target.value)} inputMode="numeric" disabled={disabled} /></label>
        <div className="settings-actions">
          <button onClick={save} disabled={disabled}>保存账本设置</button>
          <button onClick={() => request('syncTokenLedger')} disabled={disabled || !keyConfigured || !snapshot.settings.enabled || !status?.endpointConfigured}>立即同步</button>
        </div>
      </div>}
      <div className="settings-actions"><button onClick={() => request('getTokenLedger')} disabled={busy}>刷新账本</button></div>
      {message && <p role="status">{message}</p>}
      {error && <p className="banner error" role="alert">{error}</p>}
      {unavailable && <p>其他设置仍可正常使用。</p>}
    </section>
  )
}
