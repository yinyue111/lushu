import React from 'react';
import { Circle, Link2, Route, UserRound } from 'lucide-react';

const navItems = [
  { id: 'home', label: '路书', icon: Route },
  { id: 'builder', label: '导入', icon: Link2 },
  { id: 'my', label: '我的', icon: UserRound },
];

export default function TopNav({ view, onNavigate, modelHealth, hidden = false }) {
  if (hidden) return null;

  return (
    <header className="top-nav">
      <button type="button" className="brand" onClick={() => onNavigate('home')} aria-label="返回可信路书首页">
        <span className="brand-icon"><Route size={16} /></span>
        <span>可信路书</span>
      </button>

      <nav className="nav-tabs" aria-label="主导航">
        {navItems.map(item => {
          const Icon = item.icon;
          return (
            <button
              type="button"
              key={item.id}
              className={`nav-tab ${view === item.id ? 'active' : ''}`}
              onClick={() => onNavigate(item.id)}
              aria-current={view === item.id ? 'page' : undefined}
            >
              <Icon size={16} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="nav-actions">
        <span className={`status-dot ${modelHealth?.ready ? 'ready' : ''}`}>
          <Circle size={8} fill="currentColor" />
        </span>
        <span className="text-caption">
          {modelHealth?.ready ? `${modelHealth.provider}` : '模型未就绪'}
        </span>
      </div>
    </header>
  );
}
