import { useState, useEffect } from 'react'
import { useStore } from '../lib/store'

export default function RulesPanel() {
  const [rules, setRules] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    fetch('/api/rules')
      .then((res) => res.json())
      .then((data) => {
        setRules(data.rules || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="text-sm text-text-tertiary text-center py-8">加载中...</div>
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-text mb-3">规则</h3>
      {rules.length === 0 ? (
        <div className="text-sm text-text-tertiary text-center py-8">暂无规则</div>
      ) : (
        <div className="space-y-2">
          {rules.map((rule: any) => (
            <div key={rule.name} className="p-3 bg-bg-surface border border-border rounded-lg">
              <div className="text-sm font-medium text-text">{rule.name}</div>
              <div className="text-xs text-text-tertiary mt-1">{rule.description}</div>
              {rule.trigger && (
                <div className="mt-2 text-xs text-text-secondary">
                  <span className="text-text-tertiary">触发: </span>{rule.trigger}
                </div>
              )}
              {rule.action && (
                <div className="mt-1 text-xs text-text-secondary">
                  <span className="text-text-tertiary">动作: </span>{rule.action}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
