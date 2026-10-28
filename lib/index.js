// dsh-rollover —— 上下文「滚段」插件（DeepSeek Harness）
//
// 三件事：
//   1. 盯上下文占用：超过 warnAt 提醒写记忆，超过 threshold 提醒该换段；
//   2. 自动存档：占用超过 autoAt 时**自己**生成《接续前情》（不用等模型来调），写文件 + 写进
//      dsh-decay-memory 的 📌 记忆，带冷却；
//   3. 换段后自动接住：检测到活跃会话换成了另一段，就把上一段的《接续前情》注入一次。
//
// 自带设置页（host 路由 + client 设置项）：/rollover
// 数据：$DSH_HOME/rollover/{handoffs/<sessionId>.md, state.json}
// 可选：$DSH_HOME/decay-memory/memory.json（📌 接续前情）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPage } from './page.js';

export const name = 'dsh-rollover';
export const inject = ['systemPrompt', 'tools', 'webServer'];

const DEFAULTS = {
  warnAt: 0.45,
  threshold: 0.6,
  keepTurns: 12,
  maxChars: 5000,
  injectIntoMemory: true,
  autoHandoff: true,
  autoAt: 0.6,
  autoCooldownMs: 10 * 60 * 1000,
  stateDir: ''
};

function cfgOf(config) {
  const c = { ...DEFAULTS };
  for (const key of ['warnAt', 'threshold', 'autoAt']) {
    const n = Number(config?.[key]);
    if (Number.isFinite(n)) c[key] = Math.min(0.98, Math.max(0.1, n));
  }
  for (const key of ['keepTurns', 'maxChars']) {
    const n = Number(config?.[key]);
    if (Number.isFinite(n)) c[key] = Math.max(1, Math.round(n));
  }
  {
    const cd = Number(config?.autoCooldownMs);
    if (Number.isFinite(cd)) c.autoCooldownMs = Math.max(60 * 1000, Math.round(cd));
  }
  for (const key of ['injectIntoMemory', 'autoHandoff']) {
    if (typeof config?.[key] === 'boolean') c[key] = config[key];
  }
  if (typeof config?.stateDir === 'string' && config.stateDir.trim()) c.stateDir = config.stateDir.trim();
  if (c.threshold <= c.warnAt) c.threshold = Math.min(0.98, c.warnAt + 0.1);
  if (c.autoAt > c.threshold) c.autoAt = c.threshold;
  return c;
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function stateRoot(cfg) {
  return cfg.stateDir || path.join(dshHome(), 'rollover');
}

function sessionsDir() {
  return path.join(dshHome(), 'storages', 'session_projcache', 'sessions');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function isSessionId(v) {
  return typeof v === 'string' && /^session-[0-9a-f-]{8,}$/i.test(v);
}

function cwdOfCache(sessionId) {
  const j = readJson(path.join(sessionsDir(), `${sessionId}.json`));
  return String(j?.record?.identity?.cwd || '');
}

// bot/桥接的会话一直在写缓存，会把「最近活跃」抢走；默认跳过 cwd 里带 qq-bridge 的会话。
function activeSession(maxAgeMs = 30 * 60 * 1000) {
  const dir = sessionsDir();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = [];
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    if (!isSessionId(id)) continue;
    try {
      candidates.push({ id, mtime: fs.statSync(path.join(dir, file)).mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates.slice(0, 8)) {
    if (Date.now() - c.mtime > maxAgeMs) break;
    const cwd = cwdOfCache(c.id);
    if (cwd && cwd.includes('qq-bridge')) continue;
    return { id: c.id, mtime: c.mtime, cwd };
  }
  const first = candidates[0];
  if (!first || Date.now() - first.mtime > maxAgeMs) return null;
  return { id: first.id, mtime: first.mtime, cwd: cwdOfCache(first.id) };
}

function readPressure(sessionId) {
  const j = readJson(path.join(sessionsDir(), `${sessionId}.json`));
  const cp = j?.record?.rows?.contextPressure?.val;
  if (!cp) return null;
  const pressure = Number(cp.pressureTokens) || 0;
  const window = Number(cp.contextWindow) || 0;
  const surface = Number(cp.surfaceTokens) || 0;
  if (!window) return null;
  return { pressure, window, surface, ratio: pressure / window };
}

function readTurns(sessionId) {
  const j = readJson(path.join(sessionsDir(), `${sessionId}.json`));
  const turns = j?.record?.rows?.turnOutline?.val?.turns;
  return Array.isArray(turns) ? turns : [];
}

function short(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function buildHandoff(sessionId, cfg, note) {
  const pressure = readPressure(sessionId);
  const turns = readTurns(sessionId).slice(-cfg.keepTurns);
  const lines = [];
  lines.push('【接续前情】上一段会话快满了，已经换到新的一段。下面是你自己记得的上一段内容，不是新消息，不用回复。');
  if (pressure) lines.push(`（换段时占用约 ${Math.round(pressure.ratio * 100)}%，${pressure.pressure} / ${pressure.window} tokens）`);
  lines.push('');
  for (const turn of turns) {
    const prompt = short(turn.prompt, 220);
    const response = short(turn.response, 320);
    if (!prompt && !response) continue;
    lines.push(`· 第${turn.turn}轮 用户/唤醒：${prompt}`);
    if (response) lines.push(`  你的回应：${response}`);
  }
  const extra = String(note || '').trim();
  if (extra) lines.push('', `【留给下一段的话】${extra}`);
  let text = lines.join('\n');
  if (text.length > cfg.maxChars) text = `${text.slice(0, cfg.maxChars)}\n…（更早的已省略）`;
  return text;
}

function saveHandoff(cfg, sessionId, text) {
  const file = path.join(stateRoot(cfg), 'handoffs', `${sessionId}.md`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch {}
  return file;
}

// 顺手写进 dsh-decay-memory（如果装了）：📌 永久条目，换段后每轮都会带。
function writeIntoDecayMemory(text) {
  try {
    const file = path.join(dshHome(), 'decay-memory', 'memory.json');
    const state = readJson(file) || { version: 1, entries: [] };
    if (!Array.isArray(state.entries)) state.entries = [];
    const id = `rollover-${Date.now().toString(36)}`;
    state.entries.push({
      id,
      text: `📌接续前情：${text.replace(/\s+/g, ' ').slice(0, 900)}`,
      category: 'topic',
      pinned: true,
      w: 1,
      ts: Date.now(),
      n: 1,
      createdAt: Date.now()
    });
    writeJson(file, state);
    return id;
  } catch {
    return null;
  }
}

function textOutput(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

const OBJECT_OUTPUT = { type: 'object', additionalProperties: true };

export function apply(ctx, config) {
  const file0 = path.join(stateRoot(cfgOf(config)), 'state.json');
  let state = readJson(file0) || {};
  if (!state.injected || typeof state.injected !== 'object') state.injected = {};
  if (!state.handoffs || typeof state.handoffs !== 'object') state.handoffs = {};
  if (!state.auto || typeof state.auto !== 'object') state.auto = {};
  let cfg = cfgOf({ ...config, ...(state.settings || {}) });
  const stateFile = path.join(stateRoot(cfg), 'state.json');

  const persist = () => writeJson(stateFile, state);

  const saveSettings = (patch) => {
    const next = { ...(state.settings || {}) };
    for (const key of ['warnAt', 'threshold', 'autoAt']) {
      const n = Number(patch?.[key]);
      if (Number.isFinite(n)) next[key] = Math.min(0.98, Math.max(0.1, n));
    }
    for (const key of ['keepTurns', 'maxChars']) {
      const n = Number(patch?.[key]);
      if (Number.isFinite(n)) next[key] = Math.max(1, Math.round(n));
    }
    if (Number.isFinite(Number(patch?.autoCooldownMs))) next.autoCooldownMs = Math.max(60 * 1000, Math.round(Number(patch.autoCooldownMs)));
    for (const key of ['injectIntoMemory', 'autoHandoff']) {
      if (typeof patch?.[key] === 'boolean') next[key] = patch[key];
    }
    state.settings = next;
    cfg = cfgOf({ ...config, ...next });
    persist();
    return cfg;
  };

  // 自动存档：占用过了 autoAt 就自己生成一次《接续前情》，不等模型来调。
  const autoArchive = (cur, pressure) => {
    if (!cfg.autoHandoff || !pressure || pressure.ratio < cfg.autoAt) return null;
    const prev = state.auto[cur.id];
    if (prev && Date.now() - Number(prev.at || 0) < cfg.autoCooldownMs) return prev;
    const text = buildHandoff(cur.id, cfg);
    const file = saveHandoff(cfg, cur.id, text);
    state.handoffs[cur.id] = { text, createdAt: Date.now(), file, auto: true };
    const memoryId = cfg.injectIntoMemory ? writeIntoDecayMemory(text) : null;
    state.auto[cur.id] = { at: Date.now(), file, memoryId, chars: text.length };
    persist();
    return state.auto[cur.id];
  };

  // 这一轮该注入的「接续前情」：属于别的段、且还没注入过
  const pendingHandoff = () => {
    const cur = activeSession();
    if (!cur) return '';
    for (const [sessionId, entry] of Object.entries(state.handoffs)) {
      if (sessionId === cur.id) continue;
      if (state.injected[sessionId]) continue;
      state.injected[sessionId] = Date.now();
      persist();
      return String(entry?.text || '');
    }
    return '';
  };

  ctx.inject(['systemPrompt'], (prompted) => {
    prompted.get('systemPrompt').section({
      name: 'rollover',
      order: 148,
      text: () => {
        const cur = activeSession();
        if (!cur) return '';
        const p = readPressure(cur.id);
        const parts = [];
        const handoff = pendingHandoff();
        if (handoff) parts.push(handoff);
        if (p) {
          const auto = autoArchive(cur, p);
          const pct = Math.round(p.ratio * 100);
          const autoNote =
            auto && Date.now() - Number(auto.at || 0) < 5 * 60 * 1000
              ? `（已自动存档《接续前情》：${auto.chars} 字，开新会话后会自动接上）`
              : '';
          if (p.ratio >= cfg.threshold) {
            parts.push(
              `【滚段提醒】当前上下文已占 ${pct}%（${p.pressure}/${p.window}）。请先把重要的事用 memory_add 写成 📌 记忆，然后让用户开一个新会话继续。${autoNote}`
            );
          } else if (p.ratio >= cfg.warnAt) {
            parts.push(`【上下文提醒】已占 ${pct}%，还不用换段；顺手把正在做的事写进记忆（memory_add）会更稳。`);
          }
        }
        return parts.join('\n\n');
      }
    });
  });

  const statusView = () => {
    const cur = activeSession();
    const p = cur ? readPressure(cur.id) : null;
    return {
      ok: true,
      session: cur?.id || null,
      cwd: cur?.cwd || '',
      ratio: p ? Number(p.ratio.toFixed(3)) : null,
      pressureTokens: p?.pressure ?? null,
      contextWindow: p?.window ?? null,
      advise: !p ? 'unknown' : p.ratio >= cfg.threshold ? 'should-roll' : p.ratio >= cfg.warnAt ? 'getting-full' : 'fine',
      config: {
        warnAt: cfg.warnAt,
        threshold: cfg.threshold,
        autoAt: cfg.autoAt,
        autoHandoff: cfg.autoHandoff,
        autoCooldownMinutes: Math.round(cfg.autoCooldownMs / 60000),
        keepTurns: cfg.keepTurns,
        maxChars: cfg.maxChars,
        injectIntoMemory: cfg.injectIntoMemory
      },
      handoffs: Object.entries(state.handoffs).map(([sessionId, entry]) => ({
        session: sessionId,
        chars: String(entry?.text || '').length,
        createdAt: entry?.createdAt || 0,
        auto: entry?.auto === true,
        injected: !!state.injected[sessionId],
        file: entry?.file || ''
      })),
      autoArchived: Object.entries(state.auto).map(([sessionId, entry]) => ({ session: sessionId, at: entry?.at || 0, chars: entry?.chars || 0 })),
      stateFile
    };
  };

  ctx.tools.register({
    name: 'rollover_status',
    description: '查看当前会话的上下文占用、是否该滚段、以及已有的《接续前情》存档。',
    parameters: { type: 'object', properties: {} },
    output: { schema: OBJECT_OUTPUT, render: (_a, v) => textOutput(v) },
    execute: async () => statusView()
  });

  ctx.tools.register({
    name: 'rollover_handoff',
    description: '给当前会话生成一份《接续前情》并保存（可选写进 decay-memory 的 📌 记忆）。换段后新会话会自动收到这份内容。',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string', description: '可选：你想额外叮嘱下一段的话。' } }
    },
    output: { schema: OBJECT_OUTPUT, render: (_a, v) => textOutput(v) },
    execute: async (args) => {
      const cur = activeSession();
      if (!cur) return { ok: false, error: '没找到活跃会话的投影缓存' };
      const text = buildHandoff(cur.id, cfg, args?.note);
      const file = saveHandoff(cfg, cur.id, text);
      state.handoffs[cur.id] = { text, createdAt: Date.now(), file, auto: false };
      persist();
      const memoryId = cfg.injectIntoMemory ? writeIntoDecayMemory(text) : null;
      return { ok: true, session: cur.id, chars: text.length, file, memoryId, preview: text.slice(0, 400) };
    }
  });

  // ── 设置页（host 直接提供 HTML + JSON API；client 半用 iframe 嵌同一页）──────
  const json = (response, code, obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(body);
  };

  const readBody = (request) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      request.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) {
          reject(new Error('请求体太大'));
          request.destroy();
          return;
        }
        chunks.push(c);
      });
      request.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
      request.on('error', reject);
    });

  const handleAction = (body) => {
    const op = String(body?.op || '');
    if (op === 'handoff') {
      const cur = activeSession();
      if (!cur) throw new Error('没找到活跃会话');
      const text = buildHandoff(cur.id, cfg, body?.note);
      const file = saveHandoff(cfg, cur.id, text);
      state.handoffs[cur.id] = { text, createdAt: Date.now(), file, auto: false };
      const memoryId = cfg.injectIntoMemory ? writeIntoDecayMemory(text) : null;
      persist();
      return { ...statusView(), done: { session: cur.id, chars: text.length, file, memoryId } };
    }
    if (op === 'reset-injected') {
      const sessionId = String(body?.session || '');
      if (state.injected[sessionId]) delete state.injected[sessionId];
      persist();
      return statusView();
    }
    if (op === 'delete-handoff') {
      const sessionId = String(body?.session || '');
      delete state.handoffs[sessionId];
      delete state.injected[sessionId];
      delete state.auto[sessionId];
      persist();
      return statusView();
    }
    throw new Error('未知操作');
  };

  const makeHandler = (kind) => async (request, response) => {
    try {
      if (request.method === 'GET' && kind === 'page') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(renderPage());
        return;
      }
      if (request.method === 'GET' && kind === 'state') {
        json(response, 200, statusView());
        return;
      }
      if (request.method === 'POST' && kind === 'config') {
        saveSettings(await readBody(request));
        json(response, 200, statusView());
        return;
      }
      if (request.method === 'POST' && kind === 'action') {
        json(response, 200, handleAction(await readBody(request)));
        return;
      }
      response.writeHead(405);
      response.end();
    } catch (error) {
      json(response, 400, { ok: false, error: String(error?.message || error) });
    }
  };

  let disposeRoutes = null;
  ctx.inject(['webServer'], (hostCtx) => {
    const register = (p, kind) => hostCtx.webServer.register({ kind: 'exact', path: p, handler: makeHandler(kind) });
    const disposers = [
      register('/rollover', 'page'),
      register('/rollover/api/state', 'state'),
      register('/rollover/api/config', 'config'),
      register('/rollover/api/action', 'action')
    ];
    disposeRoutes = () => {
      for (const off of disposers) {
        try {
          off?.();
        } catch {}
      }
    };
  });
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      try {
        disposeRoutes?.();
      } catch {}
    });
  }
}

// 给本地测试用
export const __test = { cfgOf, activeSession, readPressure, readTurns, buildHandoff, saveHandoff, writeIntoDecayMemory, sessionsDir };
