// Client half: a floating orb (bottom-right) that expands into the session board.
// Data comes from this package's Host half via POST api/session-board.
window.__ModuleLoader__.load({
  id: 'dsh-session-board',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = 'api/session-board';
    const POLL_MS = 2500;
    const LIVE_POLL_MS = 1200;
    const THEME_KEY = 'sb-theme';
    const DEFAULT_THEME = {
      running: '#4c8dff', working: '#f5b73e', blocked: '#f5b73e',
      failed: '#ef5350', idle: '#9aa3ab', orbIdle: '#3ecf6f', orbSize: 44,
      breathe: true,
    };
    const COLOR_FIELDS = [
      ['running', '运行'], ['working', '后台'], ['blocked', '等待'],
      ['failed', '失败'], ['idle', '空闲'], ['orbIdle', '球待机'],
    ];
    const loadTheme = () => {
      try { return { ...DEFAULT_THEME, ...JSON.parse(localStorage.getItem(THEME_KEY)) }; } catch {}
      return { ...DEFAULT_THEME };
    };
    const hexToRgba = (hex, a) => {
      const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
      if (!m) return `rgba(76,141,255,${a})`;
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };
    const POS_KEY = 'sb-orb-pos';
    const loadPos = () => {
      try {
        const p = JSON.parse(localStorage.getItem(POS_KEY));
        if (p && Number.isFinite(p.right) && Number.isFinite(p.bottom)) return p;
      } catch {}
      return { right: 18, bottom: 18 };
    };

    const ZH = {
      'Session Board': '会话看板',
      Sub: '子代理',
      'No active sessions': '暂无活跃会话',
      'Clear idle': '清除空闲',
      Dismiss: '隐藏',
      Thinking: '思考中…',
      hidden: '其余 {n} 个空闲会话已折叠',
      'Load failed': '加载失败',
      'just now': '刚刚',
      minutes: '{n} 分钟',
      hours: '{n} 小时',
      days: '{n} 天',
      ago: '{t}前',
    };

    let localeSvc;
    let openSessionNav;
    let sessionsSvc;
    const getT = () => {
      const id = String(localeSvc?.getLocale?.()?.id ?? 'en').toLowerCase();
      const dict = id.startsWith('zh') ? ZH : {};
      return (key, vars) => {
        let s = dict[key] ?? key;
        if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
        return s;
      };
    };

    const fmtTokens = n => {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '';
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
      return String(n);
    };

    const fmtAgo = (ts, t) => {
      if (!ts) return '';
      const s = Math.max(0, Date.now() - ts) / 1000;
      if (s < 60) return t('just now');
      const m = Math.floor(s / 60);
      const hh = Math.floor(m / 60);
      const d = Math.floor(hh / 24);
      const v = d > 0 ? t('days', { n: d }) : hh > 0 ? t('hours', { n: hh }) : t('minutes', { n: m });
      return t('ago', { t: v });
    };

    const cwdTail = cwd => {
      if (!cwd) return '';
      const parts = String(cwd).split(/[\\/]/).filter(Boolean);
      return parts[parts.length - 1] ?? '';
    };

    // Gray context-usage ring (2π×6.5 ≈ 40.84 stroke length).
    const RING_LEN = 40.84;
    const Ring = ({ pct }) => h('svg', { className: 'sb-ring', viewBox: '0 0 16 16', 'aria-hidden': true },
      h('circle', { className: 'sb-ring-bg', cx: 8, cy: 8, r: 6.5 }),
      pct != null
        ? h('circle', {
            className: 'sb-ring-fg', cx: 8, cy: 8, r: 6.5,
            strokeDasharray: `${(Math.min(100, Math.max(0, pct)) / 100) * RING_LEN} ${RING_LEN}`,
          })
        : null,
    );

    const badgeTitle = q => q?.kind === 'volc'
      ? `近 5 小时窗口（本地按模型调用统计）：${q.calls ?? 0} 次请求 · ${fmtTokens(q.tokens)} tokens`
      : q?.kind === 'deepseek' ? 'DeepSeek API 余额（由 dsh-usage 插件刷新）' : '';

    const postJSON = (route, body) => fetch(route, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => null);

    const CSS = `
.sb-root{position:fixed;right:18px;bottom:18px;z-index:900;font-family:inherit}
.sb-orb{position:relative;width:var(--sb-orb-size);height:var(--sb-orb-size);border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer;display:grid;place-items:center;box-shadow:0 6px 20px rgba(0,0,0,.25);transition:transform .15s ease,box-shadow .15s ease;padding:0;touch-action:none;user-select:none}
.sb-orb:hover{transform:scale(1.06)}
.sb-orb-dot{width:calc(var(--sb-orb-size)*0.32);height:calc(var(--sb-orb-size)*0.32);border-radius:50%;background:var(--sb-idle)}
.sb-pulse{animation:sb-pulse 2.2s ease-in-out infinite}
@keyframes sb-pulse{0%,100%{filter:brightness(1);box-shadow:0 0 0 0 var(--sb-running-glow)}50%{filter:brightness(1.9) saturate(.85);box-shadow:0 0 0 9px var(--sb-running-glow0)}}
.sb-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 4px;border-radius:999px;background:var(--sb-running);color:#fff;font-size:11px;font-weight:600;line-height:18px;text-align:center;box-sizing:border-box}
.sb-panel{position:absolute;right:0;bottom:var(--sb-panel-bottom);width:350px;max-height:min(64vh,560px);display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.28);overflow:hidden;text-align:left}
.sb-panel-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px;flex:none}
.sb-close{border:0;background:none;color:var(--dsw-alias-label-tertiary);font-size:16px;cursor:pointer;line-height:1;padding:2px 6px}
.sb-close:hover{color:var(--dsw-alias-label-primary)}
.sb-rows{overflow-y:auto;padding:2px 0}
.sb-row{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);cursor:pointer}
.sb-row-active{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--sb-running)}
.sb-row:last-child{border-bottom:0}
.sb-row:hover{background:var(--dsw-alias-bg-layer-2)}
.sb-row-head{display:flex;align-items:center;gap:8px;min-width:0}
.sb-dot{width:9px;height:9px;border-radius:50%;flex:none}
.sb-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px}
.sb-tag{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px;line-height:16px}
.sb-row-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.sb-row-sub{margin:3px 0 0 17px;color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-row-detail{margin:3px 0 0 17px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-detail-failed{color:var(--sb-failed)}
.sb-detail-blocked{color:var(--sb-blocked)}
.sb-error{padding:8px 12px;color:var(--sb-failed);font-size:12px}
.sb-empty{padding:18px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
.sb-hidden{padding:8px 12px;color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:center}
.sb-head-actions{display:flex;align-items:center;gap:6px}
.sb-clear{border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 8px;border-radius:6px;cursor:pointer}
.sb-clear:hover{color:var(--dsw-alias-label-primary)}
.sb-icon{border:0;background:none;color:var(--dsw-alias-label-tertiary);width:22px;height:22px;border-radius:6px;display:grid;place-items:center;font-size:13px;line-height:1;padding:0;cursor:pointer}
.sb-icon:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.sb-icon-close{font-size:15px}
.sb-x{border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1;padding:0 2px;visibility:hidden}
.sb-row:hover .sb-x{visibility:visible}
.sb-x:hover{color:var(--dsw-alias-label-primary)}
.sb-dot.sb-breathe{animation:sb-breathe 2.2s ease-in-out infinite}
@keyframes sb-breathe{0%,100%{filter:brightness(1);box-shadow:0 0 0 0 var(--sb-running-glow)}50%{filter:brightness(1.9) saturate(.85);box-shadow:0 0 0 7px var(--sb-running-glow0)}}
.sb-preview{margin:3px 0 0 17px;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;word-break:break-all}
.sb-preview-live{color:#7aa9ff}
.sb-row-meta{display:inline-flex;align-items:center;gap:3px}
.sb-ring{width:12px;height:12px;transform:rotate(-90deg);flex:none}
.sb-ring-bg,.sb-ring-fg{fill:none;stroke-width:2.5}
.sb-ring-bg{stroke:var(--dsw-alias-border-l2)}
.sb-ring-fg{stroke:var(--dsw-alias-label-tertiary);stroke-linecap:round}
.sb-sep{color:var(--dsw-alias-border-l2)}
.sb-quota{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.sb-theme{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.sb-theme-item{display:inline-flex;align-items:center;gap:3px;font-size:10px;color:var(--dsw-alias-label-secondary)}
.sb-theme-item input[type=color]{width:20px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;background:none;cursor:pointer}
.sb-theme-item input[type=color]::-webkit-color-swatch-wrapper{padding:0;border:0}
.sb-theme-item input[type=color]::-webkit-color-swatch{border:none;border-radius:50%}
.sb-theme-item input[type=number]{width:44px;font-size:11px;padding:1px 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sb-theme-item input[type=checkbox]{accent-color:var(--sb-running);margin:0;cursor:pointer}
`;

    function BoardRow({ row, t, onDismiss, onOpen, active, theme }) {
      return h('div', {
        className: 'sb-row' + (active ? ' sb-row-active' : ''),
        key: row.id,
        onClick: () => onOpen?.(row.id),
      },
        h('div', { className: 'sb-row-head' },
          h('span', { className: 'sb-dot' + (theme.breathe && (row.status === 'running' || row.status === 'working') ? ' sb-breathe' : ''), style: { background: theme[row.status] ?? theme.idle } }),
          h('span', { className: 'sb-row-title', title: row.id ? `${row.title} · ${row.id}` : row.title }, row.title),
          row.kind === 'sub' ? h('span', { className: 'sb-tag' }, t('Sub')) : null,
          (row.tokens != null || row.spent != null || row.ctxPct != null)
            ? h('span', {
                className: 'sb-row-meta',
                title: `上下文 ≈ ${row.ctxPct != null ? `${Math.round(row.ctxPct)}%` : '?'} · ${row.tokens ?? 0} tokens`
                  + (row.spent != null ? `\n累计消耗 ${fmtTokens(row.spent)} tokens` : ''),
              },
                h(Ring, { pct: row.ctxPct }),
                row.ctxPct != null ? h('span', null, `${Math.round(row.ctxPct)}%`) : null,
                (row.spent ?? row.tokens) != null ? h('span', null, fmtTokens(row.spent ?? row.tokens)) : null,
              )
            : null,
          onDismiss && (row.status === 'idle' || row.status === 'failed')
            ? h('button', {
                className: 'sb-x',
                onClick: e => {
                  e.stopPropagation();
                  if (row.status === 'failed') postJSON('api/session-board/clear-failed', { id: row.id });
                  onDismiss(row.id);
                },
                title: t('Dismiss'),
              }, '×')
            : null,
        ),
        row.preview || row.status === 'running' || row.status === 'working'
          ? h('div', { className: 'sb-preview' + (row.status === 'running' ? ' sb-preview-live' : ''), title: row.preview || undefined },
              row.preview || t('Thinking'))
          : null,
        (row.workspace || row.cwd || row.updatedAt)
          ? h('div', { className: 'sb-row-sub' },
            [row.workspace || cwdTail(row.cwd), fmtAgo(row.updatedAt, t)].filter(Boolean).join(' · '))
          : null,
        row.detail
          ? h('div', { className: `sb-row-detail sb-detail-${row.status}`, title: row.detail }, row.detail)
          : null,
      );
    }

    function SessionBoardOrb() {
      const [open, setOpen] = React.useState(false);
      const openRef = React.useRef(false);
      openRef.current = open;
      const [data, setData] = React.useState({ rows: [], hidden: 0, providers: [], error: '' });
      const [dismissed, setDismissed] = React.useState(() => new Set());
      const [pos, setPos] = React.useState(loadPos);
      const posRef = React.useRef(pos);
      posRef.current = pos;
      const dragRef = React.useRef(null);
      const onOrbPointerDown = e => {
        if (e.button !== 0) return;
        dragRef.current = { sx: e.clientX, sy: e.clientY, right: pos.right, bottom: pos.bottom, moved: false };
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
      };
      const onOrbPointerMove = e => {
        const d = dragRef.current;
        if (!d) return;
        const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
        if (!d.moved && Math.hypot(dx, dy) < 5) return;
        d.moved = true;
        setPos({
          right: Math.min(Math.max(4, d.right - dx), window.innerWidth - 60),
          bottom: Math.min(Math.max(4, d.bottom - dy), window.innerHeight - 60),
        });
      };
      const onOrbPointerUp = e => {
        const d = dragRef.current;
        dragRef.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
        if (d?.moved) {
          try { localStorage.setItem(POS_KEY, JSON.stringify(posRef.current)); } catch {}
          return;
        }
        setOpen(o => !o);
      };
      const [, force] = React.useState(0);
      const [theme, setTheme] = React.useState(loadTheme);
      const themeRef = React.useRef(theme);
      themeRef.current = theme;
      const [showSettings, setShowSettings] = React.useState(false);
      const setThemeField = (k, v) => setTheme(t => {
        const n = { ...t, [k]: v };
        try { localStorage.setItem(THEME_KEY, JSON.stringify(n)); } catch {}
        return n;
      });
      const resetTheme = () => {
        try { localStorage.removeItem(THEME_KEY); } catch {}
        setTheme({ ...DEFAULT_THEME });
      };

      React.useEffect(() => {
        if (!localeSvc?.subscribe) return undefined;
        return localeSvc.subscribe(() => force(n => n + 1));
      }, []);

      React.useEffect(() => {
        let stop = false;
        let timer = null;
        const tick = async () => {
          if (!document.hidden) {
            try {
              const res = await fetch(ROUTE, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: '{}',
              });
              const json = await res.json();
              if (!stop) {
                const errMsg = json?.error ? String(json.error?.message ?? json.error) : '';
                setData(json?.ok && !errMsg
                  ? {
                      rows: Array.isArray(json.rows) ? json.rows : [],
                      hidden: json.hidden ?? 0,
                      providers: Array.isArray(json.providers) ? json.providers : [],
                      error: '',
                    }
                  : {
                      rows: Array.isArray(json?.rows) ? json.rows : [],
                      hidden: 0,
                      providers: [],
                      error: errMsg || 'Load failed',
                    });
              }
            } catch (error) {
              if (!stop) setData({ rows: [], hidden: 0, providers: [], error: String(error?.message ?? error) });
            }
          }
          if (!stop) timer = setTimeout(tick, openRef.current ? LIVE_POLL_MS : POLL_MS);
        };
        tick();
        return () => { stop = true; if (timer) clearTimeout(timer); };
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = e => { if (e.key === 'Escape') setOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [open]);

      const t = getT();
      const { rows } = data;
      const dismiss = id => setDismissed(prev => { const n = new Set(prev); n.add(id); return n; });
      // 清除空闲: hide idle rows locally AND clear observed failures server-side,
      // so the orb returns to normal until a new error actually occurs.
      const clearIdle = () => {
        setDismissed(prev => {
          const n = new Set(prev);
          for (const r of rows) if (r.status === 'idle') n.add(r.id);
          return n;
        });
        postJSON('api/session-board/clear-failed', {});
      };
      const shown = rows.filter(r => r.status === 'running' || r.status === 'blocked' || r.status === 'working' || !dismissed.has(r.id));

      // Dismissal is one-shot: once a hidden session becomes active again
      // (running / blocked / failed), lift the dismissal so it keeps showing
      // normally after the task ends instead of vanishing again.
      React.useEffect(() => {
        if (rows.some(r => r.status !== 'idle')) {
          setDismissed(prev => {
            const n = new Set(prev);
            let changed = false;
            for (const r of rows) if (r.status !== 'idle' && n.has(r.id)) { n.delete(r.id); changed = true; }
            return changed ? n : prev;
          });
        }
      }, [rows]);

      // Visiting a session in the main view lifts its dismissal too: switching
      // to a workspace/conversation counts as renewed interest in it.
      const [currentId, setCurrentId] = React.useState('');
      React.useEffect(() => {
        const store = sessionsSvc?.list;
        if (!store?.getSnapshot) return undefined;
        const lift = () => {
          try {
            const entry = Object.entries(store.getSnapshot()?.byId ?? {})
              .find(([, row]) => (row?.retainedBy?.mainView ?? 0) > 0);
            const id = entry?.[0] ?? '';
            setCurrentId(prev => (prev === id ? prev : id));
            if (id) setDismissed(prev => {
              if (!prev.has(id)) return prev;
              const n = new Set(prev);
              n.delete(id);
              return n;
            });
          } catch {}
        };
        lift();
        if (store.subscribe) {
          const off = store.subscribe(lift);
          return () => { try { off?.(); } catch {} };
        }
        const timer = setInterval(lift, 1000);
        return () => clearInterval(timer);
      }, []);

      const active = rows.filter(r => r.status === 'running' || r.status === 'blocked' || r.status === 'working' || r.status === 'failed');
      const anyRunning = rows.some(r => r.status === 'running');
      const anyWorking = rows.some(r => r.status === 'working');
      const anyBlocked = rows.some(r => r.status === 'blocked');
      const anyFailed = rows.some(r => r.status === 'failed');
      const orbColor = anyFailed ? theme.failed : anyBlocked ? theme.blocked : anyRunning ? theme.running : anyWorking ? theme.working : theme.orbIdle;

      const cssVars = {
        '--sb-running': theme.running,
        '--sb-running-glow': hexToRgba(theme.running, 0.6),
        '--sb-running-glow0': hexToRgba(theme.running, 0),
        '--sb-working': theme.working,
        '--sb-blocked': theme.blocked,
        '--sb-failed': theme.failed,
        '--sb-idle': theme.idle,
        '--sb-orb-size': `${theme.orbSize}px`,
        '--sb-panel-bottom': `${theme.orbSize + 10}px`,
      };

      return h('div', { className: 'sb-root', style: { right: pos.right, bottom: pos.bottom, ...cssVars } },
        h('style', null, CSS),
        open
          ? h('div', { className: 'sb-panel', role: 'dialog', 'aria-label': t('Session Board') },
            h('div', { className: 'sb-panel-head' },
              h('span', null, t('Session Board')),
              h('div', { className: 'sb-head-actions' },
                (data.providers ?? []).map((q, i) => h('span', {
                  className: 'sb-quota',
                  key: i,
                  title: badgeTitle(q),
                },
                  q.kind === 'volc'
                    ? ['⚡', `${q.calls ?? 0}次`, h('span', { className: 'sb-sep' }, '·'), '🪙', fmtTokens(q.tokens)]
                    : [`💰¥${q.balance}`],
                )),
                h('button', { className: 'sb-icon', onClick: clearIdle, title: t('Clear idle') }, '🧹'),
                h('button', {
                  className: 'sb-icon',
                  onClick: () => setShowSettings(s => !s),
                  title: '自定义颜色与悬浮球',
                }, '⚙'),
                h('button', { className: 'sb-icon sb-icon-close', onClick: () => setOpen(false), title: '关闭', 'aria-label': 'close' }, '×'),
              ),
            ),
            showSettings ? h('div', { className: 'sb-theme' },
              COLOR_FIELDS.map(([k, label]) => h('label', { className: 'sb-theme-item', key: k },
                label,
                h('input', {
                  type: 'color',
                  value: theme[k],
                  onChange: e => setThemeField(k, e.target.value),
                }),
              )),
              h('label', { className: 'sb-theme-item' }, '球径',
                h('input', {
                  type: 'number', min: 28, max: 96,
                  value: theme.orbSize,
                  onChange: e => setThemeField('orbSize', Math.max(28, Math.min(96, Math.round(+e.target.value || 44)))),
                }),
              ),
              h('label', { className: 'sb-theme-item' }, '颜色呼吸',
                h('input', {
                  type: 'checkbox',
                  checked: theme.breathe !== false,
                  onChange: e => setThemeField('breathe', e.target.checked),
                }),
              ),
              h('button', { className: 'sb-clear', onClick: resetTheme }, '默认'),
            ) : null,
            data.error ? h('div', { className: 'sb-error' }, `${t('Load failed')}: ${data.error}`) : null,
            h('div', { className: 'sb-rows' },
              shown.length === 0 && !data.error ? h('div', { className: 'sb-empty' }, t('No active sessions')) : null,
              shown.map(row => h(BoardRow, {
                row, t, key: row.id, onDismiss: dismiss,
                active: row.id === currentId,
                theme,
                onOpen: id => { openSessionNav?.(id); },
              })),
              data.hidden > 0 ? h('div', { className: 'sb-hidden' }, t('hidden', { n: data.hidden })) : null,
            ),
          )
          : null,
        h('button', {
          className: 'sb-orb',
          // Size inline (not just the CSS var) so it can never fall back during
          // any state change; boxShadow only when something is active.
          style: {
            width: theme.orbSize,
            height: theme.orbSize,
            ...(open || anyRunning || anyBlocked || anyFailed || anyWorking
              ? { boxShadow: `0 0 0 3px ${hexToRgba(orbColor, 0.27)}, 0 6px 20px rgba(0,0,0,.25)` }
              : {}),
          },
          onPointerDown: onOrbPointerDown,
          onPointerMove: onOrbPointerMove,
          onPointerUp: onOrbPointerUp,
          title: t('Session Board'),
          'aria-expanded': open,
        },
          h('span', { className: 'sb-orb-dot' + (theme.breathe && (anyRunning || anyWorking) ? ' sb-pulse' : ''), style: { background: orbColor } }),
          active.length > 0 ? h('span', { className: 'sb-badge' }, String(active.length)) : null,
        ),
      );
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        localeSvc = ctx.locale;
        sessionsSvc = ctx.sessions;
        // Navigate the main view to a session; the workspace service owns switching.
        openSessionNav = id => {
          try { ctx.get('uiWorkspace')?.openSession?.(String(id)); } catch {}
        };
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-board-orb',
          order: 90,
          label: () => getT()('Session Board'),
        }, SessionBoardOrb));
      },
    };
  },
});
