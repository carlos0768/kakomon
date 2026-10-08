/**
 * 管理者向け UI (依存なしの 1 ページ)。
 * 過去問 PDF のアップロード → 傾向分析 → 作問 → 下書き確認 → 承認・公開 → ユーザー管理 をブラウザだけで行う。
 * API 呼び出しには KAKOMON_ADMIN_TOKEN を Bearer で付ける (未設定の環境では不要)。
 */
export function adminUiHtml(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>予想問題 管理画面</title>
<style>
  :root { --fg:#1a1a1a; --bg:#f5f6f8; --card:#fff; --line:#ddd; --accent:#2b5bd7; --ok:#1b8a3c; --ng:#c0392b; --warn:#b7791f; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eee; --bg:#121212; --card:#1e1e1e; --line:#333; --accent:#7aa2ff; } }
  body { margin:0; font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; color:var(--fg); background:var(--bg); line-height:1.6; }
  main { max-width: 1000px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; } h2 { font-size: 17px; margin: 0 0 8px; } h3 { font-size: 15px; margin: 12px 0 6px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; margin:12px 0; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:7px 12px; cursor:pointer; font-size:14px; }
  button.secondary { background:transparent; color:var(--accent); border:1px solid var(--accent); }
  button.danger { background:var(--ng); }
  button:disabled { opacity:.5; cursor:default; }
  input, select, textarea { padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); font-size:14px; }
  textarea { width:100%; box-sizing:border-box; min-height:60px; }
  label { display:block; font-size:13px; opacity:.8; margin-top:8px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  table { border-collapse:collapse; width:100%; font-size:14px; } td,th { border-bottom:1px solid var(--line); padding:6px 6px; text-align:left; vertical-align:top; }
  .muted { opacity:.7; font-size:13px; }
  .tag { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; border:1px solid var(--line); }
  .tag.published { color:var(--ok); border-color:var(--ok); } .tag.review, .tag.suspended { color:var(--warn); border-color:var(--warn); }
  .tag.failed, .tag.archived, .tag.rejected { color:var(--ng); border-color:var(--ng); } .tag.running { color:var(--accent); border-color:var(--accent); }
  .err { color:var(--ng); font-size:14px; min-height:1.2em; white-space:pre-wrap; }
  pre { white-space:pre-wrap; font-size:13px; background:rgba(127,127,127,.08); padding:10px; border-radius:6px; max-height:420px; overflow:auto; }
  nav a { margin-right:14px; }
  .spin::after { content:' ⏳'; }
</style>
</head>
<body>
<main>
  <h1>予想問題 管理画面</h1>
  <div id="login" class="card" style="display:none">
    <h2>管理者トークン</h2>
    <p class="muted">Vercel の環境変数 KAKOMON_ADMIN_TOKEN に設定した値を入れてください。</p>
    <div class="row"><input id="token" type="password" placeholder="管理者トークン" style="min-width:320px"><button id="loginBtn">ログイン</button></div>
    <div class="err" id="loginErr"></div>
  </div>
  <div id="app" style="display:none">
    <nav class="card row">
      <a href="#exams">1. 過去問</a><a href="#specs">2. 要件定義</a><a href="#generate">3. 予想問題</a><a href="#jobs">ジョブ</a><a href="#users">ユーザー</a>
      <span style="flex:1"></span><span class="muted" id="envInfo"></span>
      <a href="/kakomon" target="_blank">受験者画面</a><button id="logoutBtn" class="secondary">ログアウト</button>
    </nav>

    <section class="card" id="exams">
      <h2>1. 過去問を登録する</h2>
      <form id="uploadForm" class="row">
        <input type="file" id="pdf" accept="application/pdf" required>
        <input id="upTitle" placeholder="試験名 (例: ○○試験)">
        <input id="upYear" type="number" placeholder="年度" style="width:90px">
        <input id="upSession" placeholder="回次 (任意)" style="width:120px">
        <button type="submit" id="uploadBtn">アップロードして取り込む</button>
      </form>
      <p class="muted" id="uploadHint">写真をまとめた PDF でも可。取り込みには数分かかります。進行状況は「ジョブ」に出ます。</p>
      <div class="err" id="uploadErr"></div>
      <h3>登録済み</h3>
      <div id="examList"></div>
    </section>

    <section class="card" id="specs">
      <h2>2. 傾向を分析して要件定義を作る</h2>
      <div class="row">
        <input id="anTitle" placeholder="試験名" style="min-width:200px">
        <input id="anFocus" placeholder="追加指示 (例: 直近3年を重視)" style="min-width:260px">
        <button id="analyzeBtn">分析を実行</button>
      </div>
      <p class="muted">登録済みの過去問すべてを対象にします。2 年度以上あると精度が上がります。</p>
      <div class="err" id="analyzeErr"></div>
      <h3>要件定義一覧</h3>
      <div id="specList"></div>
      <pre id="specView" style="display:none"></pre>
    </section>

    <section class="card" id="generate">
      <h2>3. 予想問題を作る</h2>
      <div class="row">
        <select id="genSpec"></select>
        <input id="genTitle" placeholder="タイトル (例: 2026年度 予想問題 第1回)" style="min-width:260px">
        <select id="genRef"><option value="">見た目の参照: 最新の過去問</option></select>
        <input id="genCount" type="number" placeholder="設問数 (省略で要件どおり)" style="width:200px">
      </div>
      <label>追加指示 (任意)</label>
      <textarea id="genInstr" placeholder="例: 計算問題を多めに"></textarea>
      <div class="row" style="margin-top:8px"><button id="generateBtn">作問を開始</button><span class="muted">作問 → 校閲 → 改訂まで自動で進み、承認待ちで止まります (数分〜十数分)。</span></div>
      <div class="err" id="generateErr"></div>
      <h3>承認待ち・予想問題</h3>
      <div id="draftList"></div>
    </section>

    <section class="card" id="jobs">
      <h2>ジョブ (実行状況)</h2>
      <div id="jobList"></div>
    </section>

    <section class="card" id="users">
      <h2>受験者アカウント</h2>
      <div id="userList"></div>
    </section>
  </div>
</main>
<script>
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let token = ''; try { token = localStorage.getItem('kakomon.adminToken') || ''; } catch {}
const headers = () => token ? { authorization: 'Bearer ' + token } : {};
let me = null;
const mb = b => b ? (b / 1024 / 1024).toFixed(b % (1024 * 1024) ? 1 : 0) + 'MB' : '?';
const api = async (path, opts = {}) => {
  const h = { ...headers(), ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) };
  const r = await fetch(path, { ...opts, headers: h });
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) {
    let msg = j.error ? (typeof j.error === 'string' ? j.error : JSON.stringify(j.error)) : (r.status + ' ' + r.statusText);
    if (r.status === 413) msg = 'ファイルが大きすぎます (413)。' + (me && me.serverless ? 'Vercel 上では 4MB までしか送れません。手元で npm run dev を起動した管理画面からアップロードしてください。' : 'サーバの上限は ' + mb(me && me.maxUploadBytes) + ' です。');
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return j;
};
const fmt = d => d ? String(d).replace('T', ' ').slice(0, 19) : '';
const tag = s => '<span class="tag ' + esc(s) + '">' + esc(s) + '</span>';

async function init() {
  try {
    me = await api('/kakomon/admin/whoami');
    $('#login').style.display = 'none'; $('#app').style.display = '';
    $('#envInfo').textContent = 'DB: ' + me.dbDialect + (me.serverless ? ' / Vercel' : ' / ローカル') + (me.authRequired ? '' : ' / 認証なし');
    $('#uploadHint').textContent = '写真をまとめた PDF でも可 (' + mb(me.maxUploadBytes) + ' まで' + (me.serverless ? '。Vercel の制限なので、それより大きい PDF は手元の npm run dev の管理画面から' : '') + ')。取り込みには数分かかります。進行状況は「ジョブ」に出ます。';
    await refreshAll(); startPolling();
  } catch (e) {
    $('#login').style.display = ''; $('#app').style.display = 'none';
    if (token) $('#loginErr').textContent = 'トークンが違います (' + e.message + ')';
  }
}
$('#loginBtn').onclick = () => { token = $('#token').value.trim(); try { localStorage.setItem('kakomon.adminToken', token); } catch {} init(); };
$('#token').onkeydown = e => { if (e.key === 'Enter') $('#loginBtn').click(); };
$('#logoutBtn').onclick = () => { token = ''; try { localStorage.removeItem('kakomon.adminToken'); } catch {} location.reload(); };

let exams = [], specs = [], jobs = [];
async function refreshAll() { await Promise.all([loadExams(), loadSpecs(), loadJobs(), loadUsers()]); }

// ---------- 過去問 ----------
async function loadExams() {
  exams = (await api('/kakomon/admin/exams')).exams;
  const past = exams.filter(e => e.kind === 'past');
  $('#examList').innerHTML = past.length ? '<table><tr><th>年度</th><th>試験名</th><th>設問</th><th>正解あり</th><th>備考</th><th></th></tr>' + past.map(e =>
    '<tr><td>' + esc(e.year ?? '-') + ' ' + esc(e.session ?? '') + '</td><td>' + esc(e.title) + '</td><td>' + e.questionCount + '</td>'
    + '<td class="' + (e.answeredCount < e.questionCount ? 'err' : '') + '">' + e.answeredCount + '/' + e.questionCount + '</td>'
    + '<td class="muted">' + esc((e.extractionNotes || []).slice(0, 2).join(' / ')) + '</td>'
    + '<td class="row"><a class="muted" href="/kakomon/admin/exams/' + e.examId + '/preview" target="_blank" onclick="return openPreview(event, this.href)">確認</a>'
    + (e.answeredCount < e.questionCount ? '<button class="secondary" onclick="solve(\\'' + e.examId + '\\')">正解を推定</button>' : '') + '</td></tr>').join('') + '</table>'
    : '<p class="muted">まだ登録されていません。上のフォームから PDF をアップロードしてください。</p>';
  // 参照過去問の選択肢
  $('#genRef').innerHTML = '<option value="">見た目の参照: 最新の過去問</option>' + past.map(e => '<option value="' + e.examId + '">' + esc((e.year ?? '') + ' ' + e.title) + '</option>').join('');
}
// プレビューはトークン付きで開けないので fetch してから新規タブに書き出す
window.openPreview = async (ev, href) => {
  ev.preventDefault();
  const url = href.split('?')[0] + (href.includes('answers=0') ? '?answers=0' : '');
  const r = await fetch(url, { headers: headers() }); const html = await r.text();
  const w = window.open('', '_blank'); w.document.open(); w.document.write(html); w.document.close();
  return false;
};
window.solve = async examId => { try { await api('/kakomon/admin/exams/' + examId + '/solve', { method: 'POST' }); await loadJobs(); } catch (e) { alert(e.message); } };
$('#uploadForm').onsubmit = async e => {
  e.preventDefault(); $('#uploadErr').textContent = '';
  const f = $('#pdf').files[0];
  if (me && me.maxUploadBytes && f.size > me.maxUploadBytes) {
    $('#uploadErr').textContent = 'このファイルは ' + mb(f.size) + ' で、上限 ' + mb(me.maxUploadBytes) + ' を超えています。' + (me.serverless ? 'Vercel 上では送れないので、手元で npm run dev を起動した管理画面 (http://localhost:4111/kakomon/admin) からアップロードしてください。' : '.env の KAKOMON_MAX_UPLOAD_MB で上限を上げられます (Claude の PDF 入力上限は 32MB)。');
    return;
  }
  const fd = new FormData(); fd.append('file', f); fd.append('title', $('#upTitle').value); fd.append('year', $('#upYear').value); fd.append('session', $('#upSession').value);
  $('#uploadBtn').disabled = true; $('#uploadBtn').classList.add('spin');
  try { await api('/kakomon/admin/upload', { method: 'POST', body: fd }); $('#pdf').value = ''; await loadJobs(); location.hash = '#jobs'; }
  catch (err) { $('#uploadErr').textContent = err.message; }
  finally { $('#uploadBtn').disabled = false; $('#uploadBtn').classList.remove('spin'); }
};

// ---------- 要件定義 ----------
async function loadSpecs() {
  specs = (await api('/kakomon/admin/specs')).specs;
  $('#specList').innerHTML = specs.length ? '<table><tr><th>作成</th><th>試験名</th><th>設問数</th><th>分野</th><th></th></tr>' + specs.map(s =>
    '<tr><td>' + fmt(s.createdAt) + '</td><td>' + esc(s.title) + '</td><td>' + s.questionCount + '</td><td class="muted">' + s.domains.map(d => esc(d.domain) + ' ' + Math.round(d.share * 100) + '%').join(', ') + '</td>'
    + '<td><button class="secondary" onclick="viewSpec(\\'' + s.specId + '\\')">内容を見る</button></td></tr>').join('') + '</table>'
    : '<p class="muted">まだありません。過去問を登録してから「分析を実行」を押してください。</p>';
  $('#genSpec').innerHTML = specs.length ? specs.map(s => '<option value="' + s.specId + '">' + esc(s.title) + ' (' + fmt(s.createdAt) + ')</option>').join('') : '<option value="">要件定義がありません</option>';
}
window.viewSpec = async id => { const r = await fetch('/kakomon/admin/specs/' + id + '/markdown', { headers: headers() }); $('#specView').textContent = await r.text(); $('#specView').style.display = ''; };
$('#analyzeBtn').onclick = async () => {
  $('#analyzeErr').textContent = '';
  try { await api('/kakomon/admin/analyze', { method: 'POST', body: JSON.stringify({ title: $('#anTitle').value || undefined, focus: $('#anFocus').value || undefined }) }); await loadJobs(); location.hash = '#jobs'; }
  catch (e) { $('#analyzeErr').textContent = e.message; }
};

// ---------- 予想問題 ----------
$('#generateBtn').onclick = async () => {
  $('#generateErr').textContent = '';
  const body = { specId: $('#genSpec').value, title: $('#genTitle').value.trim(), referenceExamId: $('#genRef').value || undefined, questionCount: $('#genCount').value ? Number($('#genCount').value) : undefined, instructions: $('#genInstr').value || undefined };
  if (!body.specId || !body.title) { $('#generateErr').textContent = '要件定義とタイトルを指定してください'; return; }
  try { await api('/kakomon/admin/generate', { method: 'POST', body: JSON.stringify(body) }); await loadJobs(); location.hash = '#jobs'; }
  catch (e) { $('#generateErr').textContent = e.message; }
};
function renderDrafts() {
  const pending = jobs.filter(j => j.kind === 'generate' && j.status === 'suspended');
  const predicted = exams.filter(e => e.kind === 'predicted');
  let html = '';
  if (pending.length) html += '<h3>承認待ち</h3>' + pending.map(j => { const s = j.suspend || {}; return '<div class="card"><strong>' + esc(s.title || j.title) + '</strong> ' + tag('suspended')
    + '<div class="muted">' + s.questionCount + ' 問 / 校閲スコア ' + s.reviewScore + ' / blocker ' + s.blockerCount + ' 件 / 校閲判定: ' + (s.reviewApproved ? '合格' : '要確認') + '</div>'
    + '<div class="row" style="margin-top:6px"><button class="secondary" onclick="previewExam(\\'' + s.examId + '\\')">内容を確認 (正解つき)</button>'
    + '<button onclick="decide(\\'' + j.id + '\\', true)">承認して公開</button><button class="danger" onclick="decide(\\'' + j.id + '\\', false)">却下</button></div></div>'; }).join('');
  html += '<h3>予想問題</h3>' + (predicted.length ? '<table><tr><th>タイトル</th><th>設問</th><th>状態</th><th></th></tr>' + predicted.map(e =>
    '<tr><td>' + esc(e.title) + '</td><td>' + e.questionCount + '</td><td>' + tag(e.status) + '</td><td class="row">'
    + '<button class="secondary" onclick="previewExam(\\'' + e.examId + '\\')">確認</button>'
    + (e.status === 'published' ? '<a class="muted" href="/kakomon/exams/' + e.examId + '/print" target="_blank">受験者向け表示</a><button class="secondary" onclick="setStatus(\\'' + e.examId + '\\',\\'archived\\')">非公開にする</button>'
      : (e.status === 'archived' || e.status === 'review') ? '<button onclick="setStatus(\\'' + e.examId + '\\',\\'published\\')">公開する</button>' : '')
    + '</td></tr>').join('') + '</table>' : '<p class="muted">まだありません。</p>');
  $('#draftList').innerHTML = html;
}
window.previewExam = async id => { const r = await fetch('/kakomon/admin/exams/' + id + '/preview', { headers: headers() }); const html = await r.text(); const w = window.open('', '_blank'); w.document.open(); w.document.write(html); w.document.close(); };
window.decide = async (jobId, approved) => {
  if (!confirm(approved ? 'この予想問題を公開します。よろしいですか？' : 'この下書きを却下します。よろしいですか？')) return;
  try { await api('/kakomon/admin/jobs/' + jobId + '/approve', { method: 'POST', body: JSON.stringify({ approved }) }); await loadJobs(); } catch (e) { alert(e.message); }
};
window.setStatus = async (examId, status) => { try { await api('/kakomon/admin/exams/' + examId + '/status', { method: 'POST', body: JSON.stringify({ status }) }); await loadExams(); renderDrafts(); } catch (e) { alert(e.message); } };

// ---------- ジョブ ----------
const KIND = { ingest: '取り込み', analyze: '傾向分析', generate: '作問', solve: '正解推定' };
async function loadJobs() {
  jobs = (await api('/kakomon/admin/jobs')).jobs;
  $('#jobList').innerHTML = jobs.length ? '<table><tr><th>開始</th><th>種類</th><th>内容</th><th>状態</th><th>結果</th></tr>' + jobs.slice(0, 30).map(j =>
    '<tr><td class="muted">' + fmt(j.createdAt) + '</td><td>' + esc(KIND[j.kind] || j.kind) + '</td><td>' + esc(j.title) + '</td><td>' + tag(j.status) + '</td><td class="muted">' + esc(summarize(j)) + '</td></tr>').join('') + '</table>'
    : '<p class="muted">まだありません。</p>';
  renderDrafts();
}
const parseTs = s => { if (!s) return NaN; const t = String(s).trim(); return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z'); };
const elapsedText = ms => { if (!(ms >= 0)) return ''; const s = Math.floor(ms / 1000); return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'; };
function summarize(j) {
  if (j.status === 'failed') return j.error || '失敗';
  if (j.status === 'running') {
    const p = j.progress || {};
    const since = parseTs(p.at || j.updatedAt || j.createdAt);
    const stale = Number.isFinite(since) && Date.now() - since > 3 * 60 * 1000;
    const parts = ['実行中 ' + elapsedText(Date.now() - parseTs(j.createdAt))];
    if (p.phase) parts.push(p.phase);
    if (p.outputChars) parts.push('出力 ' + Number(p.outputChars).toLocaleString() + ' 文字');
    if (p.note) parts.push(p.note);
    if (stale) parts.push('※ ' + elapsedText(Date.now() - since) + ' 更新なし。サーバ (npm run dev) が止まっていないか確認してください');
    return parts.join(' / ');
  }
  const r = j.result || {};
  if (j.kind === 'ingest' && r.questionCount != null) return r.questionCount + ' 問 (正解あり ' + r.answeredCount + ')' + (r.extractionNotes?.length ? ' / 注意: ' + r.extractionNotes.join(' / ') : '');
  if (j.kind === 'analyze' && r.specId) return '要件定義を作成 (' + (r.domains || []).length + ' 分野)';
  if (j.kind === 'generate' && j.status === 'suspended') return '承認待ち (上の「3. 予想問題」で確認)';
  if (j.kind === 'generate' && r.status) return r.status === 'published' ? '公開済み' : r.status;
  if (j.kind === 'solve' && r.solved) return r.solved.length + ' 問に正解を付与';
  return '';
}
let pollTimer;
function startPolling() { clearInterval(pollTimer); pollTimer = setInterval(async () => { if (jobs.some(j => j.status === 'running')) { await loadJobs(); await loadExams(); await loadSpecs(); } }, 5000); }

// ---------- ユーザー ----------
async function loadUsers() {
  const { users } = await api('/kakomon/admin/users');
  $('#userList').innerHTML = users.length ? '<table><tr><th>ユーザー名</th><th>登録日</th><th></th></tr>' + users.map(u =>
    '<tr><td>' + esc(u.username) + '</td><td class="muted">' + fmt(u.createdAt) + '</td><td><button class="secondary" onclick="resetPw(\\'' + esc(u.username) + '\\')">パスワード再設定</button></td></tr>').join('') + '</table>'
    : '<p class="muted">まだ登録されていません。受験者が /kakomon から自分で登録します。</p>';
}
window.resetPw = async username => {
  const pw = prompt(username + ' の新しいパスワード (8 文字以上)'); if (!pw) return;
  try { await api('/kakomon/admin/users/' + encodeURIComponent(username) + '/reset-password', { method: 'POST', body: JSON.stringify({ password: pw }) }); alert('再設定しました'); } catch (e) { alert(e.message); }
};

init();
</script>
</body>
</html>`
}
