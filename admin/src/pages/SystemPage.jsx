import { adminGet } from '../api';
import { Card, Notice, Page, formatTime, useLoad } from '../ui';

const Row = ({ label, value }) => (
  <div className="grid grid-cols-[10rem_1fr] gap-2 border-b border-line py-2 text-sm">
    <dt className="text-muted">{label}</dt>
    <dd className="break-all text-ink">{value ?? '—'}</dd>
  </div>
);

export default function SystemPage() {
  const { data, error } = useLoad(() => adminGet('/system'));
  return (
    <Page title="系统信息" description="只读。未注入的构建信息显示 unknown，不做猜测。">
      {error && <Notice tone="error">{error}</Notice>}
      {data && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="版本">
            <dl>
              <Row label="提交" value={data.commit} />
              <Row label="构建时间" value={data.buildTime} />
              <Row label="镜像摘要" value={data.imageDigest} />
              <Row label="部署时间" value={data.deployTime} />
              <Row label="进程启动" value={formatTime(data.processStartedAt)} />
              <Row label="package 版本" value={data.packageVersion} />
              <Row label="Node" value={data.node} />
              <Row label="运行时长" value={`${Math.round((data.uptimeSeconds ?? 0) / 60)} 分钟`} />
            </dl>
          </Card>
          <Card title="存储与配置">
            <dl>
              <Row label="存储后端" value={data.migration?.backend} />
              <Row
                label="库结构版本"
                value={
                  data.migration?.backend === 'postgres'
                    ? `${data.migration.schemaVersion ?? '读取失败'}（代码期望 ${data.migration.expectedSchemaVersion}）`
                    : 'JSONL 无库结构版本'
                }
              />
              <Row label="最近迁移" value={data.migration?.latest ? `${data.migration.latest.name} · ${formatTime(data.migration.latest.appliedAt)}` : '—'} />
              <Row label="配置版本" value={data.config?.version} />
              <Row label="配置来源" value={data.config?.source === 'db' ? '数据库（覆盖环境变量）' : '环境变量'} />
              <Row label="配置状态" value={data.config?.stale ? `数据库暂时不可用，沿用上次的配置（${data.config?.error || ''}）` : '正常'} />
              <Row label="上次同步" value={formatTime(data.config?.loadedAt)} />
            </dl>
          </Card>
        </div>
      )}
    </Page>
  );
}
