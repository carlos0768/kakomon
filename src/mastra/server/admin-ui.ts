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
  button.small { padding:3px 9px; font-size:13px; }
  button:disabled { opacity:.5; cursor:default; }
  input, select, textarea { padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); font-size:14px; }
  textarea { width:100%; box-sizing:border-box; min-height:60px; }
  label { display:block; font-size:13px; opacity:.8; margin-top:8px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  table { border-collapse:collapse; width:100%; font-size:14px; } td,th { border-bottom:1px solid var(--line); padding:6px 6px; text-align:left; vertical-align:top; }
  .muted { opacity:.7; font-size:13px; }
  .tag { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; border:1px solid var(--line); }
  .tag.published { color:var(--ok); border-color:var(--ok); } .tag.review, .tag.suspended { color:var(--warn); border-color:var(--warn); }
  .tag.failed, .tag.archived, .tag.rejected { color:var(--ng); border-color:var(--ng); } .tag.cancelled { opacity:.7; } .tag.running { color:var(--accent); border-color:var(--accent); }
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
        <button type="submit" id="uploadBtn" data-act="upload">アップロードして取り込む</button>
      </form>
      <p class="muted" id="uploadHint">写真をまとめた PDF でも可。取り込みには数分かかります。進行状況は「ジョブ」に出ます。</p>
      <div class="err" id="uploadErr"></div>
      <h3>登録済み</h3>
      <div id="examList"></div>
      <input type="file" id="answerPdf" accept="application/pdf" style="display:none">
      <p class="muted">「正解データをインポート」で解答・解説の PDF を選ぶと、その過去問に公式の正解と解説を反映します (AI 推定の正解も上書きします)。</p>
      <div class="err" id="answerErr"></div>
    </section>

    <section class="card" id="specs">
      <h2>2. 傾向を分析して要件定義を作る</h2>
      <h3>分析する過去問 <span class="muted" style="font-weight:normal">(<a href="#" onclick="return checkExams(true)">すべて選ぶ</a> / <a href="#" onclick="return checkExams(false)">すべて外す</a>)</span></h3>
      <div id="anExams"></div>
      <div class="row">
        <input id="anTitle" placeholder="試験名" style="min-width:200px">
        <input id="anFocus" placeholder="追加指示 (例: 直近3年を重視)" style="min-width:260px">
        <button id="analyzeBtn" data-act="analyze">分析を実行</button>
      </div>
      <p class="muted">チェックした過去問だけを対象にします (別の試験の過去問は混ざりません)。同じ試験を 2 年度以上選ぶと精度が上がります。</p>
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
      <div class="row" style="margin-top:8px"><button id="generateBtn" data-act="generate">作問を開始</button><span class="muted">作問 → 校閲 → 改訂まで自動で進み、承認待ちで止まります (数分〜十数分)。</span></div>
      <div class="err" id="generateErr"></div>
      <h3>承認待ち・予想問題</h3>
      <div id="draftList"></div>
      <div class="card" id="editBox">
        <h3 style="margin-top:0">プロンプトで編集する</h3>
        <div class="row"><select id="editExam" style="min-width:320px"></select></div>
        <label>編集の指示</label>
        <textarea id="editPrompt" placeholder="例: 問3 の正解が曖昧なので、正解が 1 つに定まるように選択肢を直して / 問12 を削除して / 計算問題を 2 問追加して / 全体の文体を「である」調に揃えて"></textarea>
        <div class="row" style="margin-top:8px"><button id="editBtn" data-act="edit">編集を実行</button><span class="muted">指示に関係する設問だけを書き換えます (数分)。承認待ちのまま編集でき、承認すると編集後の内容が公開されます。公開中のものは非公開にしてから編集してください。</span></div>
        <div class="err" id="editErr"></div>
      </div>
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
// ---------- 連打防止 ----------
// 実行中の操作のキー。data-act="キー" のボタンは、その操作の応答が返るまで押せない (5 秒ごとの描き直しでも保つ)
const pending = new Set();
async function act(key, fn) {
  if (pending.has(key)) return;
  pending.add(key); syncBusy();
  try { return await fn(); } finally { pending.delete(key); syncBusy(); }
}
// 正解推定・正解インポートが実行中の過去問 (同じ過去問に二重にかけない)
const answerBusy = () => new Set(jobs.filter(j => j.status === 'running' && (j.kind === 'solve' || j.kind === 'answers')).map(j => j.input && j.input.examId));
function syncBusy() {
  const busyExams = answerBusy();
  for (const b of document.querySelectorAll('button[data-act]')) {
    const on = pending.has(b.dataset.act) || (b.dataset.exam && busyExams.has(b.dataset.exam)) || (me && me.serverless && b.dataset.heavy);
    b.disabled = Boolean(on);
    b.classList.toggle('spin', pending.has(b.dataset.act));
  }
}
const tag = s => '<span class="tag ' + esc(s) + '">' + esc(s) + '</span>';

async function init() {
  try {
    me = await api('/kakomon/admin/whoami');
    $('#login').style.display = 'none'; $('#app').style.display = '';
    $('#envInfo').textContent = 'DB: ' + me.dbDialect + (me.serverless ? ' / Vercel' : ' / ローカル') + (me.authRequired ? '' : ' / 認証なし');
    $('#uploadHint').textContent = '写真をまとめた PDF でも可 (' + mb(me.maxUploadBytes) + ' まで)。取り込みには数分かかります。進行状況は「ジョブ」に出ます。';
    if (me.serverless) {
      // Vercel 上では応答直後に関数が止まるため、重いジョブは始められない (承認・公開切替・ユーザー管理のみ)
      const note = 'Vercel 上では実行できません。手元で npm run dev を起動した管理画面 (http://localhost:4111/kakomon/admin) から実行してください';
      for (const id of ['#uploadBtn', '#analyzeBtn', '#generateBtn', '#editBtn']) { const b = $(id); b.dataset.heavy = '1'; b.disabled = true; b.title = note; }
      $('#uploadHint').textContent = note + '。ここでは承認・公開切替・ユーザー管理ができます。';
      $('#analyzeErr').textContent = note; $('#generateErr').textContent = note; $('#editErr').textContent = note;
    }
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
    '<tr><td>' + esc(e.year ?? '-') + ' ' + esc(e.session ?? '') + '</td><td>' + esc(e.title) + ' <button class="secondary small" data-act="rename:' + e.examId + '" data-exam="' + e.examId + '" onclick="renameExam(\\'' + e.examId + '\\')" title="試験名を変更">名称変更</button></td><td>' + e.questionCount + '</td>'
    + '<td class="' + (e.answeredCount < e.questionCount ? 'err' : '') + '">' + e.answeredCount + '/' + e.questionCount + '</td>'
    + '<td class="muted">' + esc((e.extractionNotes || []).slice(0, 2).join(' / ')) + '</td>'
    + '<td class="row"><a class="muted" href="/kakomon/admin/exams/' + e.examId + '/preview" target="_blank" onclick="return openPreview(event, this.href)">確認</a>'
    + (e.answeredCount < e.questionCount ? '<button class="secondary" data-act="solve:' + e.examId + '" data-exam="' + e.examId + '" data-heavy="1" onclick="solve(\\'' + e.examId + '\\')">正解を推定</button>' : '')
    + '<button class="secondary" data-act="answers:' + e.examId + '" data-exam="' + e.examId + '" data-heavy="1" onclick="importAnswers(\\'' + e.examId + '\\')">正解データをインポート</button></td></tr>').join('') + '</table>'
    : '<p class="muted">まだ登録されていません。上のフォームから PDF をアップロードしてください。</p>';
  // 参照過去問の選択肢
  $('#genRef').innerHTML = '<option value="">見た目の参照: 最新の過去問</option>' + past.map(e => '<option value="' + e.examId + '">' + esc((e.year ?? '') + ' ' + e.title) + '</option>').join('');
  // 分析対象の選択 (再読み込みしてもチェック状態は保つ。新しく登録された過去問は既定でチェック)
  const checked = new Set([...document.querySelectorAll('#anExams input')].filter(i => i.checked).map(i => i.value));
  const known = new Set([...document.querySelectorAll('#anExams input')].map(i => i.value));
  $('#anExams').innerHTML = past.length ? past.map(e =>
    '<label class="row" style="gap:6px"><input type="checkbox" value="' + e.examId + '"' + (!known.has(e.examId) || checked.has(e.examId) ? ' checked' : '') + '> '
    + esc((e.year ?? '-') + ' ' + (e.session ?? '') + ' ' + e.title) + ' <span class="muted">(' + e.questionCount + '問' + (e.answeredCount < e.questionCount ? '、正解 ' + e.answeredCount + '/' + e.questionCount : '') + ')</span></label>').join('')
    : '<p class="muted">過去問を登録すると、ここに選択肢が出ます。</p>';
  // 要件定義一覧の「対象の過去問」表示は年度を使うので、過去問が読めたら描き直す
  if (specs.length) renderSpecs();
  syncBusy();
}
window.checkExams = on => { for (const i of document.querySelectorAll('#anExams input')) i.checked = on; return false; };
function examLabel(examId) { const e = exams.find(x => x.examId === examId); return e ? String(e.year ?? '-') + (e.session ? ' ' + e.session : '') : '(削除済み)'; }
function specSources(s) { const ids = s.sourceExamIds || []; return ids.length ? ids.map(examLabel).join(', ') : '-'; }
// プレビューはトークン付きで開けないので fetch してから新規タブに書き出す
window.openPreview = async (ev, href) => {
  ev.preventDefault();
  const url = href.split('?')[0] + (href.includes('answers=0') ? '?answers=0' : '');
  const r = await fetch(url, { headers: headers() }); const html = await r.text();
  const w = window.open('', '_blank'); w.document.open(); w.document.write(html); w.document.close();
  return false;
};
// 試験名の変更 (正解推定・インポートの実行中は押せない。サーバ側でも断る)
window.renameExam = examId => {
  if (pending.has('rename:' + examId)) return;
  const e = exams.find(x => x.examId === examId); if (!e) return;
  const title = prompt('新しい試験名', e.title);
  if (title == null || !title.trim() || title.trim() === e.title) return;
  return act('rename:' + examId, async () => {
    try { await api('/kakomon/admin/exams/' + examId + '/title', { method: 'POST', body: JSON.stringify({ title: title.trim() }) }); await loadExams(); }
    catch (err) { alert(err.message); }
  });
};
window.solve = examId => act('solve:' + examId, async () => { if (me && me.serverless) { alert('Vercel 上では実行できません。手元の管理画面から実行してください'); return; } try { await api('/kakomon/admin/exams/' + examId + '/solve', { method: 'POST' }); await loadJobs(); } catch (e) { alert(e.message); } });
// 正解データ (解答・解説 PDF) のインポート: ファイル選択 → その過去問に反映するジョブを開始
let answerTarget = null;
window.importAnswers = examId => {
  if (me && me.serverless) { alert('Vercel 上では実行できません。手元の管理画面から実行してください'); return; }
  if (pending.has('answers:' + examId)) return;
  answerTarget = examId; $('#answerPdf').value = ''; $('#answerPdf').click();
};
$('#answerPdf').onchange = () => {
  const f = $('#answerPdf').files[0]; const examId = answerTarget; answerTarget = null;
  if (!f || !examId) return;
  $('#answerErr').textContent = '';
  const e = exams.find(x => x.examId === examId);
  if (me && me.maxUploadBytes && f.size > me.maxUploadBytes) { $('#answerErr').textContent = 'このファイルは ' + mb(f.size) + ' で、上限 ' + mb(me.maxUploadBytes) + ' を超えています。'; return; }
  if (e && e.answeredCount > 0 && !confirm((e.year ?? '') + ' ' + e.title + ' には正解が ' + e.answeredCount + ' 問分登録されています。「' + f.name + '」の内容で上書きしますか？')) return;
  return act('answers:' + examId, async () => {
    const fd = new FormData(); fd.append('file', f);
    try { await api('/kakomon/admin/exams/' + examId + '/answers', { method: 'POST', body: fd }); await loadJobs(); location.hash = '#jobs'; }
    catch (err) { $('#answerErr').textContent = err.message; }
  });
};
$('#uploadForm').onsubmit = async e => {
  e.preventDefault(); $('#uploadErr').textContent = '';
  const f = $('#pdf').files[0];
  if (me && me.maxUploadBytes && f.size > me.maxUploadBytes) {
    $('#uploadErr').textContent = 'このファイルは ' + mb(f.size) + ' で、上限 ' + mb(me.maxUploadBytes) + ' を超えています。' + (me.serverless ? 'Vercel 上では送れないので、手元で npm run dev を起動した管理画面 (http://localhost:4111/kakomon/admin) からアップロードしてください。' : '.env の KAKOMON_MAX_UPLOAD_MB で上限を上げられます (Claude の PDF 入力上限は 32MB)。');
    return;
  }
  const fd = new FormData(); fd.append('file', f); fd.append('title', $('#upTitle').value); fd.append('year', $('#upYear').value); fd.append('session', $('#upSession').value);
  await act('upload', async () => {
    try { await api('/kakomon/admin/upload', { method: 'POST', body: fd }); $('#pdf').value = ''; await loadJobs(); location.hash = '#jobs'; }
    catch (err) { $('#uploadErr').textContent = err.message; }
  });
};

// ---------- 要件定義 ----------
async function loadSpecs() {
  specs = (await api('/kakomon/admin/specs')).specs;
  renderSpecs();
}
function renderSpecs() {
  $('#specList').innerHTML = specs.length ? '<table><tr><th>作成</th><th>試験名</th><th>対象の過去問</th><th>設問数</th><th>分野</th><th></th></tr>' + specs.map(s =>
    '<tr><td>' + fmt(s.createdAt) + '</td><td>' + esc(s.title) + '</td><td class="muted">' + esc(specSources(s)) + '</td><td>' + s.questionCount + '</td><td class="muted">' + s.domains.map(d => esc(d.domain) + ' ' + Math.round(d.share * 100) + '%').join(', ') + '</td>'
    + '<td><button class="secondary" onclick="viewSpec(\\'' + s.specId + '\\')">内容を見る</button></td></tr>').join('') + '</table>'
    : '<p class="muted">まだありません。過去問を登録してから「分析を実行」を押してください。</p>';
  const selected = $('#genSpec').value;
  $('#genSpec').innerHTML = specs.length ? specs.map(s => '<option value="' + s.specId + '">' + esc(s.title) + ' [' + esc(specSources(s)) + '] (' + fmt(s.createdAt) + ')</option>').join('') : '<option value="">要件定義がありません</option>';
  if (selected && specs.some(s => s.specId === selected)) $('#genSpec').value = selected;
}
window.viewSpec = async id => { const r = await fetch('/kakomon/admin/specs/' + id + '/markdown', { headers: headers() }); $('#specView').textContent = await r.text(); $('#specView').style.display = ''; };
$('#analyzeBtn').onclick = () => act('analyze', async () => {
  $('#analyzeErr').textContent = '';
  const examIds = [...document.querySelectorAll('#anExams input')].filter(i => i.checked).map(i => i.value);
  if (examIds.length === 0) { $('#analyzeErr').textContent = '分析する過去問を 1 件以上チェックしてください'; return; }
  const unanswered = examIds.map(id => exams.find(e => e.examId === id)).filter(e => e && e.answeredCount < e.questionCount);
  if (unanswered.length && !confirm('正解が未推定の過去問が含まれています (' + unanswered.map(e => e.year ?? e.title).join(', ') + ')。正解なしで分析しますか？')) return;
  try { await api('/kakomon/admin/analyze', { method: 'POST', body: JSON.stringify({ examIds, title: $('#anTitle').value || undefined, focus: $('#anFocus').value || undefined }) }); await loadJobs(); location.hash = '#jobs'; }
  catch (e) { $('#analyzeErr').textContent = e.message; }
});

// ---------- 予想問題 ----------
$('#generateBtn').onclick = () => act('generate', async () => {
  $('#generateErr').textContent = '';
  const body = { specId: $('#genSpec').value, title: $('#genTitle').value.trim(), referenceExamId: $('#genRef').value || undefined, questionCount: $('#genCount').value ? Number($('#genCount').value) : undefined, instructions: $('#genInstr').value || undefined };
  if (!body.specId || !body.title) { $('#generateErr').textContent = '要件定義とタイトルを指定してください'; return; }
  try { await api('/kakomon/admin/generate', { method: 'POST', body: JSON.stringify(body) }); await loadJobs(); location.hash = '#jobs'; }
  catch (e) { $('#generateErr').textContent = e.message; }
});
function renderDrafts() {
  const pending = jobs.filter(j => j.kind === 'generate' && j.status === 'suspended');
  const predicted = exams.filter(e => e.kind === 'predicted');
  let html = '';
  if (pending.length) html += '<h3>承認待ち</h3>' + pending.map(j => { const s = j.suspend || {}; return '<div class="card"><strong>' + esc(s.title || j.title) + '</strong> ' + tag('suspended')
    + '<div class="muted">' + s.questionCount + ' 問 / 校閲スコア ' + s.reviewScore + ' / blocker ' + s.blockerCount + ' 件 / 校閲判定: ' + (s.reviewApproved ? '合格' : '要確認') + '</div>'
    + '<div class="row" style="margin-top:6px"><button class="secondary" onclick="previewExam(\\'' + s.examId + '\\')">内容を確認 (正解つき)</button>'
    + '<button class="secondary" onclick="startEdit(\\'' + s.examId + '\\')">プロンプトで編集</button>'
    + '<button data-act="decide:' + j.id + '" onclick="decide(\\'' + j.id + '\\', true)">承認して公開</button><button class="danger" data-act="decide:' + j.id + '" onclick="decide(\\'' + j.id + '\\', false)">却下</button></div></div>'; }).join('');
  html += '<h3>予想問題</h3>' + (predicted.length ? '<table><tr><th>タイトル</th><th>設問</th><th>状態</th><th></th></tr>' + predicted.map(e =>
    '<tr><td>' + esc(e.title) + '</td><td>' + e.questionCount + '</td><td>' + tag(e.status) + '</td><td class="row">'
    + '<button class="secondary" onclick="previewExam(\\'' + e.examId + '\\')">確認</button>'
    + (e.status !== 'published' ? '<button class="secondary" onclick="startEdit(\\'' + e.examId + '\\')">編集</button>' : '')
    + '<button class="secondary" onclick="downloadExam(\\'' + e.examId + '\\',\\'questions\\')">問題DL</button>'
    + '<button class="secondary" onclick="downloadExam(\\'' + e.examId + '\\',\\'answers\\')">解答DL</button>'
    + (e.status === 'published' ? '<a class="muted" href="/kakomon/exams/' + e.examId + '/print" target="_blank">受験者向け表示</a><button class="secondary" data-act="status:' + e.examId + '" onclick="setStatus(\\'' + e.examId + '\\',\\'archived\\')">非公開にする</button>'
      : (e.status === 'archived' || e.status === 'review') ? '<button data-act="status:' + e.examId + '" onclick="setStatus(\\'' + e.examId + '\\',\\'published\\')">公開する</button>' : '')
    + '</td></tr>').join('') + '</table>' : '<p class="muted">まだありません。</p>');
  $('#draftList').innerHTML = html;
  // 編集できるのは公開前 (下書き・承認待ち・非公開) の予想問題
  const editable = predicted.filter(e => e.status !== 'published');
  const selected = $('#editExam').value;
  $('#editExam').innerHTML = editable.length ? editable.map(e => '<option value="' + e.examId + '">' + esc(e.title) + ' (' + e.questionCount + '問 / ' + esc(e.status) + ')</option>').join('') : '<option value="">編集できる予想問題がありません</option>';
  if (selected && editable.some(e => e.examId === selected)) $('#editExam').value = selected;
  syncBusy();
}
window.startEdit = examId => { $('#editExam').value = examId; $('#editBox').scrollIntoView({ behavior: 'smooth' }); $('#editPrompt').focus(); };
$('#editBtn').onclick = () => act('edit', async () => {
  $('#editErr').textContent = '';
  const examId = $('#editExam').value, prompt = $('#editPrompt').value.trim();
  if (!examId || !prompt) { $('#editErr').textContent = '予想問題と編集の指示を指定してください'; return; }
  try { await api('/kakomon/admin/exams/' + examId + '/edit', { method: 'POST', body: JSON.stringify({ prompt }) }); $('#editPrompt').value = ''; await loadJobs(); location.hash = '#jobs'; }
  catch (e) { $('#editErr').textContent = e.message; }
});
// 認証ヘッダが要るので fetch → Blob にしてダウンロードさせる
window.downloadExam = async (id, kind) => {
  try {
    const r = await fetch('/kakomon/admin/exams/' + id + '/download?kind=' + kind, { headers: headers() });
    if (!r.ok) throw new Error('ダウンロードに失敗しました (' + r.status + ')');
    const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = id + '-' + kind + '.html';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { alert(e.message); }
};
window.previewExam = async id => { const r = await fetch('/kakomon/admin/exams/' + id + '/preview', { headers: headers() }); const html = await r.text(); const w = window.open('', '_blank'); w.document.open(); w.document.write(html); w.document.close(); };
window.decide = (jobId, approved) => {
  if (pending.has('decide:' + jobId)) return;
  if (!confirm(approved ? 'この予想問題を公開します。よろしいですか？' : 'この下書きを却下します。よろしいですか？')) return;
  return act('decide:' + jobId, async () => { try { await api('/kakomon/admin/jobs/' + jobId + '/approve', { method: 'POST', body: JSON.stringify({ approved }) }); await loadJobs(); } catch (e) { alert(e.message); } });
};
window.setStatus = (examId, status) => act('status:' + examId, async () => { try { await api('/kakomon/admin/exams/' + examId + '/status', { method: 'POST', body: JSON.stringify({ status }) }); await loadExams(); renderDrafts(); } catch (e) { alert(e.message); } });

// ---------- ジョブ ----------
const KIND = { ingest: '取り込み', analyze: '傾向分析', generate: '作問', solve: '正解推定', answers: '正解インポート', edit: '編集' };
async function loadJobs() {
  jobs = (await api('/kakomon/admin/jobs')).jobs;
  $('#jobList').innerHTML = jobs.length ? '<table><tr><th>開始</th><th>種類</th><th>内容</th><th>状態</th><th>結果</th><th></th></tr>' + jobs.slice(0, 30).map(j =>
    '<tr><td class="muted">' + fmt(j.createdAt) + '</td><td>' + esc(KIND[j.kind] || j.kind) + '</td><td>' + esc(j.title) + '</td><td>' + tag(j.status) + '</td><td class="muted">' + esc(summarize(j)) + '</td>'
    + '<td>' + (j.status === 'running' ? '<button class="danger small" data-act="cancel:' + j.id + '" onclick="cancelJob(\\'' + j.id + '\\')">停止</button>' : '') + '</td></tr>').join('') + '</table>'
    : '<p class="muted">まだありません。</p>';
  renderDrafts();
}
window.cancelJob = jobId => {
  if (pending.has('cancel:' + jobId)) return;
  const j = jobs.find(x => x.id === jobId);
  if (!confirm('「' + (j ? j.title : jobId) + '」を停止します。途中までの結果は保存されません (作問は途中までの下書きが残ります)。よろしいですか？')) return;
  return act('cancel:' + jobId, async () => { try { await api('/kakomon/admin/jobs/' + jobId + '/cancel', { method: 'POST' }); } catch (e) { alert(e.message); } await loadJobs(); });
};
const parseTs = s => { if (!s) return NaN; const t = String(s).trim(); return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z'); };
const elapsedText = ms => { if (!(ms >= 0)) return ''; const s = Math.floor(ms / 1000); return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'; };
function summarize(j) {
  if (j.status === 'failed') return j.error || '失敗';
  if (j.status === 'cancelled') return j.error || '停止しました';
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
  if (j.kind === 'answers' && r.applied != null) return r.applied + ' 問に反映 (正解あり ' + r.answeredCount + '/' + r.questionCount + ')'
    + (r.changed?.length ? ' / 正解が変わった設問: ' + r.changed.map(c => '問' + c.number + ' ' + (c.from || '未設定') + '→' + c.to).join(', ') : '')
    + (r.missing?.length ? ' / PDF に無かった設問: 問' + r.missing.join(', 問') : '')
    + (r.notes?.length ? ' / 注意: ' + r.notes.join(' / ') : '');
  if (j.kind === 'edit' && r.summary) return r.summary + (r.changedNumbers?.length ? ' (変更: 問' + r.changedNumbers.join(', ') + ')' : '') + (r.removedCount ? ' / ' + r.removedCount + ' 問削除' : '') + (r.notes?.length ? ' / 注意: ' + r.notes.join(' / ') : '');
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
