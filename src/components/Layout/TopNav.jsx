import { Compass, Link2, MapPin, UserRound } from 'lucide-react';
import { useMemo } from 'react';
import { getProfile } from '../../lib/profile';
import { cn } from '../ui/cn';
import { Button } from '../ui/button';
import { modelStatusLabel } from '../../lib/modelStatus';
import { useAccount } from '../Account/AccountProvider';

const navItems = [
  { id: 'home', label: '发现', icon: Compass },
  { id: 'builder', label: '导入攻略', shortLabel: '导入', icon: Link2 },
  { id: 'my', label: '我的', icon: UserRound }
];

export default function TopNav({ view, onNavigate, modelHealth, hidden = false }) {
  const modelStatus = modelStatusLabel(modelHealth);
  const profile = useMemo(() => getProfile(), []);
  const { enabled: accountsEnabled, account, ready: accountReady, openLogin } = useAccount();
  if (hidden) return null;
  const name = String(profile?.creatorName || '').trim();
  // The route page has its own phone action bar: no tab bar and no header below lg.
  const immersive = view === 'route';

  return (
    <>
      <header
        className={cn(
          'sticky top-0 z-[1200] flex h-16 items-center gap-5 border-b border-line bg-white/92 px-4 backdrop-blur-xl lg:px-8',
          immersive && 'max-lg:hidden'
        )}
      >
        <button
          type="button"
          className="flex items-center gap-2.5 text-title-xs font-extrabold tracking-tight"
          onClick={() => onNavigate('home')}
          aria-label="可信路书首页"
        >
          <span className="grid size-[34px] place-items-center rounded-[11px] bg-gradient-to-br from-primary-strong to-[#ff8a3d] text-white shadow-[0_6px_14px_rgba(232,85,61,.35)]">
            <MapPin className="size-5" strokeWidth={2.4} />
          </span>
          可信路书
        </button>

        <nav className="ml-4 hidden gap-1.5 md:flex" aria-label="主导航">
          {navItems.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => onNavigate(item.id)}
              aria-current={view === item.id ? 'page' : undefined}
              className={cn('rounded-full px-4 py-2 text-copy font-semibold', view === item.id ? 'bg-ink text-white' : 'text-ink-2 hover:bg-canvas')}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span
            className="hidden items-center gap-1.5 rounded-full bg-canvas px-3 py-1.5 text-meta font-semibold text-ink-2 sm:inline-flex"
            title={modelHealth?.ready ? undefined : modelHealth?.reason || undefined}
          >
            <span
              className={cn('size-2 rounded-full', modelStatus.tone === 'ok' ? 'bg-success' : modelStatus.tone === 'warn' ? 'bg-lemon' : 'bg-line-strong')}
              aria-hidden="true"
            />
            {modelStatus.label}
          </span>
          {accountsEnabled && accountReady && !account && (
            <Button variant="dark" size="sm" onClick={() => openLogin('login')}>
              登录
            </Button>
          )}
          <button
            type="button"
            onClick={() => onNavigate('my')}
            className={cn('flex items-center gap-2.5 text-copy font-semibold', accountsEnabled && !account && 'max-sm:hidden')}
            aria-label={account ? `${name || `尾号 ${String(account.phoneMasked).slice(-4)}`}，我的账号` : '我的'}
          >
            <span className="grid size-9 place-items-center rounded-full border-2 border-white bg-gradient-to-br from-lemon to-[#ff9a3c] text-copy font-extrabold text-ink shadow-card">
              {name ? name.slice(0, 1) : <UserRound className="size-[18px]" />}
            </span>
            {account ? (
              <span className="hidden lg:inline">{name || `尾号 ${String(account.phoneMasked).slice(-4)}`}</span>
            ) : (
              name && <span className="hidden lg:inline">{name}</span>
            )}
          </button>
        </div>
      </header>

      {/* Phone bottom tab bar */}
      {!immersive && (
        <nav
          className="fixed inset-x-0 bottom-0 z-[1200] grid grid-cols-3 border-t border-line bg-white/96 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
          aria-label="主导航"
          data-mobile-tabbar=""
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = view === item.id;
            return (
              <button
                type="button"
                key={item.id}
                onClick={() => onNavigate(item.id)}
                aria-current={active ? 'page' : undefined}
                className={cn('flex h-14 flex-col items-center justify-center gap-0.5 text-xs font-bold', active ? 'text-primary-strong' : 'text-muted')}
              >
                <Icon className="size-[22px]" strokeWidth={active ? 2.4 : 2} />
                {item.shortLabel || item.label}
              </button>
            );
          })}
        </nav>
      )}
    </>
  );
}
