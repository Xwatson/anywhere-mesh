import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { ChatView } from './components/ChatView';
import { Login } from './components/Login';
import { NewSessionDialog, NewTerminalDialog } from './components/NewDialogs';
import { SharedView } from './components/SharedView';
import { Sidebar, type Route } from './components/Sidebar';
import { cx, Icon, setPathAliases } from './components/ui';
import { api, setUnauthorizedHandler, type Meta, type User } from './lib/api';
import { claimPush } from './lib/push';
import { socket } from './lib/socket';
import { loadOthers, loadSessions, loadTerminals, useOtherSessions, useSessions, useTerminals } from './lib/store';

// xterm is large; only load it when a terminal is opened.
const TerminalView = lazy(() => import('./components/TerminalView').then((m) => ({ default: m.TerminalView })));

function parseHash(): Route {
  const m = location.hash.match(/^#\/(s|t)\/([\w-]+)$/);
  return m ? { kind: m[1] === 's' ? 'session' : 'terminal', id: m[2] } : null;
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((r: Route) => {
    location.hash = r ? `#/${r.kind === 'session' ? 's' : 't'}/${r.id}` : '';
  }, []);
  return [route, navigate];
}

/** A shared session's link (/share/<token>): opened without an account. */
export const shareToken = location.pathname.match(/^\/share\/([\w-]+)\/?$/)?.[1];

export default function App() {
  return shareToken ? <SharedView token={shareToken} /> : <Main />;
}

function Main() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    const logout = () => {
      socket.stop();
      setUser(null);
    };
    setUnauthorizedHandler(logout);
    socket.onUnauthorized = logout;
    api.me().then(
      (r) => setUser(r.user),
      () => setUser(null),
    );
  }, []);

  if (user === undefined) return null;
  if (!user) return <Login onLogin={setUser} />;
  return <Workspace user={user} onLogout={() => setUser(null)} />;
}

function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [route, navigate] = useRoute();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState<{ kind: 'session' | 'terminal'; cwd?: string } | null>(null);
  const sessions = useSessions();
  const others = useOtherSessions();
  const terms = useTerminals();

  useEffect(() => {
    socket.start();
    // This browser's notifications now go to the account signed in here, not to whoever had it before.
    claimPush().catch(() => {});
    api.meta().then((m) => {
      setPathAliases(m.roots, m.rootsReal);
      setMeta(m);
    });
    // Reload lists after every reconnect: events may have been missed while offline.
    const off = socket.onOpen(() => {
      void loadSessions();
      void loadTerminals();
      // Admins also see every other account's sessions (read-only).
      if (user.isAdmin) void loadOthers();
    });
    return off;
  }, [user.isAdmin]);

  const go = (r: Route) => {
    navigate(r);
    setDrawer(false);
  };

  const logout = async () => {
    await api.logout().catch(() => {});
    socket.stop();
    onLogout();
  };

  const own = route?.kind === 'session' ? sessions.find((s) => s.id === route.id) : undefined;
  // Another account's session, opened by an admin from「其他账号」: only watched.
  const watched = route?.kind === 'session' && !own ? others.find((s) => s.id === route.id) : undefined;
  const session = own ?? watched;
  const term = route?.kind === 'terminal' ? terms.find((t) => t.id === route.id) : undefined;

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar: fixed column on desktop, drawer on mobile */}
      <div
        className={cx('fixed inset-0 z-30 bg-black/50 md:hidden', drawer ? 'block' : 'hidden')}
        onClick={() => setDrawer(false)}
      />
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 w-[82vw] max-w-72 border-r border-zinc-800 transition-transform md:static md:w-72 md:translate-x-0',
          drawer ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <Sidebar
          route={route}
          user={user}
          roots={meta ? [...new Set([...meta.roots, ...(meta.rootsReal ?? [])])] : []}
          home={meta?.home ?? null}
          agents={meta ? (['claude', 'codex'] as const).filter((a) => meta.versions[a]) : []}
          onNavigate={go}
          onNewSession={() => (setDialog({ kind: 'session' }), setDrawer(false))}
          onNewTerminal={() => (setDialog({ kind: 'terminal' }), setDrawer(false))}
          onLogout={logout}
        />
      </aside>

      <main className="min-w-0 flex-1">
        {session ? (
          <ChatView
            key={session.id}
            session={session}
            onOpenSidebar={() => setDrawer(true)}
            // A raw terminal has all of this machine's rights: admins only.
            onOpenTerminal={user.isAdmin ? (cwd) => setDialog({ kind: 'terminal', cwd }) : undefined}
            member={watched ? watched.member : !user.isAdmin}
            owner={watched?.owner}
            onDeleted={() => navigate(null)}
          />
        ) : term ? (
          <Suspense fallback={null}>
            <TerminalView key={term.id} term={term} onOpenSidebar={() => setDrawer(true)} onClosed={() => navigate(null)} />
          </Suspense>
        ) : (
          <div className="flex h-full flex-col">
            <header className="flex items-center px-3 py-2 md:hidden">
              <button onClick={() => setDrawer(true)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800" aria-label="菜单">
                <Icon name="menu" className="h-5 w-5" />
              </button>
            </header>
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
              <div className="font-mono text-3xl text-emerald-400">&gt;_</div>
              <div className="text-zinc-400">选择一个会话，或新建一个开始写代码</div>
              <button
                onClick={() => setDialog({ kind: 'session' })}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-400"
              >
                新建会话
              </button>
            </div>
          </div>
        )}
      </main>

      {meta && dialog?.kind === 'session' && (
        <NewSessionDialog
          meta={meta}
          initialCwd={dialog.cwd}
          onClose={() => setDialog(null)}
          onCreated={(s) => {
            setDialog(null);
            go({ kind: 'session', id: s.id });
          }}
        />
      )}
      {meta && dialog?.kind === 'terminal' && (
        <NewTerminalDialog
          meta={meta}
          initialCwd={dialog.cwd}
          onClose={() => setDialog(null)}
          onCreated={async (t) => {
            setDialog(null);
            await loadTerminals();
            go({ kind: 'terminal', id: t.id });
          }}
        />
      )}
    </div>
  );
}
