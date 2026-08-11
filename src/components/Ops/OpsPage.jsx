import React, { useEffect, useState } from 'react';
import { Bot, ClipboardCheck, Footprints, History, LayoutDashboard, Link2, MapPinned, MousePointerClick, Settings, ShieldCheck } from 'lucide-react';
import CheckinAuditPanel from './CheckinAuditPanel';
import ImportSourcesPanel from './ImportSourcesPanel';
import LogsPage from './LogsPage';
import OpsConfigPanel from './OpsConfigPanel';
import OpsOverview from './OpsOverview';
import PoiContentPanel from './PoiContentPanel';
import ProductBoardPanel from './ProductBoardPanel';
import ReviewQueuePanel from './ReviewQueuePanel';
import RoutebookVersionsPanel from './RoutebookVersionsPanel';

const OPS_TABS = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'content', label: 'POI 内容', icon: MapPinned },
  { id: 'checkins', label: '打卡审核', icon: Footprints },
  { id: 'reviews', label: '审核队列', icon: ClipboardCheck },
  { id: 'imports', label: '攻略来源', icon: Link2 },
  { id: 'products', label: '商品看板', icon: MousePointerClick },
  { id: 'versions', label: '路书版本', icon: History },
  { id: 'logs', label: 'AI 日志', icon: Bot },
  { id: 'config', label: '配置', icon: Settings }
];
const TAB_IDS = new Set(OPS_TABS.map((tab) => tab.id));

export default function OpsPage() {
  const [activeTab, setActiveTab] = useState(readTabFromLocation);

  useEffect(() => {
    const handlePopState = () => setActiveTab(readTabFromLocation());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  function selectTab(tabId) {
    if (!TAB_IDS.has(tabId)) return;
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tabId);
    window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
    setActiveTab(tabId);
  }

  function handleTabKeyDown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll('[role="tab"]')];
    const currentIndex = buttons.indexOf(document.activeElement);
    let nextIndex = currentIndex;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = buttons.length - 1;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % buttons.length;
    const nextId = buttons[nextIndex]?.dataset.tabId;
    if (nextId) {
      selectTab(nextId);
      buttons[nextIndex].focus();
    }
  }

  return (
    <div className="container ops-page page-enter">
      <header className="ops-hero">
        <div>
          <span className="section-kicker">运营工作区</span>
          <h1 className="text-hero">内容质量与路书运营</h1>
          <p className="text-body">核对三城内容覆盖，处理审核任务，并追踪路书发布版本。</p>
        </div>
        <span className="badge badge-green"><ShieldCheck size={13} /> 管理模式</span>
      </header>

      <nav className="ops-tabs" role="tablist" aria-label="运营工作区" onKeyDown={handleTabKeyDown}>
        {OPS_TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`ops-tab-${tab.id}`}
              className={`ops-tab ${selected ? 'is-active' : ''}`}
              type="button"
              role="tab"
              data-tab-id={tab.id}
              aria-selected={selected}
              aria-controls={`ops-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(tab.id)}
            >
              <Icon size={16} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      <main
        id={`ops-panel-${activeTab}`}
        className="ops-workspace"
        role="tabpanel"
        aria-labelledby={`ops-tab-${activeTab}`}
        tabIndex={0}
      >
        {activeTab === 'overview' && <OpsOverview />}
        {activeTab === 'content' && <PoiContentPanel />}
        {activeTab === 'checkins' && <CheckinAuditPanel />}
        {activeTab === 'reviews' && <ReviewQueuePanel />}
        {activeTab === 'imports' && <ImportSourcesPanel />}
        {activeTab === 'products' && <ProductBoardPanel />}
        {activeTab === 'versions' && <RoutebookVersionsPanel />}
        {activeTab === 'logs' && <LogsPage embedded />}
        {activeTab === 'config' && <OpsConfigPanel />}
      </main>
    </div>
  );
}

function readTabFromLocation() {
  const tab = new URLSearchParams(window.location.search).get('tab');
  return TAB_IDS.has(tab) ? tab : 'overview';
}
