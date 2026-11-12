/* OH Story 工作台 · 前端 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  books: [], book: null, tree: null, file: null,
  content: '', saved: true, dirtyTimer: null,
  cfg: {}, streaming: null, lastAI: '', lastMode: '', findings: [],
};

/* ---------- 基础 ---------- */
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function fmtWords(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万字';
  if (n >= 1000) return (n / 1000).toFixed(1) + ' 千字';
  return n + ' 字';
}

function showView(id, push = true) {
  const cur = $('.view.active');
  const next = $('#view-' + id);
  if (cur === next) return;
  if (cur) cur.classList.remove('active');
  next.classList.add('active', 'slide-in');
  setTimeout(() => next.classList.remove('slide-in'), 300);
}

/* ---------- 书架 ---------- */
async function loadBooks() {
  const j = await api('/api/books');
  state.books = j.books;
  renderShelf();
  loadBenchmarks();
}

async function loadBenchmarks() {
  try {
    const j = await api('/api/benchmarks');
    state.benchmarks = j.benchmarks || [];
    const list = $('#bench-list');
    if (!list) return;
    list.innerHTML = '';
    $('#bench-empty').hidden = state.benchmarks.length > 0;
    state.benchmarks.forEach((b, i) => {
      const el = document.createElement('div');
      el.className = 'book-card';
      el.innerHTML = `
        <div class="cover" data-h="${(i + 2) % 5}">对</div>
        <div class="info">
          <h3>${escapeHtml(b.name)}</h3>
          <div class="meta"><span>${b.chapters} 章</span><span>梗概 ${b.analyzed}</span><span>角色 ${b.characters}</span></div>
        </div>`;
      el.onclick = () => openBench(b.name);
      list.appendChild(el);
    });
  } catch (e) { /* 忽略 */ }
}

let benchState = { name: '', data: null };

async function openBench(name) {
  const list = state.benchmarks || [];
  const b = list.find(x => x.name === name) || {};
  benchState = { name, data: b };
  $('#bench-title').textContent = name;
  $('#bench-meta').textContent = `${b.chapters || 0} 章 · 已拆 ${b.analyzed || 0}`;
  showView('bench');
  renderBench();
  try {
    const j = await api('/api/benchmark/tree?name=' + encodeURIComponent(name));
    benchState.tree = j.tree;
    renderBenchFiles();
  } catch (e) { toast(e.message); }
}

function renderBench() {
  const b = benchState.data || {};
  const left = (b.chapters || 0) - (b.analyzed || 0);
  $('#bench-pane').innerHTML = `
    <div class="flow-card">
      <h3><span class="dot ${left === 0 && b.analyzed ? 'ok' : 'bad'}"></span>拆解进度</h3>
      <p>原文 ${b.chapters || 0} 章 · 已有梗概 ${b.analyzed || 0} 章 · 角色 ${b.characters || 0} 份 · 设定 ${b.settings || 0} 份</p>
      <div class="row gap" style="flex-wrap:wrap">
        <button class="btn primary small" id="bench-run">${left > 0 ? '继续拆解' : '重新拆解'}</button>
        <button class="btn ghost small" id="bench-report">看拆文报告</button>
        <button class="btn ghost small" id="bench-deepen">深度拆解</button>
        <button class="btn ghost small" id="bench-link">设为写作引用</button>
      </div>
    </div>
    <div id="bench-files"></div>`;
  $('#bench-run').onclick = () => {
    const from = Math.max(1, (b.analyzed || 0) + 1);
    runBenchAnalyze(from);
  };
  $('#bench-report').onclick = () => openBenchFile('拆文报告.md');
  $('#bench-deepen').onclick = () => runBenchStep('benchmark-deepen', '深度拆解：剧情层 + 情绪模块');
  $('#bench-link').onclick = async () => {
    if (!state.book) return toast('先从书架选一本书，再来绑定素材');
    try {
      await api('/api/book/benchmark', { method: 'POST', body: JSON.stringify({ book: state.book, name: benchState.name }) });
      toast(`《${state.book}》写正文时将引用《${benchState.name}》`);
    } catch (e) { toast(e.message); }
  };
}

function renderBenchFiles() {
  const tree = benchState.tree || [];
  const box = $('#bench-files');
  if (!box) return;
  const groups = { '剧情': '剧情 / 情绪模块', '章节': '章节梗概', '角色': '角色', '设定': '设定 · 世界观 · 势力' };
  let html = '';
  for (const [dir, label] of Object.entries(groups)) {
    const node = tree.find(n => n.type === 'dir' && n.name === dir);
    if (!node || !node.children.length) continue;
    html += `<div class="section-label">${label} · ${node.children.length}</div><div class="list">`;
    html += node.children.filter(f => f.type === 'file').map(f => `
      <div class="row-item" data-bf="${f.path}">
        <div class="main"><div class="name">${escapeHtml(f.name.replace(/\.md$/, ''))}</div></div>
        <span class="chev">›</span>
      </div>`).join('');
    html += `</div>`;
  }
  const top = tree.filter(n => n.type === 'file' && /\.md$/.test(n.name));
  if (top.length) {
    html = `<div class="section-label">报告</div><div class="list">` + top.map(f => `
      <div class="row-item" data-bf="${f.path}"><div class="main"><div class="name">${escapeHtml(f.name.replace(/\.md$/, ''))}</div></div><span class="chev">›</span></div>`).join('') + `</div>` + html;
  }
  box.innerHTML = html || '<p class="hint" style="margin-top:12px">还没有拆解产物</p>';
  $$('#bench-files [data-bf]').forEach(el => { el.onclick = () => openBenchFile(el.dataset.bf); });
}

async function openBenchFile(rel) {
  try {
    const j = await api(`/api/benchmark/file?name=${encodeURIComponent(benchState.name)}&path=${encodeURIComponent(rel)}`);
    sheet(`<h3>${escapeHtml(rel)}</h3><div class="stream-text" style="max-height:56vh;overflow:auto">${escapeHtml(j.content.slice(0, 20000))}</div>
      <button class="btn ghost" style="margin-top:12px" onclick="closeSheet()">关闭</button>`);
  } catch (e) { toast(e.message); }
}

async function runBenchStep(step, title) {
  const box = $('#console');
  box.hidden = false;
  $('#console-title').textContent = title || step;
  $('#console-sub').textContent = benchState.name;
  $('#console-out').textContent = '';
  $('#console-phases').innerHTML = '';
  try {
    const r = await fetch('/api/engine/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ book: benchState.name, step, name: benchState.name }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'HTTP ' + r.status); }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf2 = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf2 += dec.decode(value, { stream: true });
      let i;
      while ((i = buf2.indexOf('\n\n')) >= 0) {
        const chunk = buf2.slice(0, i).trim();
        buf2 = buf2.slice(i + 2);
        if (!chunk.startsWith('data:')) continue;
        let j2;
        try { j2 = JSON.parse(chunk.slice(5).trim()); } catch { continue; }
        if (j2.error) throw new Error(j2.error);
        if (j2.phase) {
          $$('#console-phases span.on').forEach(x => x.classList.remove('on'));
          const s = document.createElement('span');
          s.className = 'on'; s.textContent = j2.label || j2.phase;
          $('#console-phases').appendChild(s);
        }
        if (j2.d) $('#console-out').textContent += j2.d;
        if (j2.done) {
          $('#console-out').textContent += '\n\n完成：' + ((j2.files || []).join('\n') || '');
          await loadBenchmarks();
          openBench(benchState.name);
        }
      }
    }
  } catch (e) {
    $('#console-out').textContent += '\n\n失败：' + e.message;
  }
}

async function runBenchAnalyze(from) {
  const b = benchState.data || {};
  const box = $('#console');
  box.hidden = false;
  $('#console-title').textContent = '拆解素材';
  $('#console-sub').textContent = `${benchState.name} · 从第 ${from} 章`;
  $('#console-out').textContent = '';
  $('#console-phases').innerHTML = '';
  try {
    const r = await fetch('/api/engine/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ book: state.book || benchState.name, bookDir: '', step: 'benchmark-analyze', name: benchState.name, from, to: b.chapters || 999 }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf2 = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf2 += dec.decode(value, { stream: true });
      let i;
      while ((i = buf2.indexOf('\n\n')) >= 0) {
        const chunk = buf2.slice(0, i).trim();
        buf2 = buf2.slice(i + 2);
        if (!chunk.startsWith('data:')) continue;
        let j2;
        try { j2 = JSON.parse(chunk.slice(5).trim()); } catch { continue; }
        if (j2.error) throw new Error(j2.error);
        if (j2.phase) {
          $$('#console-phases span.on').forEach(x => x.classList.remove('on'));
          const s = document.createElement('span');
          s.className = 'on';
          s.textContent = j2.label || j2.phase;
          $('#console-phases').appendChild(s);
        }
        if (j2.d) { $('#console-out').textContent += j2.d; }
        if (j2.done) {
          $('#console-out').textContent += `\n\n完成：新增梗概 ${(j2.produced || []).length} 份，汇总 ${(j2.aggregate || []).length} 份`;
          await loadBenchmarks();
          openBench(benchState.name);
        }
      }
    }
  } catch (e) {
    $('#console-out').textContent += '\n\n失败：' + e.message;
  }
}

function renderShelf() {
  const list = $('#book-list');
  list.innerHTML = '';
  $('#shelf-empty').hidden = state.books.length > 0;
  state.books.forEach((b, i) => {
    const el = document.createElement('div');
    el.className = 'book-card';
    el.innerHTML = `
      <div class="cover" data-h="${i % 5}">${b.name.slice(0, 1)}</div>
      <div class="info">
        <h3>${escapeHtml(b.name)}</h3>
        <div class="meta"><span>${b.chapters} 章</span><span>${fmtWords(b.words)}</span></div>
      </div>`;
    el.onclick = () => openBook(b.name);
    list.appendChild(el);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 书内 ---------- */
async function openBook(name) {
  state.book = name;
  $('#book-title').textContent = name;
  setTab('chapters');
  if (state.caps?.engine !== false) loadFlow();
  showView('book');
  await reloadTree();
}

async function reloadTree() {
  const j = await api('/api/tree?book=' + encodeURIComponent(state.book));
  state.tree = j.tree;
  const chapters = j.chapters || [];
  let words = 0;
  const flat = [];
  const walk = nodes => nodes.forEach(n => n.type === 'dir' ? walk(n.children) : flat.push(n));
  walk(j.tree);
  flat.forEach(f => words += f.words || 0);
  const shortBody = flat.find(f => f.path === '正文.md');
  if (shortBody) words = shortBody.words || 0;
  const isShort = flowStatus?.files?.short;
  $('#book-meta').textContent = isShort ? fmtWords(words) : `${chapters.length} 章 · ${fmtWords(words)}`;
  $$('.tab[data-tab="outline"], .tab[data-tab="tracking"]').forEach(t => { t.style.display = isShort ? 'none' : ''; });
  renderChapters();
  renderFileGroups(j.tree);
}

function dirNode(nodes, name) {
  const found = nodes.find(n => n.type === 'dir' && n.name === name);
  return found ? found.children : [];
}

function renderChapters() {
  const chapters = (state.tree || []).find(n => n.type === 'dir' && n.name === '正文');
  const list = chapters ? chapters.children.filter(f => f.type === 'file') : [];
  const pane = $('#pane-chapters');
  if (!list.length) {
    pane.innerHTML = `<div class="empty"><div class="empty-ico">✍️</div><p>还没有章节</p><span>点右下角 ＋ 建第一章，或让 AI 直接写</span></div>`;
    return;
  }
  pane.innerHTML = `<div class="list">` + list.map((f, i) => `
    <div class="row-item" data-path="${f.path}">
      <span class="num">${String(i + 1).padStart(2, '0')}</span>
      <div class="main">
        <div class="name">${escapeHtml(f.name.replace(/\.md$/, ''))}</div>
        <div class="sub">${fmtWords(f.words || 0)}</div>
      </div>
      <span class="chev">›</span>
    </div>`).join('') + `</div>`;
  $$('#pane-chapters .row-item').forEach(el => {
    el.onclick = () => openFile(el.dataset.path);
  });
}

function renderFileGroups(tree) {
  const groups = { setting: '设定', outline: '大纲', tracking: '追踪' };
  const icons = { setting: '📌', outline: '🗺️', tracking: '🧭' };
  for (const [pane, dir] of Object.entries(groups)) {
    const files = dirNode(tree, dir);
    const el = $('#pane-' + pane);
    if (!files.length) {
      el.innerHTML = `<div class="empty"><div class="empty-ico">${icons[pane]}</div><p>${dir}是空的</p><span>点 ＋ 新建</span></div>`;
      continue;
    }
    const walk = (nodes, prefix = '') => nodes.flatMap(n =>
      n.type === 'dir' ? walk(n.children, prefix + n.name + '/')
        : [{ ...n, label: prefix + n.name.replace(/\.md$/, '') }]);
    el.innerHTML = `<div class="list">` + walk(files).map(f => `
      <div class="row-item" data-path="${f.path}">
        <div class="main"><div class="name">${escapeHtml(f.label)}</div><div class="sub">${fmtWords(f.words || 0)}</div></div>
        <span class="chev">›</span>
      </div>`).join('') + `</div>`;
    $$(`#pane-${pane} .row-item`).forEach(x => { x.onclick = () => openFile(x.dataset.path); });
  }
}

function setTab(tab) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  ['flow', 'chapters', 'setting', 'outline', 'tracking'].forEach(t => {
    const p = $('#pane-' + t);
    if (p) p.hidden = t !== tab;
  });
  if (tab === 'flow' && state.caps?.engine !== false) loadFlow();
}

/* ---------- 编辑器 ---------- */
async function openFile(path) {
  const j = await api('/api/file?path=' + encodeURIComponent(`${state.book}/${path}`));
  state.file = path;
  state.content = j.content;
  state.saved = true;
  $('#editor-title').textContent = path.split('/').pop().replace(/\.md$/, '');
  const ed = $('#editor');
  ed.value = j.content;
  updateMeta();
  showView('editor');
  ed.scrollTop = 0;
  if (path.startsWith('正文/')) setTimeout(() => ed.focus({ preventScroll: true }), 80);
}

function updateMeta() {
  const text = $('#editor').value;
  const words = text.replace(/\s/g, '').length;
  const bad = (state.findings || []).filter(f => f.severity === 'blocking').length;
  const tip = (state.findings || []).length - bad;
  const extra = state.findings.length ? ` · ${bad ? bad + ' 必改' : ''}${bad && tip ? ' / ' : ''}${tip ? tip + ' 提示' : ''}` : '';
  $('#editor-meta').textContent = `${words} 字 · ${state.saved ? '已保存' : '未保存'}${extra}`;
}

async function saveFile(force) {
  if (!state.file || (state.saved && !force)) return;
  const content = $('#editor').value;
  state.saved = true;
  updateMeta();
  try {
    await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: `${state.book}/${state.file}`, content }) });
    state.content = content;
    if (state.file.startsWith('正文/')) reloadTree();
  } catch (e) {
    state.saved = false; updateMeta();
    toast('保存失败：' + e.message);
  }
}

function scheduleSave() {
  state.saved = false;
  state.findings = [];
  updateMeta();
  clearTimeout(state.dirtyTimer);
  state.dirtyTimer = setTimeout(saveFile, 900);
}

/* ---------- AI ---------- */
const MODE_LABEL = {
  chapter: '写这一章', continue: '续写', deslop: '去 AI 味',
  review: '审稿', polish: '润色', outline: '出细纲',
};

async function runAI(mode, instruction = '') {
  if (state.streaming) { toast('正在生成中'); return; }
  const cfg = state.cfg;
  if (!cfg.hasKey || !cfg.model) {
    toast('先去设置里配置模型');
    showView('settings');
    return;
  }
  const editor = $('#editor');
  const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  const panel = $('#stream-panel');
  const box = $('#stream-text');
  state.lastAI = '';
  state.lastMode = mode;
  box.textContent = '';
  box.classList.remove('done');
  panel.hidden = false;
  $('#stream-label').textContent = MODE_LABEL[mode] || '生成中';
  const stopBtn = $('#btn-stop');
  stopBtn.textContent = '停止';
  stopBtn.onclick = () => state.streaming?.abort();
  state.streaming = new AbortController();
  let acc = '';

  try {
    const r = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: state.streaming.signal,
      body: JSON.stringify({
        mode, book: state.book, chapter: state.file ? state.file.split('/').pop().replace(/\.md$/, '') : '',
        instruction, existing: editor.value, selection: sel,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!chunk.startsWith('data:')) continue;
        const payload = chunk.slice(5).trim();
        if (!payload) continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        if (j.error) throw new Error(j.error);
        if (j.d) {
          acc += j.d;
          state.lastAI = acc;
          box.textContent = acc;
          panel.scrollTop = panel.scrollHeight;
        }
      }
    }
    box.classList.add('done');
    $('#stream-label').textContent = `完成 · ${acc.replace(/\s/g, '').length} 字`;
    setStopToClose();
    showInsertActions(acc, mode);
    runCheck(false);
  } catch (e) {
    if (e.name === 'AbortError') {
      box.classList.add('done');
      $('#stream-label').textContent = '已停止';
    } else {
      box.classList.add('done');
      $('#stream-label').textContent = '失败';
      toast(e.message, 3200);
    }
    setStopToClose();
    if (acc) showInsertActions(acc, mode);
  } finally {
    state.streaming = null;
  }
}

function showInsertActions(text, mode) {
  const content = $('#sheet-content');
  const old = $('#insert-bar');
  if (old) old.remove();
  const bar = document.createElement('div');
  bar.id = 'insert-bar';
  bar.className = 'row gap';
  bar.style.padding = '10px 16px 4px';
  bar.style.position = 'sticky';
  bar.style.bottom = '0';
  bar.innerHTML = `
    <button class="btn ghost small" id="ai-copy">复制</button>
    <button class="btn ghost small" id="ai-insert">插入光标处</button>
    <button class="btn primary small" id="ai-replace">覆盖全文</button>`;
  $('#stream-panel').appendChild(bar);
  $('#ai-copy').onclick = () => { navigator.clipboard?.writeText(text); toast('已复制'); };
  $('#ai-insert').onclick = () => insertAtCursor(text);
  $('#ai-replace').onclick = () => {
    if (!confirm('覆盖编辑器里的全部内容？')) return;
    $('#editor').value = text;
    scheduleSave(); closeStream();
  };
}

function insertAtCursor(text) {
  const ed = $('#editor');
  const start = ed.selectionStart ?? ed.value.length;
  ed.value = ed.value.slice(0, start) + (ed.value ? '\n\n' : '') + text + ed.value.slice(ed.selectionEnd ?? start);
  scheduleSave();
  closeStream();
  ed.scrollTop = ed.scrollHeight;
}

function setStopToClose() {
  const b = $('#btn-stop');
  b.textContent = '收起';
  b.onclick = closeStream;
}

function closeStream() {
  $('#stream-panel').hidden = true;
  $('#insert-bar')?.remove();
}

/* ---------- 体检 ---------- */
async function runCheck(open) {
  const text = $('#editor').value;
  if (!text.trim()) return toast('还没有内容');
  toast('体检中…', 900);
  try {
    const j = await api('/api/check', { method: 'POST', body: JSON.stringify({ book: state.book, text }) });
    state.findings = j.findings || [];
    updateMeta();
    if (open) return showFindings();
    const bad = state.findings.filter(f => f.severity === 'blocking').length;
    if (bad) toast(`体检：${bad} 处建议改，点「更多 → 体检」看清单`, 2600);
  } catch (e) { if (open) toast(e.message, 3000); }
}

function showFindings() {
  const fs = state.findings || [];
  const bad = fs.filter(f => f.severity === 'blocking').length;
  sheet(`<h3>体检报告</h3><p class="sub">${bad} 处必改 · ${fs.length - bad} 处提示 · 原版 check-ai-patterns / check-degeneration</p>
    <div class="sheet-list">${fs.length ? fs.map((f, i) => `
      <button data-i="${i}">
        <b style="font-weight:600;color:${f.severity === 'blocking' ? 'var(--accent)' : 'var(--ink-2)'}">${f.severity === 'blocking' ? '必改' : '提示'} · 第 ${f.line} 行 · ${escapeHtml(f.type)}</b>
        <small>${escapeHtml((f.message || '').slice(0, 70))}</small>
        <small style="color:#9a8f80">${escapeHtml((f.excerpt || '').slice(0, 30))}</small>
      </button>`).join('') : '<button>没有发现问题</button>'}</div>
    <button class="btn ghost" onclick="closeSheet()">关闭</button>`);
  $$('#sheet-content [data-i]').forEach(b => {
    b.onclick = () => { const f = fs[+b.dataset.i]; closeSheet(); jumpToLine(f.line); };
  });
}

function jumpToLine(line) {
  const ed = $('#editor');
  const lines = ed.value.split('\n');
  let pos = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
  ed.focus();
  ed.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
  toast(`已定位到第 ${line} 行`);
}

/* ---------- 原版流程 ---------- */
let flowStatus = null;

async function loadFlow() {
  const el = $('#pane-flow');
  if (!el) return;
  try {
    const s = await api('/api/engine/status?book=' + encodeURIComponent(state.book));
    flowStatus = s;
    renderFlow(s);
    if (s.files && s.files.short) {
      renderShortFiles(s);
      if ($('.tab.active')?.dataset.tab === 'chapters') setTab('flow');
    }
  } catch (e) {
    el.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
  }
}

function renderShortFiles(s) {
  const rows = [
    ['正文.md', s.files.shortBody],
    ['大纲', null],
  ];
  const pane = $('#pane-chapters');
  const list = [
    { path: '正文.md', name: '正文', on: s.files.shortBody },
    { path: '小节大纲.md', name: '小节大纲', on: s.files.shortOutline },
    { path: '设定.md', name: '设定', on: true },
  ].filter(x => x.on);
  pane.innerHTML = `<div class="list">` + list.map(f => `
    <div class="row-item" data-path="${f.path}">
      <div class="main"><div class="name">${f.name}</div><div class="sub">${f.path}</div></div>
      <span class="chev">›</span>
    </div>`).join('') + `</div>`;
  $$('#pane-chapters .row-item').forEach(el => { el.onclick = () => openFile(el.dataset.path); });
}

function renderFlow(s) {
  const el = $('#pane-flow');
  const vol = s.outline || {};
  const next = s.nextChapter || 1;
  const outlineCount = (s.outlines || []).length;
  const chapters = (s.chapters || []).length;
  const contractOk = s.contract ? s.contract.ok : null;
  const nextPad = String(next).padStart(3, '0');
  const hasNextOutline = (s.outlines || []).some(f => f.includes(nextPad));

  const card = (title, ok, desc, action, label, extra = '') => `
    <div class="flow-card ${ok ? 'done' : ''}">
      <h3><span class="dot ${ok ? 'ok' : 'bad'}"></span>${title}</h3>
      <p>${desc}</p>
      ${extra}
      <button class="btn ${ok ? 'ghost' : 'primary'} small" data-act="${action}">${label}</button>
    </div>`;

  const f = s.files || {};
  if (f.short) {
    el.innerHTML = `
      <p class="hint" style="margin:4px 4px 12px">短篇流程（story-short-write）：构思 → 正文 → 精修。落地为 设定.md / 小节大纲.md / 正文.md 三个文件。</p>
      ${card('① 构思', !!(f.shortOutline), f.shortOutline ? '设定.md 与 小节大纲.md 已生成' : '先定目标情绪，再定故事核、反转与付费点', 'short-design', f.shortOutline ? '重出构思' : '开始构思')}
      ${card('② 正文', !!(f.shortBody), f.shortBody ? '正文.md 已生成' : '按设定了与大纲一次写完', 'short-draft', f.shortBody ? '重写正文' : '写正文')}
      <div class="flow-card"><h3>③ 拆解</h3><p>拆结构、反转、情绪曲线与可复现模块</p>
        <button class="btn ghost small" data-act="short-analyze">拆这篇</button></div>
      <div class="flow-card"><h3>精修</h3><p>短篇去味按 short-deslop 口径，直接说要求即可</p>
        <button class="btn ghost small" data-act="short-polish">去 AI 味</button></div>
    `;
    $$('#pane-flow [data-act]').forEach(b => {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'short-design') return askMoment('short-design');
        if (act === 'short-draft') return runEngine('short-draft');
        if (act === 'short-polish') return askRevision(1);
        if (act === 'short-analyze') return runEngine('short-analyze');
      };
    });
    return;
  }
  el.innerHTML = `
    <p class="hint" style="margin:4px 4px 12px">这条链路跑的是原版脚本与契约：定方向 → 定设定 → build_architect_brief → 细纲契约 → build_writer_prompt → 写手 → storyctl 检查 → tracking_commit 状态机。</p>
    ${card('⓪ 题材定位', !!f.position,
      f.position ? '已有 设定/题材定位.md（原版 workflow-setup 契约）' : '还没有题材定位。原版第一步：定方向，产出题材、读者、爽点、卖点',
      'direction', f.position ? '重新定方向' : '定方向')}
    ${card('· 定设定', (f.setting || 0) > 0,
      f.setting ? `已有 ${f.setting} 份设定文件${f.proseCard ? '，题材正文提示卡已生成' : '，缺题材正文提示卡'}` : '还没有人物卡与世界观。原版要求先定设定再排纲',
      'setting', '定设定')}
    ${card('① 卷纲', vol.ok, vol.exists ? `${vol.summary}` : '没有卷纲，先出卷纲（原版 outline_view 会校验剧情段与章节范围）', 'volume', vol.exists ? '重出卷纲' : '生成卷纲')}
    ${card('② 细纲', outlineCount > 0 && (contractOk !== false),
      outlineCount ? `已有 ${outlineCount} 份细纲${contractOk === false ? '，最新一份契约未过' : '，契约检查通过'}` : '还没有细纲。原版门禁：没有细纲不许动笔',
      'outline', outlineCount ? '再出 5 章细纲' : '生成细纲')}
    ${card('③ 正文', hasNextOutline, chapters ? `已写 ${chapters} 章，下一章是第 ${next} 章${hasNextOutline ? '' : '（缺这章细纲，原版门禁会拦）'}` : '还没有正文', 'write', `写第 ${next} 章`)}
    ${card('· 素材库', !!s.benchmark, s.benchmark ? `写正文时引用《${s.benchmark}》的拆文报告与相关章节梗概` : '还没有绑定参考小说。去素材库拆一本，再点「设为写作引用」', 'bench', s.benchmark ? '换/解绑素材' : '去素材库')}
    ${card('④ 追踪', !!s.tracking, s.tracking ? '状态机已初始化，提交后自动重生成上下文/伏笔/角色状态/时间线' : '还没有追踪状态，首章提交时会初始化', 'commit', '提交上一章追踪')}
    <div class="flow-card">
      <h3>更多能力</h3>
      <p>日更连写、大修、发布资料、封面提示词、作者习惯</p>
      <div class="row gap" style="flex-wrap:wrap">
        <button class="btn ghost small" data-act="daily">日更 3 章</button>
        <button class="btn ghost small" data-act="revision">大修上一章</button>
        <button class="btn ghost small" data-act="publish">发布资料</button>
        <button class="btn ghost small" data-act="cover">封面提示词</button>
        <button class="btn ghost small" data-act="memory">记住写作习惯</button>
        <button class="btn ghost small" data-act="analyze">拆文（前 3 章）</button>
        <button class="btn ghost small" data-act="review">审稿</button>
        <button class="btn ghost small" data-act="rebuild">导入重建设定</button>
        <button class="btn ghost small" data-act="short-design">短篇构思</button>
        <button class="btn ghost small" data-act="short-draft">短篇正文</button>
      </div>
    </div>
  `;
  $$('#pane-flow [data-act]').forEach(b => {
    b.onclick = () => {
      const act = b.dataset.act;
      if (act === 'direction') return askMoment('direction');
      if (act === 'setting') return askMoment('setting');
      if (act === 'volume') return runEngine('volume');
      if (act === 'outline') {
        const from = next;
        const to = next + 4;
        return runEngine('outline', { from, to });
      }
      if (act === 'write') return runEngine('write', { chapter: next });
      if (act === 'commit') return runEngine('commit', { chapter: Math.max(1, next - 1) });
      if (act === 'daily') return runEngine('daily', { chapter: next, count: 3 });
      if (act === 'revision') return askRevision(Math.max(1, next - 1));
      if (act === 'publish') return runEngine('publish');
      if (act === 'cover') return runEngine('cover');
      if (act === 'memory') return askMemory();
      if (act === 'bench') return showView('shelf');
      if (act === 'analyze') return runEngine('analyze', { from: 1, to: 3 });
      if (act === 'review') return runEngine('review', { chapter: Math.max(1, next - 1) });
      if (act === 'rebuild') return runEngine('rebuild');
      if (act === 'short-design') return askMoment('short-design');
      if (act === 'short-draft') return runEngine('short-draft');
    };
  });
}

function askRevision(n) {
  sheet(`<h3>大修第 ${n} 章</h3><p class="sub">按 workflow-revision 的诊断口径改：先说读者反应，再说要改哪里</p>
    <textarea class="sheet-input" id="rev-input" placeholder="例如：读起来发虚，前三段全是心理描写，没有具体动作"></textarea>
    <div class="row gap"><button class="btn ghost" onclick="closeSheet()">取消</button>
    <button class="btn primary" id="rev-go">开始改</button></div>`);
  $('#rev-go').onclick = () => {
    const v = $('#rev-input').value.trim();
    closeSheet();
    runEngine('revision', { chapter: Number(String(n).replace(/\D/g, '')) || 1, instruction: v });
  };
}

function askMemory() {
  sheet(`<h3>记住写作习惯</h3><p class="sub">只记你明确说过的长期习惯，会进作者记忆，之后写正文自动带上</p>
    <textarea class="sheet-input" id="mem-input" placeholder="例如：以后写对话不要用「说道」，直接接动作"></textarea>
    <div class="row gap"><button class="btn ghost" onclick="closeSheet()">取消</button>
    <button class="btn primary" id="mem-go">记下</button></div>`);
  $('#mem-go').onclick = () => {
    const v = $('#mem-input').value.trim();
    if (!v) return toast('说点什么');
    closeSheet();
    runEngine('memory', { instruction: v });
  };
}

function askMoment(step) {
  if (step === 'short-design') {
    sheet(`<h3>短篇构思</h3><p class="sub">先定情绪，再定故事（story-short-write Phase 2）</p>
      <textarea class="sheet-input" id="moment-input" placeholder="例如：知乎盐言，8000 字，意难平，前男友结婚请我当伴娘"></textarea>
      <div class="row gap"><button class="btn ghost" onclick="closeSheet()">取消</button>
      <button class="btn primary" id="moment-go">开始</button></div>`);
    $('#moment-go').onclick = () => {
      const v = $('#moment-input').value.trim();
      closeSheet();
      runEngine('short-design', { instruction: v });
    };
    return;
  }
  const isDir = step === 'direction';
  sheet(`<h3>${isDir ? '定方向' : '定设定'}</h3>
    <p class="sub">${isDir ? '原版 workflow-setup：题材、平台、读者、爽点、卖点、对标' : '原版 character-basics + long-genre-mechanics：世界观、人物卡、关系、题材正文提示卡'}</p>
    <textarea class="sheet-input" id="moment-input" placeholder="${isDir ? '例如：起点男频，东方奇幻，边塞守灯人，冷硬气质，想要以弱胜强的守城爽点' : '例如：力量体系要写清楚代价；主角怕火但能听见雾里的声音，这个秘密先不揭'}"></textarea>
    <div class="row gap"><button class="btn ghost" onclick="closeSheet()">取消</button>
    <button class="btn primary" id="moment-go">开始</button></div>`);
  $('#moment-go').onclick = () => {
    const v = $('#moment-input').value.trim();
    closeSheet();
    runEngine(step, { instruction: v });
  };
}

async function runEngine(step, opts = {}) {
  if (!state.cfg.hasKey || !state.cfg.model) {
    toast('先在设置里配置模型');
    return showView('settings');
  }
  const titles = { 'short-analyze': '短篇拆解', direction: '定方向', setting: '定设定', volume: '生成卷纲', outline: '生成细纲', write: '写正文', commit: '提交追踪', daily: '日更连写', revision: '大修', publish: '发布资料', cover: '封面提示词', memory: '作者记忆', analyze: '拆文', review: '审稿', rebuild: '导入重建', 'short-design': '短篇构思', 'short-draft': '短篇正文' };
  const box = $('#console');
  const phases = $('#console-phases');
  const out = $('#console-out');
  box.hidden = false;
  out.textContent = '';
  phases.innerHTML = '';
  $('#console-title').textContent = titles[step] || step;
  $('#console-sub').textContent = `${state.book}${opts.chapter ? ' · 第 ' + opts.chapter + ' 章' : opts.from ? ` · 第 ${opts.from}-${opts.to} 章` : ''}`;

  let acc = '';
  try {
    const r = await fetch('/api/engine/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ book: state.book, step, ...opts }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!chunk.startsWith('data:')) continue;
        let j;
        try { j = JSON.parse(chunk.slice(5).trim()); } catch { continue; }
        if (j.error) throw new Error(j.error);
        if (j.phase) {
          $$('#console-phases span.on').forEach(x => x.classList.remove('on'));
          const s = document.createElement('span');
          s.className = 'on';
          s.textContent = j.label && j.phase === 'report' ? '核对报告' : (j.label || j.phase);
          phases.appendChild(s);
          if (j.phase === 'report') out.textContent += `\n—— 脚本核对报告 ——\n${j.label}\n`;
        }
        if (j.d) { acc += j.d; out.textContent = acc; out.scrollTop = out.scrollHeight; }
        if (j.done) {
          $$('#console-phases span.on').forEach(x => x.classList.remove('on'));
          const okSpan = document.createElement('span');
          okSpan.className = j.ok ? 'ok' : 'err';
          okSpan.textContent = j.ok ? '通过' : '需处理';
          phases.appendChild(okSpan);
          const tail = j.check?.text || (j.results ? j.results.map(x => `第${x.chapter}章：${x.ok ? '通过' : '未过 ' + (x.names || []).join(',')}`).join('\n') : '')
            || (j.files ? '已写入：\n' + j.files.join('\n') + (j.problems?.length ? '\n\n问题：' + j.problems.join('；') : '') : '')
            || j.commit || '';
          if (tail) out.textContent = (j.text ? j.text + '\n\n' : '') + tail;
          if (j.file) out.textContent += `\n\n已写入：${j.file}`;
          if (j.results && step === 'daily') out.textContent = j.results.map(x => `第${x.chapter}章：${x.ok ? '通过' : '需处理'}${x.fixed ? '（已自动修标点）' : ''}${x.error ? ' ' + x.error : ''}`).join('\n');
          refreshAfterEngine();
        }
      }
    }
  } catch (e) {
    out.textContent = (out.textContent || '') + '\n\n失败：' + e.message;
    toast(e.message, 3000);
  }
}

async function refreshAfterEngine() {
  await reloadTree();
  loadFlow();
}

$('#console-close')?.addEventListener('click', () => { $('#console').hidden = true; });

/* ---------- 弹层 ---------- */
function sheet(html) {
  $('#sheet-content').innerHTML = html;
  $('#sheet-mask').hidden = false;
  $('#sheet-mask').onclick = e => { if (e.target.id === 'sheet-mask') closeSheet(); };
}
function closeSheet() { $('#sheet-mask').hidden = true; }

/* ---------- 设置 ---------- */
function fillPwaUrl() {
  const el = $('#pwa-url');
  if (el) el.textContent = location.origin + '/';
}

async function loadConfig() {
  const c = await api('/api/config');
  state.cfg = c;
  $('#cfg-base').value = c.baseURL || '';
  $('#cfg-key').value = '';
  $('#cfg-key').placeholder = c.hasKey ? c.apiKey : 'sk-…';
  $('#cfg-model').value = c.model || '';
  $('#cfg-temp').value = c.temperature ?? 0.85;
  $('#temp-val').textContent = Number(c.temperature ?? 0.85).toFixed(2);
  return c;
}

/* ---------- 事件 ---------- */
function bind() {
  $$('[data-back]').forEach(b => {
    b.onclick = async () => {
      if (b.dataset.back === 'book') {
        await saveFile();
        await reloadTree();
        showView('book');
      } else if (b.dataset.back === 'shelf') {
        if (document.querySelector('#view-bench.active')) { showView('shelf'); return; }
        await saveFile();
        showView('shelf');
        loadBooks();
      }
    };
  });

  $('#btn-settings').onclick = () => { loadConfig(); fillPwaUrl(); showView('settings'); };

  $('#btn-newbook').onclick = () => {
    sheet(`<h3>新建一本书</h3><p class="sub">会建好 设定 / 大纲 / 追踪 / 正文 四个目录</p>
      <input class="sheet-input" id="new-book-name" placeholder="书名列如：北境执灯人" autofocus>
      <div class="row gap"><button class="btn ghost" onclick="closeSheet()">取消</button>
      <button class="btn ghost" id="do-new-short">建短篇</button>
      <button class="btn primary" id="do-new-book">建长篇</button></div>`);
    const createBook = async (short) => {
      const name = $('#new-book-name').value.trim();
      if (!name) return toast('书名不能为空');
      try {
        await api('/api/books', { method: 'POST', body: JSON.stringify({ name, short }) });
        closeSheet(); await loadBooks(); openBook(name);
      } catch (e) { toast(e.message); }
    };
    $('#do-new-book').onclick = () => createBook(false);
    $('#do-new-short').onclick = () => createBook(true);
  };

  $('#btn-import-bench').onclick = () => {
    sheet(`<h3>导入参考小说</h3><p class="sub">TXT 按「第X章」拆章，进素材库后可拆成梗概/角色/设定</p>
      <input class="sheet-input" id="bench-name" placeholder="书名（素材库里的名字）">
      <input class="sheet-input" id="bench-file" type="file" accept=".txt,text/plain">
      <div class="row gap"><button class="btn ghost" onclick="closeSheet()">取消</button>
      <button class="btn primary" id="do-bench">导入</button></div>`);
    $('#do-bench').onclick = async () => {
      const name = $('#bench-name').value.trim();
      const f = $('#bench-file').files[0];
      if (!name || !f) return toast('书名和文件都要');
      try {
        const text = await f.text();
        const j = await api('/api/benchmarks/import', { method: 'POST', body: JSON.stringify({ name, text }) });
        closeSheet(); await loadBenchmarks(); toast(`已导入 ${j.count} 章`); openBench(name);
      } catch (e) { toast(e.message, 3000); }
    };
  };

  $('#btn-import').onclick = () => {
    sheet(`<h3>导入 TXT</h3><p class="sub">按「第X章」自动拆章，写进新书</p>
      <input class="sheet-input" id="import-name" placeholder="书名">
      <input class="sheet-input" id="import-file" type="file" accept=".txt,text/plain">
      <div class="row gap"><button class="btn ghost" onclick="closeSheet()">取消</button>
      <button class="btn primary" id="do-import">导入</button></div>`);
    $('#do-import').onclick = async () => {
      const name = $('#import-name').value.trim();
      const f = $('#import-file').files[0];
      if (!name || !f) return toast('书名和文件都要');
      try {
        const text = await f.text();
        const j = await api('/api/import', { method: 'POST', body: JSON.stringify({ name, text }) });
        closeSheet(); await loadBooks(); toast(`已导入 ${j.count} 章`); openBook(name);
      } catch (e) { toast(e.message, 3000); }
    };
  };

  $$('.tab').forEach(t => t.onclick = () => setTab(t.dataset.tab));

  $('#btn-bench-menu').onclick = () => {
    sheet(`<h3>${escapeHtml(benchState.name)}</h3><div class="sheet-list">
      <button id="bm-report">看拆文报告</button>
      <button id="bm-all">从第一章重拆</button>
      </div><button class="btn ghost" onclick="closeSheet()">关闭</button>`);
    $('#bm-report').onclick = () => { closeSheet(); openBenchFile('拆文报告.md'); };
    $('#bm-all').onclick = () => { closeSheet(); runBenchAnalyze(1); };
  };

  $('#btn-book-menu').onclick = () => {
    sheet(`<h3>${escapeHtml(state.book)}</h3><div class="sheet-list">
      <button id="m-new">新建一章</button>
      <button id="m-outline">让 AI 出细纲</button>
      <button id="m-export">导出为 TXT</button>
      <button class="danger" id="m-delete">删除这本书</button>
      </div><button class="btn ghost" onclick="closeSheet()">关闭</button>`);
    $('#m-new').onclick = () => { closeSheet(); newChapter(); };
    $('#m-outline').onclick = async () => { closeSheet(); await ensureFile('大纲/细纲.md'); await openFile('大纲/细纲.md'); runAI('outline'); };
    $('#m-export').onclick = () => { window.open('/api/export?book=' + encodeURIComponent(state.book), '_blank'); closeSheet(); };
    $('#m-delete').onclick = async () => {
      if (!confirm(`删除《${state.book}》及全部文稿？不可恢复。`)) return;
      await api('/api/books/' + encodeURIComponent(state.book), { method: 'DELETE' });
      closeSheet(); showView('shelf'); loadBooks();
    };
  };

  $('#fab-new-chapter').onclick = () => {
    const active = $('.tab.active')?.dataset.tab || 'chapters';
    if (active === 'chapters') return newChapter();
    const dir = { setting: '设定', outline: '大纲', tracking: '追踪' }[active];
    const name = prompt(`在「${dir}」里新建文件，输入文件名：`, '新文件');
    if (!name) return;
    const rel = `${dir}/${name.replace(/\.md$/, '')}.md`;
    api('/api/file', { method: 'PUT', body: JSON.stringify({ path: `${state.book}/${rel}`, content: `# ${name}\n\n` }) })
      .then(async () => { await reloadTree(); await openFile(rel); })
      .catch(e => toast(e.message));
  };

  $('#editor').addEventListener('input', scheduleSave);
  $('#editor').addEventListener('keyup', updateMeta);

  $$('.act[data-ai]').forEach(b => {
    b.onclick = async () => {
      await saveFile();
      const mode = b.dataset.ai;
      if (mode === 'deslop') {
        const ed = $('#editor');
        const sel = ed.value.slice(ed.selectionStart, ed.selectionEnd);
        if (!sel) return toast('先选中要改写的段落');
      }
      runAI(mode);
    };
  });

  $('#btn-ai-more').onclick = () => {
    sheet(`<h3>更多动作</h3><div class="sheet-list">
      <button data-m="polish">润色这段<small>选中文字后更自然，提升画面感</small></button>
      <button data-m="deslop">整章去 AI 味<small>全文重写，去掉套话和书面语</small></button>
      <button data-m="chapter">重写这一章<small>按细纲重出全文</small></button>
      <button data-m="outline">生成细纲<small>为接下来 5 章出可执行细纲</small></button>
      <button data-m="custom">带要求生成…<small>自己写一句要求</small></button>
      <button data-m="check">体检本章<small>原版检测器：AI 腔、破折号、断章、复读</small></button>
      </div><button class="btn ghost" onclick="closeSheet()">关闭</button>`);
    $$('#sheet-content [data-m]').forEach(btn => {
      btn.onclick = () => {
        const m = btn.dataset.m;
        closeSheet();
        if (m === 'custom') return askInstruction();
        if (m === 'check') return runCheck(true);
        runAI(m);
      };
    });
  };

  $('#btn-stop').onclick = () => state.streaming?.abort();
  $('#stream-panel').addEventListener('click', e => { if (e.target.id === 'stream-panel') closeStream(); });

  $('#btn-editor-menu').onclick = () => {
    sheet(`<h3>${escapeHtml(state.file || '')}</h3><div class="sheet-list">
      <button id="e-rename">重命名</button>
      <button id="e-export">导出全书 TXT</button>
      <button class="danger" id="e-delete">删除此文</button>
      </div><button class="btn ghost" onclick="closeSheet()">关闭</button>`);
    $('#e-rename').onclick = () => {
      const cur = state.file.split('/').pop().replace(/\.md$/, '');
      const next = prompt('新的文件名', cur);
      if (!next || next === cur) return;
      api('/api/file/rename', { method: 'POST', body: JSON.stringify({ from: `${state.book}/${state.file}`, to: `${state.book}/${state.file.replace(/[^/]+$/, next + '.md')}` }) })
        .then(async () => { closeSheet(); const dir = state.file.replace(/[^/]+$/, ''); await reloadTree(); await openFile(dir + next + '.md'); })
        .catch(e => toast(e.message));
    };
    $('#e-export').onclick = () => { window.open('/api/export?book=' + encodeURIComponent(state.book), '_blank'); closeSheet(); };
    $('#e-delete').onclick = async () => {
      if (!confirm('删除这篇文章？')) return;
      await api('/api/file?path=' + encodeURIComponent(`${state.book}/${state.file}`), { method: 'DELETE' });
      closeSheet(); state.file = null; await reloadTree(); showView('book');
    };
  };

  // 设置
  $('#cfg-temp').oninput = () => { $('#temp-val').textContent = Number($('#cfg-temp').value).toFixed(2); };
  $('#btn-save-cfg').onclick = async () => {
    try {
      const j = await api('/api/config', {
        method: 'PUT', body: JSON.stringify({
          baseURL: $('#cfg-base').value.trim(),
          apiKey: $('#cfg-key').value.trim(),
          model: $('#cfg-model').value.trim(),
          temperature: Number($('#cfg-temp').value),
        }),
      });
      $('#cfg-status').textContent = '已保存';
      state.cfg = await loadConfig();
      toast('设置已保存');
    } catch (e) { toast(e.message); }
  };
  $('#btn-fetch-models').onclick = async () => {
    $('#cfg-status').textContent = '拉取中…';
    try {
      await $('#btn-save-cfg').click();
      const j = await api('/api/models');
      const box = $('#model-list');
      box.hidden = false;
      box.innerHTML = j.models.map(m => `<button>${escapeHtml(m)}</button>`).join('') || '<span class="hint">没有返回模型</span>';
      $$('#model-list button').forEach(b => b.onclick = () => {
        $('#cfg-model').value = b.textContent;
        state.cfg.model = b.textContent;
        box.hidden = true;
      });
      $('#cfg-status').textContent = `共 ${j.models.length} 个模型，点一个选中`;
    } catch (e) { $('#cfg-status').textContent = e.message; }
  };
  $('#btn-test').onclick = async () => {
    $('#cfg-status').textContent = '测试中…';
    try {
      await $('#btn-save-cfg').click();
      const j = await api('/api/test', { method: 'POST', body: '{}' });
      $('#cfg-status').textContent = '连通 ✓ ' + (j.reply || '');
    } catch (e) { $('#cfg-status').textContent = '失败：' + e.message; }
  };

  window.addEventListener('beforeunload', () => { saveFile(); });
}

async function ensureFile(path) {
  try { await api('/api/file?path=' + encodeURIComponent(`${state.book}/${path}`)); }
  catch { await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: `${state.book}/${path}`, content: '' }) }); }
}

async function newChapter() {
  try {
    const j = await api('/api/chapter/new', { method: 'POST', body: JSON.stringify({ book: state.book }) });
    await reloadTree();
    setTab('chapters');
    await openFile(j.path);
    $('#editor').focus();
  } catch (e) { toast(e.message); }
}

function askInstruction() {
  sheet(`<h3>带要求生成</h3><p class="sub">写给 AI 的具体要求，比如「让男主被当众打脸，结尾留反转」</p>
    <textarea class="sheet-input" id="ins-input" placeholder="这一章要发生什么…"></textarea>
    <div class="row gap"><button class="btn ghost" onclick="closeSheet()">取消</button>
    <button class="btn primary" id="do-ins">开始写</button></div>`);
  $('#do-ins').onclick = () => {
    const v = $('#ins-input').value.trim();
    closeSheet();
    runAI('continue', v);
  };
}

function showOffline() {
  const box = document.getElementById('shelf-scroll');
  if (!box) return;
  box.innerHTML = `
    <div class="flow-card" style="margin-top:20px">
      <h3><span class="dot bad"></span>服务没有在运行</h3>
      <p>工作台的后台跑在 Minis 的 Linux 环境里。Minis 退到后台会被系统挂起，回前台需要重新拉起。</p>
      <p style="margin-top:10px">回到 Minis 对话里说一句「打开工作台」，或者点下面的按钮。</p>
      <div class="row gap" style="margin-top:12px">
        <button class="btn primary" onclick="location.reload()">重试</button>
      </div>
      <p style="margin-top:14px;font-size:12px">想让它一直在，去设置打开「增强后台运行」：<br>
      <code style="font-size:11px">minis://settings/background</code></p>
    </div>`;
}

/* ---------- 启动 ---------- */
async function loadCapabilities() {
  try {
    const c = await api('/api/capabilities');
    state.caps = c;
    if (c.engine === false) {
      $$('.tab[data-tab="flow"]').forEach(t => { t.style.display = 'none'; });
    }
  } catch (e) { /* 老服务没有这个接口，按全功能处理 */ }
}

(async () => {
  bind();
  await loadCapabilities();
  try {
    await loadConfig();
    await loadBooks();
  } catch (e) {
    showOffline();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
