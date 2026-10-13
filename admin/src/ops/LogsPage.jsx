import { useEffect, useState } from 'react';
import { Bot, Check, AlertCircle } from 'lucide-react';
import { getLogs } from '../lib/legacyApi';
import AiObservabilityPanel, { durationLabel } from './AiObservabilityPanel';

const PIPELINE_STAGES = ['意图识别', 'POI 检索', '约束过滤', '路线编排', '可执行校验', '引用解释'];

// AI 生成链路日志。默认不再渲染硬编码示例数据：无真实日志时显示空态。
// embedded 模式供运营后台「AI 日志」Tab 内嵌复用；独立 /logs 路由继续走默认整页模式。
/** @param {{ routebook?: any, modelHealth?: any, embedded?: boolean }} props */
export default function LogsPage({ routebook, modelHealth, embedded = false }) {
  const [serverLogs, setServerLogs] = useState([]);
  const [summary, setSummary] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  // Only server-written (signed) process logs are shown; older model-written logs are ignored.
  const logs = routebook?.logsSource === 'server' && routebook?.logs?.length ? routebook.logs : serverLogs.map(normalizeServerLog);

  useEffect(() => {
    const ctrl = new AbortController();
    getLogs(50, ctrl.signal)
      .then((data) => {
        setServerLogs(Array.isArray(data?.logs) ? data.logs : []);
        setSummary(data?.summary ?? null);
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
      <AiObservabilityPanel summary={summary} />
      {error && <p className="text-caption mt-2.5 text-lemon-ink">日志接口暂不可用：{error}</p>}

      <p className="mt-4 text-xs text-muted">流程示意（实际阶段耗时和失败情况以上方记录为准）</p>
      <div className={`pipeline ${embedded ? 'mt-0' : 'mt-8'}`}>
        {PIPELINE_STAGES.map((stage, i) => (
          <div key={stage} className="card-flat pipeline-node">
            <span className="pipeline-num">{i + 1}</span>
            <span className="text-body text-meta font-semibold">{stage}</span>
          </div>
        ))}
      </div>

      {/* Log list */}
      <div className="card mt-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-subtitle">最近生成链路</h2>
          {logs.length > 0 && <span className="badge badge-blue">{logs.length} 条</span>}
        </div>
        {logs.length ? (
          <div className="log-list">
            {logs.map((log, i) => (
              <div key={i} className="log-item">
                <span className="text-micro">{log.time}</span>
                <div className="flex-1">
                  <strong className="text-body text-meta font-semibold">{log.stage}</strong>
                  <p className="text-caption">{log.result}</p>
                  {log.observability && <p className="mt-1 text-xs text-muted">{log.observability}</p>}
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
    <div className="container page-enter pt-10 pb-15">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-hero">AI 日志</h1>
          <p className="text-body mt-2 text-muted">模型生成与校验链路追踪</p>
        </div>
        {modelHealth && (
          <div className={`card-flat flex items-center gap-2 px-3.5 py-2 ${modelHealth?.ready ? '' : 'model-offline'}`}>
            <Bot size={16} className={modelHealth?.ready ? 'text-success-ink' : 'text-muted'} aria-hidden="true" />
            <span className="text-caption">
              {modelHealth?.ready ? [modelHealth.provider, modelHealth.model].filter(Boolean).join(' · ') || '已就绪' : '未就绪'}
            </span>
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
    result:
      log.status === 'ok'
        ? `${log.outputTitle ?? '生成成功'} · ${log.stopCount ?? 0} 站 · 可信 ${log.trustScore ?? '-'}`
        : `生成失败 · ${log.code ?? 'MODEL_ERROR'} · ${log.requestId ?? ''}`,
    status: log.status === 'ok' ? '通过' : '需复核',
    observability: [
      `耗时 ${durationLabel(log.durationMs)}`,
      log.modelUsage?.totalTokens == null
        ? 'Token 未上报'
        : `${log.modelUsage.totalTokens} Tokens（${log.modelUsage.status === 'reported' ? '完整' : '部分'}）`,
      log.costEstimate?.status === 'estimated' ? `估算 ${log.costEstimate.currency} ${log.costEstimate.amount}` : '费用不可用',
      log.failureStage ? `失败阶段 ${log.failureStage}` : ''
    ]
      .filter(Boolean)
      .join(' · ')
  };
}
