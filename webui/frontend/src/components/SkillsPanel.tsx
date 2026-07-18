import { useState, useEffect } from 'react'

export default function SkillsPanel() {
  const [skills, setSkills] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    fetch('/api/skills')
      .then((res) => res.json())
      .then((data) => {
        setSkills(data.skills || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="text-sm text-text-tertiary text-center py-8">加载中...</div>
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-text mb-3">技能</h3>
      {skills.length === 0 ? (
        <div className="text-sm text-text-tertiary text-center py-8">暂无技能</div>
      ) : (
        <div className="space-y-2">
          {skills.map((skill: any) => (
            <div key={skill.name} className="p-3 bg-bg-surface border border-border rounded-lg hover:border-border-light transition-colors">
              <div className="text-sm font-medium text-text">{skill.name}</div>
              <div className="text-xs text-text-tertiary mt-1">{skill.description}</div>
              {skill.version && (
                <div className="mt-2 text-xs text-text-secondary">
                  <span className="text-text-tertiary">版本: </span>{skill.version}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
