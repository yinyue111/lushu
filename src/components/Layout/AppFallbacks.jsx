import React from 'react';
import { AlertCircle, CalendarClock, HardDrive, MapPinOff, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '../ui/button';
import { EmptyArt } from '../visual/EmptyArt';

/** @param {Record<string, any>} props */
function Skeleton({ className }) {
  return <div className={`animate-pulse rounded-card bg-line/70 ${className}`} />;
}

/** @param {Record<string, any>} props */
function CenteredMessage({ icon: Icon, title, text, children, art = false }) {
  const bubble = (
    <span className="mx-auto grid size-12 place-items-center rounded-full bg-primary-soft text-primary-strong">
      <Icon className="size-6" aria-hidden="true" />
    </span>
  );
  return (
    <div className="page-enter grid min-h-[60vh] place-items-center px-4">
      <div className="max-w-sm rounded-panel border border-line bg-white p-6 text-center shadow-card">
        {art ? <EmptyArt className="w-52" fallback={bubble} /> : bubble}
        {title && <h1 className="mt-3 text-xl font-extrabold">{title}</h1>}
        <p className="mt-1 text-sm text-muted">{text}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div>
      </div>
    </div>
  );
}

/** @param {Record<string, any>} props */
export function RouteLoadFallback({ state, onBack, onRetry }) {
  if (state.loading) {
    return (
      <div
        className="page-enter mx-auto grid max-w-[1400px] gap-4 px-4 pt-4 lg:grid-cols-[minmax(0,1fr)_480px] lg:px-8"
        aria-busy="true"
        aria-label="路书加载中"
      >
        <Skeleton className="h-64 lg:h-[70vh]" />
        <div className="grid content-start gap-3">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      </div>
    );
  }
  return (
    <CenteredMessage icon={MapPinOff} art title="这份路书打不开" text={state.error || '路书不存在或还没保存'}>
      {onRetry && (
        <Button variant="primary" onClick={onRetry}>
          <RotateCcw /> 重试
        </Button>
      )}
      <Button variant="outline" onClick={onBack}>
        返回首页
      </Button>
    </CenteredMessage>
  );
}

export function PageLoadingFallback() {
  return (
    <div className="page-enter mx-auto max-w-[1200px] px-4 pt-6 lg:px-8" aria-busy="true" aria-label="页面加载中">
      <Skeleton className="h-56 rounded-panel lg:h-72" />
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}

export class ErrorBoundary extends React.Component {
  /** @param {Record<string, any>} props */
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[routebook] render error', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <CenteredMessage icon={AlertCircle} title="页面出了点问题" text="本地数据没有受影响，可以刷新重试或返回首页。">
        <Button variant="primary" onClick={() => window.location.reload()}>
          <RotateCcw /> 刷新重试
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            this.setState({ error: null });
            this.props.onReset?.();
          }}
        >
          返回首页
        </Button>
      </CenteredMessage>
    );
  }
}

/** @param {Record<string, any>} props */
function Banner({ icon: Icon, tone, role, title, text, children }) {
  return (
    <div role={role} className="mx-auto mt-3 flex max-w-[1200px] px-4 lg:px-8">
      <div className={`flex w-full flex-wrap items-center gap-3 rounded-card border p-3.5 shadow-card ${tone}`}>
        <Icon className="size-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <strong className="block text-sm font-extrabold">{title}</strong>
          <span className="text-sm">{text}</span>
        </div>
        <div className="flex gap-2">{children}</div>
      </div>
    </div>
  );
}

/** @param {Record<string, any>} props */
export function TripReminderBanner({ reminder, onOpen, onDismiss }) {
  return (
    <Banner
      icon={CalendarClock}
      role="status"
      tone="border-primary/25 bg-primary-soft text-ink"
      title={`${reminder.city || ''}${reminder.title || '路书'} 今天出行`}
      text="进入行中模式，按站点导航，到了记一下。"
    >
      <Button size="sm" variant="primary" onClick={onOpen}>
        进入行中
      </Button>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        稍后
      </Button>
    </Banner>
  );
}

/** @param {Record<string, any>} props */
export function StorageNoticeBanner({ text, onDismiss }) {
  return (
    <Banner icon={HardDrive} role="alert" tone="border-lemon/50 bg-lemon-soft text-lemon-ink" title="本地存储已满" text={text}>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        知道了
      </Button>
    </Banner>
  );
}

/** A routebook generation keeps running on the server after leaving the builder. */
/** @param {Record<string, any>} props */
export function GenerationRunningBanner({ job, onOpen }) {
  return (
    <Banner
      icon={Sparkles}
      role="status"
      tone="border-primary/25 bg-primary-soft text-ink"
      title={`${job.city || ''}路书正在后台生成`}
      text="通常需要 2–3 分钟，完成后在这里打开结果；也可以在进度页取消。"
    >
      <Button size="sm" variant="primary" onClick={onOpen}>
        查看进度
      </Button>
    </Banner>
  );
}
