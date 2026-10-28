// 滚段设置页（host 直接吐 HTML，零构建）
export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>滚段 · dsh-rollover</title>
<style>
  :root { color-scheme: dark; --bg:#0f1216; --card:#171c22; --line:#252c35; --text:#e6edf3; --dim:#8b98a5; --accent:#5b9dff; --ok:#7ee0c0; --warn:#f0a35e; --bad:#e55353; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 28px 20px 56px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--dim); margin-bottom: 22px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px; margin-bottom: 16px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); gap: 12px; }
  label { display:block; color: var(--dim); font-size: 12px; margin-bottom: 4px; }
  input[type=number] { width:100%; background:#0d1117; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:inherit; }
  input[type=checkbox] { transform: scale(1.2); }
  button { background:#20262f; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 12px; cursor:pointer; font:inherit; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); color:#08121f; border-color: transparent; font-weight:600; }
  button.danger:hover { border-color: var(--bad); color:#ff9b9b; }
  .session { display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  .gauge { flex:1; min-width:220px; }
  .bar { height:8px; background:#0d1117; border-radius:6px; overflow:hidden; margin-top:6px; }
  .bar > i { display:block; height:100%; background: linear-gradient(90deg,#5b9dff,#7ee0c0); }
  .bar.hot > i { background: linear-gradient(90deg,#f0a35e,#e55353); }
  .tag { font-size:12px; color:var(--dim); border:1px solid var(--line); border-radius:999px; padding:1px 8px; }
  .row { border-top:1px solid var(--line); padding:10px 0; display:flex; gap:12px; align-items:center; }
  .row:first-child { border-top:0; }
  .grow { flex:1; min-width:0; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--dim); }
  .empty { color: var(--dim); padding: 10px 0; }
  .toast { position: fixed; left:50%; bottom:26px; transform:translateX(-50%); background:#20262f; border:1px solid var(--line); padding:10px 16px; border-radius:10px; opacity:0; transition:.2s; pointer-events:none; }
  .toast.show { opacity:1; }
  .hint { color: var(--dim); font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>滚段 <span class="tag" id="advise">…</span></h1>
  <div class="sub">上下文快满时自动存档《接续前情》；换到新的一段后自动接上。数据：<code>$DSH_HOME/rollover/</code></div>

  <div class="card session">
    <div class="gauge">
      <div><b>当前会话</b> <span class="mono" id="session">…</span></div>
      <div class="bar" id="bar"><i style="width:0%"></i></div>
      <div class="hint" id="pressure">—</div>
    </div>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button class="primary" id="handoff">立即生成接续前情</button>
      <button id="refresh">刷新</button>
    </div>
  </div>

  <div class="card">
    <div class="grid">
      <div><label>开始提醒（占比）</label><input type="number" id="warnAt" step="0.05" min="0.1" max="0.98" /></div>
      <div><label>建议滚段（占比）</label><input type="number" id="threshold" step="0.05" min="0.1" max="0.98" /></div>
      <div><label>自动存档从（占比）</label><input type="number" id="autoAt" step="0.05" min="0.1" max="0.98" /></div>
      <div><label>自动存档冷却（分钟）</label><input type="number" id="autoCooldownMinutes" min="1" max="1440" /></div>
      <div><label>取最近几轮</label><input type="number" id="keepTurns" min="1" max="100" /></div>
      <div><label>正文上限（字）</label><input type="number" id="maxChars" min="500" max="20000" /></div>
      <div><label>自动存档</label><div style="padding-top:6px"><input type="checkbox" id="autoHandoff" /></div></div>
      <div><label>写进 📌 记忆</label><div style="padding-top:6px"><input type="checkbox" id="injectIntoMemory" /></div></div>
    </div>
    <div style="margin-top:14px; display:flex; gap:10px; align-items:center;">
      <button class="primary" id="save">保存设置</button>
      <span class="hint" id="status"></span>
    </div>
  </div>

  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
      <b>接续前情存档</b>
      <span class="hint" id="count"></span>
    </div>
    <div id="list"></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let state = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function api(path, init) {
  const res = await fetch('/rollover/api' + path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...init });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.ok === false) throw new Error(j && j.error ? j.error : 'HTTP ' + res.status);
  return j;
}
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}
function paint() {
  const c = state.config;
  $('warnAt').value = c.warnAt;
  $('threshold').value = c.threshold;
  $('autoAt').value = c.autoAt;
  $('autoCooldownMinutes').value = c.autoCooldownMinutes;
  $('keepTurns').value = c.keepTurns;
  $('maxChars').value = c.maxChars;
  $('autoHandoff').checked = !!c.autoHandoff;
  $('injectIntoMemory').checked = !!c.injectIntoMemory;

  $('session').textContent = state.session || '（没找到活跃会话）';
  const pct = state.ratio == null ? 0 : Math.round(state.ratio * 100);
  $('bar').querySelector('i').style.width = Math.max(1, pct) + '%';
  $('bar').classList.toggle('hot', pct >= Math.round(c.threshold * 100));
  $('pressure').textContent = state.pressureTokens == null ? '还没有上下文数据'
    : pct + '% · ' + state.pressureTokens + ' / ' + state.contextWindow + ' tokens';
  const adviseText = { fine: '充裕', 'getting-full': '快满了', 'should-roll': '该换段了', unknown: '未知' }[state.advise] || state.advise;
  $('advise').textContent = adviseText;

  const list = $('list');
  const items = state.handoffs || [];
  $('count').textContent = items.length ? items.length + ' 份' : '';
  if (!items.length) {
    list.innerHTML = '<div class="empty">还没有存档。上下文到阈值会自动生成，也可以点上面「立即生成接续前情」。</div>';
    return;
  }
  list.innerHTML = items.map((h) => '<div class="row">' +
    '<div class="grow">' +
      '<div>' + (h.auto ? '🤖 自动存档' : '✍️ 手动生成') + ' · ' + h.chars + ' 字 ' +
        (h.injected ? '<span class="tag">已注入</span>' : '<span class="tag">待注入</span>') + '</div>' +
      '<div class="mono">' + esc(h.session) + ' · ' + fmtTime(h.createdAt) + '</div>' +
    '</div>' +
    '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
      (h.injected ? '<button data-op="reset-injected" data-session="' + esc(h.session) + '">重新注入</button>' : '') +
      '<button class="danger" data-op="delete-handoff" data-session="' + esc(h.session) + '">删</button>' +
    '</div>' +
  '</div>').join('');
}
async function load() {
  state = await api('/state');
  paint();
}
$('refresh').onclick = () => load().then(() => toast('已刷新')).catch((e) => toast(e.message));
$('save').onclick = async () => {
  try {
    state = await api('/config', { method: 'POST', body: JSON.stringify({
      warnAt: Number($('warnAt').value),
      threshold: Number($('threshold').value),
      autoAt: Number($('autoAt').value),
      autoCooldownMs: Math.round(Number($('autoCooldownMinutes').value) * 60000),
      keepTurns: Number($('keepTurns').value),
      maxChars: Number($('maxChars').value),
      autoHandoff: $('autoHandoff').checked,
      injectIntoMemory: $('injectIntoMemory').checked
    }) });
    paint();
    toast('设置已保存（下一轮生效）');
  } catch (e) { toast(e.message); }
};
$('handoff').onclick = async () => {
  try {
    state = await api('/action', { method: 'POST', body: JSON.stringify({ op: 'handoff' }) });
    paint();
    toast('生成了 ' + (state.done ? state.done.chars : '') + ' 字的接续前情');
  } catch (e) { toast(e.message); }
};
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-op]');
  if (!btn) return;
  try {
    state = await api('/action', { method: 'POST', body: JSON.stringify({ op: btn.dataset.op, session: btn.dataset.session }) });
    paint();
    toast('已更新');
  } catch (e) { toast(e.message); }
});
load().catch((e) => toast('读取失败：' + e.message));
</script>
</body>
</html>`;
}
