const Sidebar: React.FC<SidebarProps> = ({
  topics,
  currentTopic,
  onSwitchTopic,
  onArchiveTopic,
  onRenameTopic,
  onCreateTopic,
}) => {
  const [hoveredTopic, setHoveredTopic] = useState<string | null>(null);
  const [editingTopic, setEditingTopic] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [showCreateInput, setShowCreateInput] = useState(false);
  const [createName, setCreateName] = useState('');

  const handleRename = (oldName: string) => {
    if (newName.trim() && newName !== oldName) {
      onRenameTopic(oldName, newName.trim());
    }
    setEditingTopic(null);
    setNewName('');
  };

  const handleCreate = () => {
    if (createName.trim()) {
      onCreateTopic(createName.trim());
      setCreateName('');
      setShowCreateInput(false);
    }
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'active': return '#4CAF50';
      case 'background': return '#2196F3';
      case 'error': return '#F44336';
      default: return '#9E9E9E';
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h3>Topics</h3>
        <button 
          className="create-topic-btn"
          onClick={() => setShowCreateInput(true)}
          title="New Topic"
        >
          +
        </button>
      </div>

      {showCreateInput && (
        <div className="create-topic-input">
          <input
            type="text"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="Topic name..."
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
          <button onClick={handleCreate}>Create</button>
          <button onClick={() => setShowCreateInput(false)}>Cancel</button>
        </div>
      )}

      <ul className="topic-list">
        {topics.map((topic) => (
          <li
            key={topic.name}
            className={`topic-item ${topic.name === currentTopic ? 'active' : ''}`}
            onMouseEnter={() => setHoveredTopic(topic.name)}
            onMouseLeave={() => setHoveredTopic(null)}
          >
            <div className="topic-content">
              <span 
                className="status-dot" 
                style={{ backgroundColor: getStatusColor(topic.status) }}
              />
              
              {editingTopic === topic.name ? (
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleRename(topic.name)}
                  onBlur={() => handleRename(topic.name)}
                  autoFocus
                  className="rename-input"
                />
              ) : (
                <span 
                  className="topic-name"
                  onClick={() => onSwitchTopic(topic.name)}
                >
                  {topic.name}
                </span>
              )}

              {hoveredTopic === topic.name && editingTopic !== topic.name && (
                <div className="topic-actions">
                  <button 
                    className="action-btn switch-btn"
                    onClick={() => onSwitchTopic(topic.name)}
                    title="Switch to this topic"
                  >
                    ⇄
                  </button>
                  <button 
                    className="action-btn archive-btn"
                    onClick={() => onArchiveTopic(topic.name)}
                    title="Archive topic"
                  >
                    📁
                  </button>
                  <button 
                    className="action-btn rename-btn"
                    onClick={() => {
                      setEditingTopic(topic.name);
                      setNewName(topic.name);
                    }}
                    title="Rename topic"
                  >
                    ✏️
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default Sidebar;
```

```css
/* webui/frontend/src/components/Sidebar.css */
.sidebar {
  width: 280px;
  background: #1a1a2e;
  color: #e0e0e0;
  padding: 16px;
  height: 100vh;
  overflow-y: auto;
  border-right: 1px solid #2a2a3e;
}

.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #2a2a3e;
}

.sidebar-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
}

.create-topic-btn {
  background: #4CAF50;
  color: white;
  border: none;
  border-radius: 50%;
  width: 32px;
  height: 32px;
  font-size: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.create-topic-btn:hover {
  background: #45a049;
}

.create-topic-input {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px;
  background: #2a2a3e;
  border-radius: 6px;
}

.create-topic-input input {
  flex: 1;
  padding: 6px 10px;
  background: #1a1a2e;
  border: 1px solid #3a3a4e;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 13px;
}

.create-topic-input button {
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  background: #4CAF50;
  color: white;
}

.create-topic-input button:last-child {
  background: #666;
}

.topic-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.topic-item {
  padding: 8px 12px;
  margin-bottom: 4px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s;
  position: relative;
}

.topic-item:hover {
  background: #2a2a3e;
}

.topic-item.active {
  background: #3a3a5e;
  border-left: 3px solid #4CAF50;
}

.topic-content {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.topic-name {
  flex: 1;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rename-input {
  flex: 1;
  padding: 4px 8px;
  background: #1a1a2e;
  border: 1px solid #4CAF50;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 13px;
}

.topic-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.action-btn {
  background: transparent;
  border: none;
  color: #a0a0b0;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  font-size: 14px;
  transition: all 0.2s;
}

.action-btn:hover {
  background: #3a3a5e;
  color: #ffffff;
}

.switch-btn:hover { color: #4CAF50; }
.archive-btn:hover { color: #FFC107; }
.rename-btn:hover { color: #2196F3; }
```

```typescript
// webui/frontend/src/components/ChatPanel.tsx
import React, { useState, useRef, useEffect } from 'react';
import './ChatPanel.css';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'system' | 'ai';
  timestamp: Date;
  topic?: string;
}

interface ChatPanelProps {
  currentTopic
