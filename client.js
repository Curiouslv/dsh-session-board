// Client half: a floating orb (bottom-right) that expands into the session board.
// Data comes from this package's Host half via POST api/session-board.
window.__ModuleLoader__.load({
  id: '@local/session-board',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = 'api/session-board';
    const POLL_MS = 2500;
    const LIVE_POLL_MS = 1200;
    const COLORS = { running: '#4c8dff', blocked: '#f5b73e', failed: '#ef5350', idle: '#9aa3ab' };
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

    // Gray context-usage ring; tone 'time' renders amber (2π×6.5 ≈ 40.84 stroke).
    const RING_LEN = 40.84;
    const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
    const Ring = ({ pct, tone }) => h('svg', { className: 'sb-ring', viewBox: '0 0 16 16', 'aria-hidden': true },
      h('circle', { className: 'sb-ring-bg', cx: 8, cy: 8, r: 6.5 }),
      pct != null
        ? h('circle', {
            className: 'sb-ring-fg' + (tone === 'time' ? ' sb-ring-time' : ''), cx: 8, cy: 8, r: 6.5,
            strokeDasharray: `${(Math.min(100, Math.max(0, pct)) / 100) * RING_LEN} ${RING_LEN}`,
          })
        : null,
    );

    const fmtCountdown = ms => {
      if (!(ms > 0)) return '';
      const s = Math.floor(ms / 1000);
      const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
      return `剩${hh}:${String(mm).padStart(2, '0')}`;
    };

    // "2:45" / "2时45" / "2h45" → 2.75h; plain numbers stay decimal hours.
    const parseHours = s => {
      const t = String(s ?? '').trim();
      if (!t) return NaN;
      const m = t.match(/^(\d+(?:\.\d+)?)\s*(?:[:：h时]\s*(\d{1,2}))?$/);
      if (!m) return NaN;
      return Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
    };

    const badgeTitle = q => q?.kind === 'volc'
      ? `火山 coding plan 近5小时请求量（按次限额；本地估算${q.pct != null ? '，已校准' : ''}；点击校准）`
      : q?.kind === 'deepseek' ? 'DeepSeek API 余额（由 dsh-usage 插件刷新）' : '';

    const postJSON = (route, body) => fetch(route, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => null);

    const CSS = `
.sb-root{position:fixed;right:18px;bottom:18px;z-index:900;font-family:inherit}
.sb-orb{position:relative;width:44px;height:44px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer;display:grid;place-items:center;box-shadow:0 6px 20px rgba(0,0,0,.25);transition:transform .15s ease,box-shadow .15s ease;padding:0;touch-action:none;user-select:none}
.sb-orb:hover{transform:scale(1.06)}
.sb-orb-dot{width:14px;height:14px;border-radius:50%;background:${COLORS.idle}}
.sb-pulse{animation:sb-pulse 2.2s ease-in-out infinite}
@keyframes sb-pulse{0%,100%{opacity:1}50%{opacity:.4}}
.sb-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 4px;border-radius:999px;background:${COLORS.running};color:#fff;font-size:11px;font-weight:600;line-height:18px;text-align:center;box-sizing:border-box}
.sb-panel{position:absolute;right:0;bottom:54px;width:350px;max-height:min(64vh,560px);display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.28);overflow:hidden;text-align:left}
.sb-panel-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px;flex:none}
.sb-close{border:0;background:none;color:var(--dsw-alias-label-tertiary);font-size:16px;cursor:pointer;line-height:1;padding:2px 6px}
.sb-close:hover{color:var(--dsw-alias-label-primary)}
.sb-rows{overflow-y:auto;padding:2px 0}
.sb-row{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);cursor:pointer}
.sb-row:last-child{border-bottom:0}
.sb-row:hover{background:var(--dsw-alias-bg-layer-2)}
.sb-row-head{display:flex;align-items:center;gap:8px;min-width:0}
.sb-dot{width:9px;height:9px;border-radius:50%;flex:none}
.sb-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px}
.sb-tag{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px;line-height:16px}
.sb-row-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.sb-row-sub{margin:3px 0 0 17px;color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-row-detail{margin:3px 0 0 17px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-detail-failed{color:${COLORS.failed}}
.sb-detail-blocked{color:${COLORS.blocked}}
.sb-error{padding:8px 12px;color:${COLORS.failed};font-size:12px}
.sb-empty{padding:18px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
.sb-hidden{padding:8px 12px;color:var(--dsw-alias-label-tertiary);font-size:11px;text-align:center}
.sb-head-actions{display:flex;align-items:center;gap:6px}
.sb-clear{border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 8px;border-radius:6px;cursor:pointer}
.sb-clear:hover{color:var(--dsw-alias-label-primary)}
.sb-x{border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1;padding:0 2px;visibility:hidden}
.sb-row:hover .sb-x{visibility:visible}
.sb-x:hover{color:var(--dsw-alias-label-primary)}
.sb-dot.sb-breathe{animation:sb-breathe 2.2s ease-in-out infinite}
@keyframes sb-breathe{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(76,141,255,.45)}50%{opacity:.55;box-shadow:0 0 0 5px rgba(76,141,255,0)}}
.sb-preview{margin:3px 0 0 17px;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;word-break:break-all}
.sb-preview-live{color:#7aa9ff}
.sb-row-meta{display:inline-flex;align-items:center;gap:3px}
.sb-ring{width:12px;height:12px;transform:rotate(-90deg);flex:none}
.sb-ring-bg,.sb-ring-fg{fill:none;stroke-width:2.5}
.sb-ring-bg{stroke:var(--dsw-alias-border-l2)}
.sb-ring-fg{stroke:var(--dsw-alias-label-tertiary);stroke-linecap:round}
.sb-ring-time{stroke:#f5b73e}
.sb-sep{color:var(--dsw-alias-border-l2)}
.sb-quota{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.sb-quota-btn{cursor:pointer}
.sb-quota-btn:hover{color:var(--dsw-alias-label-primary)}
.sb-calib{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.sb-calib-input{width:86px;font-size:11px;padding:2px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sb-calib-err{color:#ef5350;font-size:10px;white-space:normal;line-height:1.3}
`;

    function BoardRow({ row, t, onDismiss, onOpen }) {
      return h('div', {
        className: 'sb-row',
        key: row.id,
        onClick: () => onOpen?.(row.id),
      },
        h('div', { className: 'sb-row-head' },
          h('span', { className: 'sb-dot' + (row.status === 'running' ? ' sb-breathe' : ''), style: { background: COLORS[row.status] ?? COLORS.idle } }),
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
            ? h('button', { className: 'sb-x', onClick: e => { e.stopPropagation(); onDismiss(row.id); }, title: t('Dismiss') }, '×')
            : null,
        ),
        row.preview || row.status === 'running'
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
      const [calib, setCalib] = React.useState(false);
      const [calibVal, setCalibVal] = React.useState('');
      const [calibHours, setCalibHours] = React.useState('');
      const [calibQuota, setCalibQuota] = React.useState('');
      const [calibErr, setCalibErr] = React.useState('');
      const submitCalib = async () => {
        const pct = parseFloat(calibVal);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) { setCalibErr('百分比需在 0-100'); return; }
        const hours = parseHours(calibHours);
        const quota = parseFloat(calibQuota);
        if (calibHours.trim() && (!Number.isFinite(hours) || hours <= 0)) { setCalibErr('剩余时间格式如 2:45 或 2.75'); return; }
        const res = await postJSON('api/session-board/calibrate', {
          pct,
          ...(Number.isFinite(hours) && hours > 0 ? { hours } : {}),
          ...(Number.isFinite(quota) && quota > 0 ? { quotaCalls: quota } : {}),
        });
        if (res?.ok) setCalib(false);
        else setCalibErr(String(res?.error ?? '校准失败'));
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
      const clearIdle = () => setDismissed(prev => {
        const n = new Set(prev);
        for (const r of rows) if (r.status === 'idle') n.add(r.id);
        return n;
      });
      const shown = rows.filter(r => r.status === 'running' || r.status === 'blocked' || !dismissed.has(r.id));
      const active = rows.filter(r => r.status === 'running' || r.status === 'blocked' || r.status === 'failed');
      const anyRunning = rows.some(r => r.status === 'running');
      const anyBlocked = rows.some(r => r.status === 'blocked');
      const anyFailed = rows.some(r => r.status === 'failed');
      const orbColor = anyFailed ? COLORS.failed : anyBlocked ? COLORS.blocked : anyRunning ? COLORS.running : '#3ecf6f';

      return h('div', { className: 'sb-root', style: { right: pos.right, bottom: pos.bottom } },
        h('style', null, CSS),
        open
          ? h('div', { className: 'sb-panel', role: 'dialog', 'aria-label': t('Session Board') },
            h('div', { className: 'sb-panel-head' },
              h('span', null, t('Session Board')),
              h('div', { className: 'sb-head-actions' },
                (data.providers ?? []).map((q, i) => h('span', {
                  className: 'sb-quota' + (q.kind === 'volc' ? ' sb-quota-btn' : ''),
                  key: i,
                  title: badgeTitle(q),
                  onClick: q.kind === 'volc'
                    ? () => { setCalibVal(''); setCalibHours(''); setCalibQuota(''); setCalibErr(''); setCalib(true); }
                    : undefined,
                },
                  q.kind === 'volc'
                    ? [
                        '⚡',
                        q.pct != null ? h(Ring, { pct: q.pct }) : null,
                        q.pct != null ? `${q.pct.toFixed(1)}%` : null,
                        q.resetAt
                          ? [
                              h('span', { className: 'sb-sep' }, '·'),
                              h(Ring, { pct: Math.max(0, Math.min(100, (q.resetAt - Date.now()) / FIVE_HOUR_MS * 100)), tone: 'time' }),
                              fmtCountdown(q.resetAt - Date.now()) || '已重置',
                            ]
                          : '5h',
                        h('span', { className: 'sb-sep' }, '·'),
                        `${q.calls ?? 0}次`,
                      ]
                    : [`💰¥${q.balance}`],
                )),
                h('button', { className: 'sb-clear', onClick: clearIdle, title: t('Clear idle') }, t('Clear idle')),
                h('button', { className: 'sb-close', onClick: () => setOpen(false), 'aria-label': 'close' }, '×'),
              ),
            ),
            calib ? h('div', { className: 'sb-calib' },
              h('input', {
                className: 'sb-calib-input', type: 'number', step: '0.01', min: '0', max: '100',
                placeholder: '控制台%', value: calibVal,
                onChange: e => setCalibVal(e.target.value),
                onKeyDown: e => { if (e.key === 'Enter') submitCalib(); },
                autoFocus: true,
              }),
              h('input', {
                className: 'sb-calib-input', type: 'text',
                placeholder: '剩余时 如2:45', value: calibHours,
                onChange: e => setCalibHours(e.target.value),
                onKeyDown: e => { if (e.key === 'Enter') submitCalib(); },
              }),
              h('input', {
                className: 'sb-calib-input', type: 'number', step: '1', min: '0',
                placeholder: '配额次(可选)', value: calibQuota,
                onChange: e => setCalibQuota(e.target.value),
                onKeyDown: e => { if (e.key === 'Enter') submitCalib(); },
              }),
              h('button', { className: 'sb-clear', onClick: submitCalib }, '校准'),
              h('button', { className: 'sb-clear', onClick: () => setCalib(false) }, '取消'),
              calibErr ? h('span', { className: 'sb-calib-err' }, calibErr) : null,
            ) : null,
            data.error ? h('div', { className: 'sb-error' }, `${t('Load failed')}: ${data.error}`) : null,
            h('div', { className: 'sb-rows' },
              shown.length === 0 && !data.error ? h('div', { className: 'sb-empty' }, t('No active sessions')) : null,
              shown.map(row => h(BoardRow, {
                row, t, key: row.id, onDismiss: dismiss,
                onOpen: id => { openSessionNav?.(id); setOpen(false); },
              })),
              data.hidden > 0 ? h('div', { className: 'sb-hidden' }, t('hidden', { n: data.hidden })) : null,
            ),
          )
          : null,
        h('button', {
          className: 'sb-orb',
          style: open || anyRunning || anyBlocked || anyFailed
            ? { boxShadow: `0 0 0 3px ${orbColor}44, 0 6px 20px rgba(0,0,0,.25)` }
            : undefined,
          onPointerDown: onOrbPointerDown,
          onPointerMove: onOrbPointerMove,
          onPointerUp: onOrbPointerUp,
          title: t('Session Board'),
          'aria-expanded': open,
        },
          h('span', { className: 'sb-orb-dot' + (anyRunning ? ' sb-pulse' : ''), style: { background: orbColor } }),
          active.length > 0 ? h('span', { className: 'sb-badge' }, String(active.length)) : null,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        localeSvc = ctx.locale;
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
