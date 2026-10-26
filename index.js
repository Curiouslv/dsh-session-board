// Host half of the session board bundle.
//
// Serves POST api/session-board: one snapshot of every session this Host knows,
// across all workspaces, with a per-session status:
//   blocked  — an approval or user question is waiting (waterfall listeners)
//   running  — a live agent with status 'running'
//   failed   — the last observed error, until the session runs again
//   idle     — everything else (shown only while recently active)
// Main sessions and subagents are told apart via ctx.agents.roots().

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROUTE = '/api/session-board';
const RECENT_MS = 6 * 60 * 60 * 1000; // idle sessions stay listed for 6h of inactivity
const MAX_ROWS = 40;

// Static context windows (tokens) for the models configured on this machine.
// ponytail: source of truth is the profile's llm model list; extend here when models change.
const MODEL_CONTEXT = {
  'glm-5.3-flash': 1024000,
  'glm-5.3-flash-deep': 1024000,
  'glm-5.3': 1024000,
  'deepseek-v4-1-flash-261017': 1024000,
  'deepseek-v4-1-flash-economy': 1000000,
  'doubao-seed-2.0-mini': 256000,
  'deepseek-v4-flash': 1000000,
  'deepseek-v4-pro': 1000000,
  'deepseek-flash': 1000000,
  'deepseek-v4.1-flash': 1000000,
};
const USAGE_DIR = join(homedir(), '.dsh', 'dsh-usage');
const SNAPSHOTS_FILE = join(USAGE_DIR, 'provider-snapshots.json');
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

// Last path segment of a cwd (also the workspace name fallback).
const cwdTail = p => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
// Semantic text from message content blocks (text + reasoning; tool-call blocks are skipped).
const blocksText = content => Array.isArray(content)
  ? content.map(b => b && typeof b === 'object'
    ? String(b.type === 'text' ? (b.text ?? '') : b.type === 'reasoning' ? (b.text ?? b.summary ?? '') : '')
    : '').filter(Boolean).join(' ')
  : '';

function safe(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export const inject = ['connection', 'sessions', 'agents', 'sessionQuery', 'workspaceRegistry', 'tokenMeter'];

export function apply(ctx) {
  /** sessionId -> { count, detail } for pending approvals / questions. */
  const blocked = new Map();
  /** sessionId -> { message, at } for the last observed error. */
  const errors = new Map();
  /** sessionId -> { kind, text, at } for the newest meaningful event (live preview). */
  const activity = new Map();
  /** sessionId -> log-backed title text ('' once checked and absent). */
  const titles = new Map();
  /** sessionId -> preview of the first human prompt, used when the session has no title. */
  const firstPrompt = new Map();
  /** sessionId -> when the first-prompt seed last ran (retries on new activity). */
  const firstPromptAt = new Map();
  let titlesInFlight = false;
  let lastEmptyTitlesCheck = 0;
  let promptQueue = Promise.resolve();
  /** Rolling 5h request/token window for the volc coding plan. */
  const volcWindow = [];
  // The window survives restarts: entries are persisted to disk (throttled).
  const WINDOW_FILE = join(USAGE_DIR, 'session-board-window.json');
  let windowDirty = false;
  let windowSavedAt = 0;
  function loadWindow() {
    const raw = readJson(WINDOW_FILE);
    if (Array.isArray(raw)) {
      const cutoff = Date.now() - FIVE_HOUR_MS;
      for (const e of raw) {
        const at = Number(e?.at);
        if (Number.isFinite(at) && at > cutoff) volcWindow.push({ at, tokens: Number(e?.tokens) || 0 });
      }
    }
  }
  function saveWindow(force = false) {
    if (!windowDirty && !force) return;
    if (!force && Date.now() - windowSavedAt < 30 * 1000) return;
    volc5hPrune();
    try {
      writeFileSync(WINDOW_FILE, JSON.stringify(volcWindow));
      windowDirty = false;
      windowSavedAt = Date.now();
    } catch {}
  }
  loadWindow();
  /** sessionId -> provider id from the latest request/header event. */
  const routeOf = new Map();
  let snapCache = { at: 0, providers: null };
  /** sessionId -> cumulative tokens consumed (all buckets), from session events. */
  const cumulative = new Map();

  const sessionIdOf = request =>
    request?.agent?.session?.id ?? request?.agent?.id ?? request?.sessionId;

  const trackBlocked = (request, detail) => {
    const sessionId = sessionIdOf(request);
    if (!sessionId) return () => {};
    const key = String(sessionId);
    const entry = blocked.get(key) ?? { count: 0, detail: '' };
    entry.count += 1;
    entry.detail = String(detail).slice(0, 120);
    blocked.set(key, entry);
    return () => {
      const e = blocked.get(key);
      if (!e) return;
      e.count -= 1;
      if (e.count <= 0) blocked.delete(key);
    };
  };

  // Observe-only waterfall wrappers: the session is "blocked" while next() is in flight.
  ctx.effect(() => ctx.on('approval/request', (request, next) => {
    const settle = trackBlocked(request, `审批: ${String(request?.toolName ?? 'tool')}`);
    return Promise.resolve(next()).finally(settle);
  }), 'session-board: approvals');

  ctx.effect(() => ctx.on('user-questions/request', (request, next) => {
    const q = request?.request?.questions?.[0]?.question ?? request?.questions?.[0]?.question ?? '提问';
    const settle = trackBlocked(request, `等待回答: ${String(q)}`);
    return Promise.resolve(next()).finally(settle);
  }), 'session-board: questions');

  ctx.effect(() => ctx.on('agent/error', payload => {
    const id = payload?.agent?.session?.id ?? payload?.agent?.id;
    if (id) errors.set(String(id), { message: String(payload?.error?.message ?? payload?.error ?? 'error').slice(0, 160), at: Date.now() });
  }), 'session-board: agent errors');

  ctx.effect(() => ctx.on('api-session/error', (sessionId, message) => {
    if (sessionId) errors.set(String(sessionId), { message: String(message ?? 'error').slice(0, 160), at: Date.now() });
  }), 'session-board: session errors');

  // Live activity: the newest meaningful event per session, so the board can
  // preview what a running task is doing/thinking without reading its log.
  function activityOf(event) {
    if (event?.type === 'assistant/message') {
      const text = blocksText(event.data?.message?.content);
      return text ? { kind: 'assistant', text } : null;
    }
    if (event?.type === 'user/message') {
      const text = blocksText(event.data?.content);
      return text ? { kind: 'user', text } : null;
    }
    if (event?.type === 'tool/call') {
      const args = typeof event.data?.arguments === 'string'
        ? event.data.arguments
        : safe(() => JSON.stringify(event.data?.arguments ?? ''), '');
      return { kind: 'tool', text: `${String(event.data?.name ?? 'tool')} ${args}` };
    }
    return null;
  }

  function noteEvent(sessionId, event) {
    const id = String(sessionId);
    if (event?.type === 'request/header') {
      const provider = String(event.data?.header?.config?.provider ?? event.data?.config?.provider ?? '');
      if (provider) routeOf.set(id, provider);
    }
    const entry = activityOf(event);
    if (entry) {
      activity.set(id, {
        kind: entry.kind,
        text: entry.text.replace(/\s+/g, ' ').trim().slice(0, 140),
        at: Date.now(),
      });
    }
    // Token accounting: per-session cumulative + volc 5h rolling window.
    const usage = event?.type === 'assistant/message' ? event.data?.usage : undefined;
    if (usage) {
      const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      cumulative.set(id, (cumulative.get(id) ?? 0) + total);
      if (/volc/i.test(routeOf.get(id) ?? '')) {
        volcWindow.push({ at: Date.now(), tokens: total });
        if (volcWindow.length > 500) volcWindow.splice(0, volcWindow.length - 500);
        windowDirty = true;
      }
    }
  }

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      const id = session?.id ?? session?.header?.id;
      if (id) noteEvent(id, event);
    } catch {
      // observation only; never disturb the session append path
    }
  }), 'session-board: live activity');

  // Safety net: a session already running before this plugin loaded has no
  // cached preview, so seed it from the tail of its own log once.
  async function seedActivity(sessionId) {
    try {
      const records = await ctx.sessionQuery.listEvents(sessionId);
      const lastSeq = records.at(-1)?.seq;
      if (lastSeq == null) return;
      const { events } = await ctx.sessionQuery.readEvent({ sessionId, seq: lastSeq, before: 20, after: 0 });
      for (let i = events.length - 1; i >= 0; i--) {
        if (activityOf(events[i])) {
          noteEvent(sessionId, events[i]);
          return;
        }
      }
    } catch {
      // a session without readable history simply shows no preview
    }
  }

  // Session display name: log-backed title, else the first human prompt, else 会话.
  async function refreshTitles(ids) {
    titlesInFlight = true;
    try {
      const results = await ctx.sessionQuery.readTitleSnapshots(ids);
      ids.forEach((id, i) => {
        const result = Array.isArray(results) ? results[i] : undefined;
        const value = result?.status === 'fulfilled' ? result.value : undefined;
        const raw = value?.title?.title ?? (typeof value?.title === 'string' ? value.title : '');
        titles.set(String(id), String(raw ?? '').trim());
      });
    } catch {
      // leave uncached; the next poll retries
    } finally {
      titlesInFlight = false;
    }
  }

  // Fallback name for sessions with no title event: their first human prompt.
  async function seedFirstPrompt(sessionId) {
    try {
      const { events } = await ctx.sessionQuery.readEvent({ sessionId, seq: 0, before: 0, after: 40 });
      for (const event of events) {
        if (event?.type !== 'user/message') continue;
        const text = blocksText(event.data?.content).replace(/\s+/g, ' ').trim();
        if (text) {
          firstPrompt.set(String(sessionId), text.slice(0, 40));
          return;
        }
      }
      firstPrompt.set(String(sessionId), '');
    } catch {
      firstPrompt.set(String(sessionId), '');
    }
  }

  function queueFirstPrompt(sessionId) {
    firstPromptAt.set(String(sessionId), Date.now());
    promptQueue = promptQueue.then(() => seedFirstPrompt(sessionId)).catch(() => {});
  }

  // One-time per session: sum usage over the whole current surface so the
  // cumulative counter covers history from before this plugin loaded.
  async function seedCumulative(sessionId) {
    try {
      const { events } = await ctx.sessionQuery.readSurface(sessionId);
      let total = 0;
      for (const event of events) {
        const u = event?.type === 'assistant/message' ? event.data?.usage : undefined;
        if (u) total += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
      }
      cumulative.set(String(sessionId), (cumulative.get(String(sessionId)) ?? 0) + total);
    } catch {
      cumulative.set(String(sessionId), cumulative.get(String(sessionId)) ?? 0);
    }
  }

  function queueCumulative(sessionId) {
    promptQueue = promptQueue.then(() => seedCumulative(sessionId)).catch(() => {});
  }

  const titleOf = (id, cwd) =>
    titles.get(String(id)) || firstPrompt.get(String(id)) || cwdTail(cwd) || '会话';

  function readJson(file) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  }

  // Provider snapshots maintained live by @linxin666/dsh-usage (DeepSeek balance etc.).
  function providerSnapshots() {
    if (Date.now() - snapCache.at > 5 * 60 * 1000) {
      snapCache = { at: Date.now(), providers: readJson(SNAPSHOTS_FILE)?.providers ?? null };
    }
    return snapCache.providers;
  }

  function volc5hPrune() {
    const cutoff = Date.now() - FIVE_HOUR_MS;
    while (volcWindow.length > 0 && volcWindow[0].at < cutoff) volcWindow.shift();
  }

  // Requests and tokens spent inside the rolling 5h window.
  function volc5hCalls() {
    volc5hPrune();
    return volcWindow.length;
  }

  function volc5hTokens() {
    volc5hPrune();
    return volcWindow.reduce((sum, e) => sum + e.tokens, 0);
  }

  function providerBadge(provider) {
    if (/volc/i.test(provider ?? '')) {
      return { kind: 'volc', calls: volc5hCalls(), tokens: volc5hTokens() };
    }
    if (/deepseek/i.test(provider ?? '')) {
      const b = providerSnapshots()?.['deepseek-official']?.balance;
      if (b) return { kind: 'deepseek', currency: b.currency ?? '', balance: String(b.totalBalance ?? '') };
    }
    return null;
  }

  function usageOf(sessionId) {
    return safe(() => {
      const s = ctx.sessions?.get?.(sessionId);
      if (!s) return null;
      const m = ctx.tokenMeter?.measure?.(s);
      const tokens = m && typeof m === 'object' && Number.isFinite(m.totalTokens) ? Math.round(m.totalTokens) : null;
      const header = safe(() => s.requestHeader?.(), null);
      const provider = String(header?.config?.provider ?? '');
      const model = String(header?.config?.model ?? '');
      const win = MODEL_CONTEXT[model];
      // Live "collapsed thinking" line: newest assistant content on the surface,
      // including in-flight streaming text while the model is mid-thought.
      let liveText = null;
      const nodes = safe(() => s.surface?.nodes, null);
      if (Array.isArray(nodes)) {
        for (let i = nodes.length - 1; i >= 0 && i >= nodes.length - 4; i--) {
          const msg = nodes[i]?.message ?? null;
          if (!msg || msg.role !== 'assistant') continue;
          const text = blocksText(msg.content);
          if (text) { liveText = text; break; }
        }
      }
      return {
        tokens,
        provider,
        model,
        liveText,
        ...(tokens != null && win ? { pct: Math.min(100, tokens / win * 100) } : {}),
      };
    }, null);
  }

  async function snapshot() {
    const now = Date.now();
    saveWindow();

    // Live agents: running state + main/sub kind, pulled fresh every call.
    const agents = safe(() => ctx.agents.list(), []) ?? [];
    const rootIds = new Set((safe(() => ctx.agents.roots(), []) ?? [])
      .map(a => a?.id ?? a?.session?.id).filter(Boolean));
    const live = new Map();
    for (const a of agents) {
      const id = a?.id ?? a?.session?.id;
      if (id) live.set(String(id), { running: a?.status === 'running', kind: rootIds.has(id) ? 'main' : 'sub' });
    }

    // Durable enumeration across every workspace.
    let records = safe(() => ctx.sessionQuery.listSessions(), null);
    if (records && typeof records.then === 'function') {
      try { records = await records; } catch { records = null; }
    }
    const rows = [];
    const seen = new Set();
    if (Array.isArray(records)) {
      for (const rec of records) {
        const id = rec?.id ?? rec?.sessionId ?? rec?.header?.id;
        if (!id) continue;
        const key = String(id);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          id: key,
          title: titleOf(key, rec?.cwd ?? rec?.header?.cwd ?? rec?.directory),
          cwd: String(rec?.cwd ?? rec?.header?.cwd ?? rec?.directory ?? '').slice(0, 200),
          workspaceId: rec?.workspaceId ?? rec?.header?.workspaceId ?? null,
          updatedAt: Number(rec?.updatedAt ?? rec?.lastActivityAt ?? rec?.activityAt ?? 0) || null,
        });
      }
    }
    // Live agents missing from the durable list still get a row.
    for (const [id] of live) {
      if (seen.has(id)) continue;
      const s = safe(() => ctx.sessions.get(id), null);
      seen.add(id);
      rows.push({
        id,
        title: titleOf(id, safe(() => s?.header?.cwd, '') ?? ''),
        cwd: String(safe(() => s?.header?.cwd, '') ?? '').slice(0, 200),
        workspaceId: null,
        updatedAt: null,
      });
    }

    // Resolve names in the background. Names can appear LATE — a title event
    // shows up after the first exchange, a brand-new session's log may still be
    // empty on the first seed — so empty results are retried on new activity.
    const missingTitles = rows.map(row => row.id).filter(id => !titles.has(id));
    if (!titlesInFlight && missingTitles.length > 0) refreshTitles(missingTitles);
    const emptyTitles = rows.filter(r => titles.get(r.id) === '').map(r => r.id);
    if (!titlesInFlight && emptyTitles.length > 0 && now - lastEmptyTitlesCheck > 60_000) {
      lastEmptyTitlesCheck = now;
      refreshTitles(emptyTitles);
    }
    for (const row of rows) {
      if (titles.get(row.id) !== '') continue;   // has a real title
      if (firstPrompt.get(row.id)) continue;     // already have a prompt
      const lastTry = firstPromptAt.get(row.id) ?? 0;
      if (lastTry && (row.updatedAt ?? 0) <= lastTry) continue; // inactive since last try
      queueFirstPrompt(row.id);
    }

    const ws = new Map();
    for (const w of safe(() => ctx.workspaceRegistry.list(), []) ?? []) {
      if (w?.id) ws.set(String(w.id), String(w?.title ?? cwdTail(w?.path) ?? '').slice(0, 40));
    }

    const out = [];
    for (const row of rows) {
      const l = live.get(row.id);
      if (l?.running === true && !activity.has(row.id)) await seedActivity(row.id);
      const blockedEntry = blocked.get(row.id);
      const running = l?.running === true;
      let status = 'idle';
      if (blockedEntry && blockedEntry.count > 0) status = 'blocked';
      else if (running) status = 'running';
      else if (errors.has(row.id)) status = 'failed';
      if (status === 'running' || status === 'blocked') errors.delete(row.id); // it recovered

      const updatedAt = row.updatedAt ?? (l ? now : null);
      if (status === 'idle' && !(updatedAt && now - updatedAt < RECENT_MS)) continue;

      const act = activity.get(row.id);
      const u = usageOf(row.id);
      out.push({
        id: row.id,
        title: row.title,
        cwd: row.cwd,
        workspace: (row.workspaceId != null ? (ws.get(String(row.workspaceId)) ?? '') : '') || cwdTail(row.cwd),
        kind: l ? l.kind : 'main',
        status,
        detail: status === 'blocked' ? (blockedEntry?.detail ?? '')
          : status === 'failed' ? (errors.get(row.id)?.message ?? '') : '',
        preview: status === 'running' || status === 'blocked' ? (u?.liveText || act?.text || '') : '',
        previewKind: act?.kind ?? '',
        tokens: u?.tokens ?? null,
        ctxPct: u?.pct ?? null,
        spent: cumulative.get(row.id) ?? null,
        provider: u?.provider ?? '',
        model: u?.model ?? '',
        updatedAt,
      });
    }

    // Drop cached previews of sessions that are no longer tracked.
    for (const id of activity.keys()) if (!seen.has(id)) activity.delete(id);
    for (const id of titles.keys()) if (!seen.has(id)) titles.delete(id);
    for (const id of firstPrompt.keys()) if (!seen.has(id)) firstPrompt.delete(id);
    for (const id of firstPromptAt.keys()) if (!seen.has(id)) firstPromptAt.delete(id);
    for (const id of routeOf.keys()) if (!seen.has(id)) routeOf.delete(id);
    for (const id of cumulative.keys()) if (!seen.has(id)) cumulative.delete(id);

    // Account-level badges, always available in the header: volc (this
    // machine's coding plan) and deepseek when a balance snapshot exists.
    const providers = [];
    for (const p of ['volc-agent-plan', 'deepseek-official']) {
      const b = providerBadge(p);
      if (b) providers.push(b);
    }

    const order = { blocked: 0, running: 1, failed: 2, idle: 3 };
    out.sort((a, b) => order[a.status] - order[b.status] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    // Backfill cumulative counters (active rows first, one log read per session).
    for (const row of out) if (!cumulative.has(row.id)) queueCumulative(row.id);
    return { rows: out.slice(0, MAX_ROWS), hidden: Math.max(0, out.length - MAX_ROWS), providers };
  }

  // Same-origin POST route; the browser authenticates with its session cookie.
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      let body;
      try {
        body = await snapshot();
      } catch (error) {
        body = { rows: [], hidden: 0, error: String(error?.message ?? error).slice(0, 160) };
      }
      return new Response(JSON.stringify({ ok: true, ...body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  }), 'session-board: api route');

  // Clear observed errors: {id} clears one session, {} clears all. The orb
  // returns to normal until a new error actually occurs.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/session-board/clear-failed',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      let body = {};
      try { body = await request.json(); } catch {}
      if (body?.id) errors.delete(String(body.id));
      else errors.clear();
      return Response.json({ ok: true });
    },
  }), 'session-board: clear-failed route');
}
