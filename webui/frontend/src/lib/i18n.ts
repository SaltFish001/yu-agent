// ── Minimal i18n ──

const ZH: Record<string, string> = {
  // Sidebar
  'new.topic': '+ 新建 Topic',
  'search.topic': '搜索 topic…',
  'no.match': '无匹配 topic',
  'no.topics': '暂无 topic',
  'settings': '设置',
  'status': '系统状态',
  'create.topic.hint': '输入 topic 名称…',
  'confirm': '确认',
  'cancel': '取消',
  'open.terminal': '打开终端',
  'switch.topic': '切换到此 topic',
  'archive.topic': '归档 topic',
  'rename.topic': '重命名 topic',

  // Chat
  'input.placeholder': '输入消息… (/ 命令 / @ topic)',
  'send': '发送',
  'stop': '停止',
  'thinking': '思考中…',
  'reasoning': '推理中…',
  'reasoning.done': '推理过程',
  'loading': '加载中…',

  // Status bar
  'connected': '已连接',
  'disconnected': '已断开',
  'token': 'Token',
  'iteration': '迭代',
  'budget': '预算',
  'yu.version': 'yu v',

  // Topic context
  'current.topic': '当前主题',
  'active': '活跃',
  'background': '后台',
  'idle': '空闲',
  'error': '错误',
  'archived': '已归档',
  'topics': 'Topics',

  // Settings Modal
  'settings.title': '设置',
  'settings.general': '通用',
  'settings.theme': '主题',
  'settings.theme.dark': '深色',
  'settings.theme.light': '浅色',
  'settings.theme.auto': '跟随系统',
  'settings.lang': '语言',
  'settings.lang.zh': '中文',
  'settings.lang.en': 'English',
  'settings.model': '模型',
  'settings.default.model': '默认模型',
  'settings.agent': 'Agent',
  'settings.token.budget': 'Token 预算',
  'settings.token.budget.desc': '每次 Agent 循环的最大 Token 消耗量',
  'settings.max.iters': '最大迭代次数',
  'settings.system': '系统',
  'settings.restart': '重启服务',
  'settings.restart.confirm': '确定重启服务？',
  'settings.restarting': '重启中…',
  'settings.about': '关于',
  'settings.version': '版本',
  'settings.close': '关闭',

  // Messages
  'switch.topic.msg': '切换到主题',
  'create.topic.msg': '创建主题',
  'rename.topic.msg': '重命名主题',
  'archive.topic.msg': '归档主题',
  'load.topic.msg': '加载主题',

  // Admin page (system status)
  'admin.version': '版本',
  'admin.uptime': '运行时间',
  'admin.heap': '堆',
  'admin.ws.conn': 'WS 连接',
  'admin.agent.running': 'Agent 运行',
  'admin.completed': '完成',
  'admin.metric': '指标',
  'admin.value': '值',
  'admin.heap.usage': 'Heap 使用率',
  'admin.ws.msg': 'WS 消息',
  'admin.ws.alive': 'WS 存活',
  'admin.agent.failed': 'Agent 失败',
  'admin.avg.duration': '平均耗时',
  'admin.close': '关闭',
  'admin.tab.agents': '子Agent',
  'admin.tab.bg': '后台',
  'admin.tab.terminal': '终端',
  'admin.tab.files': '文件',
  'admin.tab.rules': '规则',
  'admin.tab.skills': '技能',

  // Terminal panel
  'term.title': '终端会话',
  'term.select.topic': '— 选择 topic —',
  'term.open': '打开终端',
  'term.refresh': '刷新',
  'term.dir': '目录',
  'term.uptime': '运行时间',
  'term.status': '状态',
  'term.action': '操作',
  'term.disconnected': '已断开',
  'term.reopen': '重新打开',
  'term.kill': '终止',
  'term.no.sessions': '无活跃终端会话',

  // Panel: Topics
  'topic.title': '主题',
  'topic.filter': '筛选主题…',
  'topic.name': '名称',
  'topic.status': '状态',
  'topic.turns': '轮次',
  'topic.last.active': '上次活跃',
  'topic.none': '无主题',

  // Panel: Background Tasks
  'bg.title': '后台任务',
  'bg.type': '类型',
  'bg.status': '状态',
  'bg.duration': '耗时',
  'bg.task': '任务',
  'bg.none': '无后台任务',

  // Panel: Rules
  'rules.title': '规则',
  'rules.name': '名称',
  'rules.trigger': '触发器',
  'rules.action': '动作',
  'rules.condition': '条件',
  'rules.none': '暂无规则',

  // Panel: Skills
  'skills.title': '技能',
  'skills.name': '名称',
  'skills.description': '描述',
  'skills.none': '无技能',

  // Panel: File Browser
  'fb.title': '文件浏览器',
  'fb.refresh': '刷新',
  'fb.loading': '加载中…',
  'fb.dir': '目录',
  'fb.files': '文件',
  'fb.no.commit': '(无提交)',
  'fb.file.changes': '文件变更',
  'fb.directory': '目录',
  'fb.file': '文件',
  'fb.empty': '目录为空',
  'fb.select.topic': '选择一个 topic 查看文件',
}

const EN: Record<string, string> = {
  'new.topic': '+ New Topic',
  'search.topic': 'Search topic…',
  'no.match': 'No matching topic',
  'no.topics': 'No topics yet',
  'settings': 'Settings',
  'status': 'System Status',
  'create.topic.hint': 'Enter topic name…',
  'confirm': 'Confirm',
  'cancel': 'Cancel',
  'open.terminal': 'Open terminal',
  'switch.topic': 'Switch to topic',
  'archive.topic': 'Archive topic',
  'rename.topic': 'Rename topic',

  'input.placeholder': 'Type a message… (/ command / @ topic)',
  'send': 'Send',
  'stop': 'Stop',
  'thinking': 'Thinking…',
  'reasoning': 'Reasoning…',
  'reasoning.done': 'Reasoning',
  'loading': 'Loading…',

  'connected': 'Connected',
  'disconnected': 'Disconnected',
  'token': 'Token',
  'iteration': 'Iter',
  'budget': 'Budget',
  'yu.version': 'yu v',

  'current.topic': 'Current Topic',
  'active': 'Active',
  'background': 'Background',
  'idle': 'Idle',
  'error': 'Error',
  'archived': 'Archived',
  'topics': 'Topics',

  'settings.title': 'Settings',
  'settings.general': 'General',
  'settings.theme': 'Theme',
  'settings.theme.dark': 'Dark',
  'settings.theme.light': 'Light',
  'settings.theme.auto': 'System',
  'settings.lang': 'Language',
  'settings.lang.zh': '中文',
  'settings.lang.en': 'English',
  'settings.model': 'Model',
  'settings.default.model': 'Default Model',
  'settings.agent': 'Agent',
  'settings.token.budget': 'Token Budget',
  'settings.token.budget.desc': 'Max tokens per agent loop iteration',
  'settings.max.iters': 'Max Iterations',
  'settings.system': 'System',
  'settings.restart': 'Restart Server',
  'settings.restart.confirm': 'Restart the server?',
  'settings.restarting': 'Restarting…',
  'settings.about': 'About',
  'settings.version': 'Version',
  'settings.close': 'Close',

  'switch.topic.msg': 'Switched to topic',
  'create.topic.msg': 'Creating topic',
  'rename.topic.msg': 'Renamed topic',
  'archive.topic.msg': 'Archived topic',
  'load.topic.msg': 'Loading topic',

  // Admin page (system status)
  'admin.version': 'Version',
  'admin.uptime': 'Uptime',
  'admin.heap': 'Heap',
  'admin.ws.conn': 'WS Connections',
  'admin.agent.running': 'Agent Running',
  'admin.completed': 'completed',
  'admin.metric': 'Metric',
  'admin.value': 'Value',
  'admin.heap.usage': 'Heap Usage',
  'admin.ws.msg': 'WS Messages',
  'admin.ws.alive': 'WS Alive',
  'admin.agent.failed': 'Agent Failed',
  'admin.avg.duration': 'Avg Duration',
  'admin.close': 'Close',
  'admin.tab.agents': 'Agents',
  'admin.tab.bg': 'Background',
  'admin.tab.terminal': 'Terminal',
  'admin.tab.files': 'Files',
  'admin.tab.rules': 'Rules',
  'admin.tab.skills': 'Skills',

  // Terminal panel
  'term.title': 'Terminal Sessions',
  'term.select.topic': '— Select topic —',
  'term.open': 'Open Terminal',
  'term.refresh': 'Refresh',
  'term.dir': 'Directory',
  'term.uptime': 'Uptime',
  'term.status': 'Status',
  'term.action': 'Action',
  'term.disconnected': 'Disconnected',
  'term.reopen': 'Reopen',
  'term.kill': 'Kill',
  'term.no.sessions': 'No active terminal sessions',

  // Panel: Topics
  'topic.title': 'Topics',
  'topic.filter': 'Filter topics…',
  'topic.name': 'Name',
  'topic.status': 'Status',
  'topic.turns': 'Turns',
  'topic.last.active': 'Last Active',
  'topic.none': 'No topics',

  // Panel: Background Tasks
  'bg.title': 'Background Tasks',
  'bg.type': 'Type',
  'bg.status': 'Status',
  'bg.duration': 'Duration',
  'bg.task': 'Task',
  'bg.none': 'No background tasks',

  // Panel: Rules
  'rules.title': 'Rules',
  'rules.name': 'Name',
  'rules.trigger': 'Trigger',
  'rules.action': 'Action',
  'rules.condition': 'Condition',
  'rules.none': 'No rules',

  // Panel: Skills
  'skills.title': 'Skills',
  'skills.name': 'Name',
  'skills.description': 'Description',
  'skills.none': 'No skills',

  // Panel: File Browser
  'fb.title': 'File Browser',
  'fb.refresh': 'Refresh',
  'fb.loading': 'Loading…',
  'fb.dir': 'Directory',
  'fb.files': 'Files',
  'fb.no.commit': '(no commit)',
  'fb.file.changes': 'file changes',
  'fb.directory': 'Directory',
  'fb.file': 'File',
  'fb.empty': 'Empty directory',
  'fb.select.topic': 'Select a topic to browse files',
}

const MAP: Record<string, Record<string, string>> = { zh: ZH, en: EN }

export function getLang(): string {
  return localStorage.getItem('yu-lang') || 'zh'
}

export function t(key: string): string {
  const lang = getLang()
  return MAP[lang]?.[key] ?? MAP.zh[key] ?? key
}

export function setLang(l: string) {
  localStorage.setItem('yu-lang', l)
}
