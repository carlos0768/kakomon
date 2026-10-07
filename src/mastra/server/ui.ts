/**
 * 受験者向けの最小 UI (依存なしの 1 ページ)。
 * 本番では Next.js 等に置き換える前提で、API の使い方を示す参照実装として置いている。
 */
export function userUiHtml(): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>予想問題</title>
<style>
  :root { --fg:#1a1a1a; --bg:#fafafa; --card:#fff; --line:#ddd; --accent:#2b5bd7; --ok:#1b8a3c; --ng:#c0392b; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eee; --bg:#121212; --card:#1e1e1e; --line:#333; --accent:#7aa2ff; } }
  body { margin:0; font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; color:var(--fg); background:var(--bg); line-height:1.6; }
  main { max-width: 820px; margin: 0 auto; padding: 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:16px; margin:12px 0; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:8px 14px; cursor:pointer; font-size:14px; }
  button.secondary { background:transparent; color:var(--accent); border:1px solid var(--accent); }
  input { padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); }
  .q { border-top:1px solid var(--line); padding:12px 0; }
  .q .stem { white-space:pre-wrap; }
  .q .passage { border-left:3px solid var(--line); padding-left:10px; margin:6px 0; white-space:pre-wrap; opacity:.9; }
  .choice { display:block; margin:4px 0; cursor:pointer; }
  .ok { color:var(--ok); font-weight:600; } .ng { color:var(--ng); font-weight:600; }
  .fb { background:rgba(127,127,127,.08); border-radius:6px; padding:8px 10px; margin-top:6px; font-size:14px; }
  table { border-collapse:collapse; width:100%; font-size:14px; } td,th { border-bottom:1px solid var(--line); padding:4px 6px; text-align:left; }
  .muted { opacity:.7; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>予想問題</h1>
  <div class="card">
    <label>受験者ID <input id="userId" placeholder="例: taro" /></label>
    <button id="loadBtn">問題一覧を読み込む</button>
    <button id="histBtn" class="secondary">受験履歴 / 弱点分析</button>
  </div>
  <div id="list"></div>
  <div id="exam"></div>
  <div id="result"></div>
  <div id="history"></div>
</main>
<script>
const $ = s => document.querySelector(s);
const api = async (path, opts) => { const r = await fetch(path, { headers: {'content-type':'application/json'}, ...opts }); const j = await r.json(); if (!r.ok) throw new Error(j.error ? (typeof j.error === 'string' ? j.error : JSON.stringify(j.error)) : r.statusText); return j; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const uid = () => { const v = $('#userId').value.trim(); if (!v) throw new Error('受験者IDを入力してください'); localStorage.setItem('kakomon.userId', v); return v; };
try { $('#userId').value = localStorage.getItem('kakomon.userId') || ''; } catch {}

let current = null; // { attemptId, exam }

$('#loadBtn').onclick = async () => {
  try {
    uid();
    const { exams } = await api('/kakomon/exams');
    $('#list').innerHTML = '<div class="card"><h2>公開中の予想問題</h2>' + (exams.length ? exams.map(e =>
      '<div class="q"><strong>' + esc(e.title) + '</strong> <span class="muted">' + e.questionCount + '問' + (e.timeLimitMinutes ? ' / ' + e.timeLimitMinutes + '分' : '') + '</span> '
      + '<button data-id="' + e.examId + '">受験する</button> <a class="muted" href="/kakomon/exams/' + e.examId + '/print" target="_blank">印刷用</a></div>').join('') : '<p class="muted">公開中の問題はありません (管理者が生成・承認すると表示されます)</p>') + '</div>';
    document.querySelectorAll('#list button[data-id]').forEach(b => b.onclick = () => startExam(b.dataset.id));
  } catch (e) { alert(e.message); }
};

async function startExam(examId) {
  try {
    const userId = uid();
    const exam = await api('/kakomon/exams/' + examId);
    const { attemptId } = await api('/kakomon/attempts', { method:'POST', body: JSON.stringify({ userId, examId }) });
    current = { attemptId, exam };
    $('#result').innerHTML = ''; $('#history').innerHTML = '';
    $('#exam').innerHTML = '<div class="card"><h2>' + esc(exam.title) + '</h2>'
      + (exam.instructions.length ? '<ol class="muted">' + exam.instructions.map(i => '<li>' + esc(i) + '</li>').join('') + '</ol>' : '')
      + exam.questions.map(q => '<div class="q" id="q' + q.number + '"><div><strong>問' + q.number + '</strong></div>'
        + (q.passage ? '<div class="passage">' + esc(q.passage) + '</div>' : '')
        + '<div class="stem">' + esc(q.stem) + '</div>'
        + q.choices.map(c => '<label class="choice"><input type="radio" name="q' + q.number + '" value="' + esc(c.label) + '"> ' + esc(c.label) + '. ' + esc(c.text) + '</label>').join('')
        + '</div>').join('')
      + '<p><button id="submitBtn">解答を提出して添削を受ける</button></p></div>';
    $('#submitBtn').onclick = submit;
    window.scrollTo({ top: $('#exam').offsetTop, behavior: 'smooth' });
  } catch (e) { alert(e.message); }
}

async function submit() {
  if (!current) return;
  const answers = current.exam.questions.map(q => { const sel = document.querySelector('input[name="q' + q.number + '"]:checked'); return { questionNumber: q.number, selectedLabel: sel ? sel.value : null }; });
  const unanswered = answers.filter(a => a.selectedLabel == null).length;
  if (unanswered && !confirm('未回答が ' + unanswered + ' 問あります。提出しますか？')) return;
  $('#submitBtn').disabled = true; $('#submitBtn').textContent = '添削中... (数十秒かかります)';
  try {
    const r = await api('/kakomon/attempts/' + current.attemptId + '/submit', { method:'POST', body: JSON.stringify({ answers }) });
    renderResult(r);
  } catch (e) { alert(e.message); $('#submitBtn').disabled = false; $('#submitBtn').textContent = '解答を提出して添削を受ける'; }
}

function renderResult(r) {
  const byNum = Object.fromEntries((current?.exam.questions || []).map(q => [q.number, q]));
  $('#exam').innerHTML = '';
  $('#result').innerHTML = '<div class="card"><h2>添削結果: ' + r.score + ' / ' + r.total + ' (' + r.percentage + '%)</h2><p>' + esc(r.overview) + '</p>'
    + r.feedback.map(f => { const q = byNum[f.questionNumber]; return '<div class="q"><div><strong>問' + f.questionNumber + '</strong> <span class="' + (f.correct ? 'ok' : 'ng') + '">' + (f.correct ? '正解' : '不正解') + '</span> <span class="muted">' + esc(f.domain) + ' / ' + esc(f.topic) + '</span></div>'
      + (q ? '<div class="stem muted">' + esc(q.stem) + '</div>' : '')
      + '<div class="fb"><div>あなたの解答: <strong>' + esc(f.selectedLabel ?? '未回答') + '</strong> ／ 正解: <strong>' + esc(f.correctLabel) + '</strong></div>'
      + '<div><strong>' + (f.correct ? '確認' : 'なぜ誤りか') + ':</strong> ' + esc(f.whyYourChoice) + '</div>'
      + '<div><strong>正解の根拠:</strong> ' + esc(f.whyCorrect) + '</div>'
      + (f.tip ? '<div><strong>ポイント:</strong> ' + esc(f.tip) + '</div>' : '') + '</div></div>'; }).join('')
    + '<p><button id="histBtn2" class="secondary">受験履歴 / 弱点分析を見る</button></p></div>';
  $('#histBtn2').onclick = showHistory;
  window.scrollTo({ top: $('#result').offsetTop, behavior: 'smooth' });
}

async function showHistory() {
  try {
    const userId = uid();
    const h = await api('/kakomon/users/' + userId + '/attempts');
    const rows = h.attempts.filter(a => a.status === 'submitted');
    $('#history').innerHTML = '<div class="card"><h2>受験履歴</h2>' + (rows.length ? '<table><tr><th>日時</th><th>得点</th></tr>' + rows.map(a => '<tr><td>' + esc(a.submittedAt) + '</td><td>' + a.score + '/' + a.total + ' (' + a.percentage + '%)</td></tr>').join('') + '</table>' : '<p class="muted">まだ受験していません</p>')
      + '<p>' + (h.canAnalyzeWeakness ? '<button id="weakBtn">弱点分析を実行</button>' : '<span class="muted">弱点分析は ' + h.minAttemptsForWeakness + ' 回以上受験すると利用できます (現在 ' + rows.length + ' 回)</span>') + '</p><div id="weak"></div></div>';
    if (h.canAnalyzeWeakness) $('#weakBtn').onclick = async () => {
      $('#weakBtn').disabled = true; $('#weakBtn').textContent = '分析中...';
      try { renderWeakness(await api('/kakomon/users/' + userId + '/weakness', { method:'POST' })); } catch (e) { alert(e.message); } finally { $('#weakBtn').disabled = false; $('#weakBtn').textContent = '弱点分析を実行'; }
    };
    window.scrollTo({ top: $('#history').offsetTop, behavior: 'smooth' });
  } catch (e) { alert(e.message); }
}
$('#histBtn').onclick = showHistory;

function renderWeakness(w) {
  const pct = x => Math.round(x * 100) + '%';
  $('#weak').innerHTML = '<h3>弱点分析 (' + w.attemptCount + '回分, 全体正答率 ' + pct(w.overallAccuracy) + ')</h3>'
    + (w.coaching ? '<p>' + esc(w.coaching.summary) + '</p><h4>考えられる原因</h4><ul>' + w.coaching.rootCauses.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>'
      + '<h4>学習計画</h4><ol>' + w.coaching.studyPlan.map(p => '<li><strong>[' + p.priority + '] ' + esc(p.topic) + '</strong>: ' + esc(p.action) + '</li>').join('') + '</ol>' : '')
    + '<h4>弱いトピック (出題比率 × 誤答率で優先度付け)</h4><table><tr><th>分野</th><th>トピック</th><th>正答率</th><th>出題数</th><th>優先度</th></tr>'
    + w.weakTopics.map(t => '<tr><td>' + esc(t.domain) + '</td><td>' + esc(t.topic) + '</td><td class="ng">' + pct(t.accuracy) + '</td><td>' + t.attempted + '</td><td>' + t.priority + '</td></tr>').join('') + '</table>'
    + '<h4>設問の型ごとの正答率</h4><table>' + w.byQuestionType.map(t => '<tr><td>' + esc(t.questionType) + '</td><td>' + pct(t.accuracy) + '</td><td class="muted">' + t.attempted + '問</td></tr>').join('') + '</table>';
}
</script>
</body>
</html>`
}
