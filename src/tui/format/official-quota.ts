import type { OfficialCustomerView } from '../../models/official-contract.js'

export function formatCustomerQuotaBar(view: OfficialCustomerView): string {
  if (view.mode === 'payg') return `余额 ${view.moneyBalance.amount} ${view.moneyBalance.currency}`
  if (view.mode !== 'package' || view.quotaBar.percent === null || view.quotaBar.state === 'unavailable') return '额度暂不可查'
  const filled = Math.floor(view.quotaBar.percent / 10)
  const label = view.quotaBar.percent === 0 && view.quotaBar.state === 'low' ? '不足1%' : `${view.quotaBar.percent}%`
  return `额度 [${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${label}`
}
