import React, { useEffect, useState } from 'react';
import { Bot, Check, AlertCircle } from 'lucide-react';
import { getLogs } from '../../lib/api';

const PIPELINE_STAGES = ['意图识别', 'POI 检索', '约束过滤', '路线编排', '可执行校验', '引用解释'];

// AI 生成链路日志。默认不再渲染硬编码示例数据：无真实日志时显示空态。
// embedded 模式供运营后台「AI 日志」Tab 内嵌复用；独立 /logs 路由继续走默认整页模式。
export default function LogsPage({ routebook, modelHealth, embedded = false }) {
  const [serverLogs, setServerLogs] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const logs = routebook?.logs?.length ? routebook.logs : serverLogs.map(normalizeServerLog);

  useEffect(() => {
    const ctrl = new AbortController();
    getLogs(50, ctrl.signal)
      .then((data) => {
        setServerLogs(Array.isArray(data?.logs) ? data.logs : []);
        setStatus('ready');
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setError(err?.message || '请求失败');
        setStatus('error');
      });
    return () => ctrl.abort();
  }, []);

  const core = (
    <>
      {error && <p className="text-caption" style={{ marginTop: 10, color: 'var(--orange)' }}>日志接口暂不可用：{error}</p>}

      {/* Pipeline */}
      <div className="pipeline" style={{ marginTop: embedded ? 0 : 32 }}>
        {PIPELINE_STAGES.map((stage, i) => (
          <div key={stage} className="card-flat pipeline-node">
            <span className="pipeline-num">{i + 1}</span>
            <span className="text-body" style={{ fontSize: 13, fontWeight: 600 }}>{stage}</span>
          </div>
        ))}
      </div>

      {/* Log list */}
      <div className="card" style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 16 }}>
          <h2 className="text-subtitle">最近生成链路</h2>
          {logs.length > 0 && <span className="badge badge-blue">{logs.length} 条</span>}
        </div>
        {logs.length ? (
          <div className="log-list">
            {logs.map((log, i) => (
              <div key={i} className="log-item">
                <span className="text-micro">{log.time}</span>
                <div style={{ flex: 1 }}>
                  <strong className="text-body" style={{ fontSize: 13, fontWeight: 600 }}>{log.stage}</strong>
                  <p className="text-caption">{log.result}</p>
                </div>
                <span className={`badge ${log.status === '通过' ? 'badge-green' : 'badge-orange'}`}>
                  {log.status === '通过' ? <Check size={11} /> : <AlertCircle size={11} />}
                  {log.status}
                </span>
              </div>
            ))}
          </div>
        ) : status === 'loading' ? (
          <p className="text-caption">正在读取生成日志...</p>
        ) : (
          <p className="text-caption">暂无 AI 生成日志。生成路书后，这里会展示真实的生成与校验链路。</p>
        )}
      </div>
    </>
  );

  if (embedded) {
    return (
      <div className="ops-workspace-stack">
        <section aria-labelledby="ops-ai-logs-title">
          <div className="ops-section-heading">
            <div>
              <h2 id="ops-ai-logs-title">AI 日志</h2>
              <p>模型生成与校验链路追踪，来自 /api/logs 真实记录。</p>
            </div>
          </div>
          {core}
        </section>
      </div>
    );
  }

  return (
    <div className="container page-enter" style={{ paddingTop: 40, paddingBottom: 60 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 className="text-hero">AI 日志</h1>
          <p className="text-body" style={{ color: 'var(--muted)', marginTop: 8 }}>模型生成与校验链路追踪</p>
        </div>
        {modelHealth && (
          <div className={`card-flat ${modelHealth?.ready ? '' : 'model-offline'}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px' }}>
            <Bot size={16} style={{ color: modelHealth?.ready ? 'var(--green)' : 'var(--muted)' }} />
            <span className="text-caption">{modelHealth?.ready ? ([modelHealth.provider, modelHealth.model].filter(Boolean).join(' · ') || '已就绪') : '未就绪'}</span>
          </div>
        )}
      </div>
      {core}
    </div>
  );
}

function normalizeServerLog(log) {
  return {
    time: log.createdAt ? new Date(log.createdAt).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--',
    stage: log.kind === 'generate-routebook' ? '路书生成' : '系统事件',
    input: log.inputHash ? `${log.city ?? '-'} · ${log.inputLength ?? 0} 字 · ${log.inputHash}` : (log.city ?? '-'),
    result: log.status === 'ok'
      ? `${log.outputTitle ?? '生成成功'} · ${log.stopCount ?? 0} 站 · 可信 ${log.trustScore ?? '-'}`
      : `生成失败 · ${log.code ?? 'MODEL_ERROR'} · ${log.requestId ?? ''}`,
    status: log.status === 'ok' ? '通过' : '需复核'
  };
}
