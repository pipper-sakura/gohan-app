'use strict';

/**
 * ごはん台帳 — フロント
 *
 * GASのURLと合言葉はこのファイルに書かない。各自が設定画面で入れ、
 * その端末の localStorage にだけ残る。リポジトリには秘密情報を置かない。
 */

const APP_VERSION = '2026-08-30-5';
const CFG_KEY = 'gohan.config';
const SLOTS = ['朝', '昼', '夜'];
const WEEK_LABEL = ['日', '月', '火', '水', '木', '金', '土'];

let cfg = loadCfg();
const state = { tab: 'today', data: null, shopTab: 'coop' };

/* ================================================================== */
/* 起動                                                                */
/* ================================================================== */

document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('#tabbar .tab').forEach(function (b) {
    b.addEventListener('click', function () { go(b.dataset.tab); });
  });
  document.getElementById('whoami').addEventListener('click', pickMe);
  document.getElementById('voice-btn').addEventListener('click', openVoice);
  document.querySelectorAll('#sheet [data-close]').forEach(function (el) {
    el.addEventListener('click', closeSheet);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  paintMe();
  if (!cfg.url || !cfg.secret) {
    go('settings');
    toast('まず設定画面でURLと合言葉を入れてください');
  } else {
    reload();
  }
});

function go(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabbar .tab').forEach(function (b) {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  render();
}

/* ================================================================== */
/* 通信                                                                */
/* ================================================================== */

/**
 * GASのWeb Appを呼ぶ。
 * Content-Type を text/plain にしているのは、プリフライトを起こさないため。
 * 送信先は設定画面で入れた自分のGASのURLだけ。
 */
async function api(action, payload) {
  if (!cfg.url || !cfg.secret) throw new Error('URLと合言葉が未設定です');
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: cfg.secret, action: action, payload: payload || {} }),
  });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || '不明なエラー');
  return out.data;
}

async function reload() {
  try {
    state.data = await api('load', {});
    cacheData(state.data);
    render();
  } catch (err) {
    const cached = readCache();
    if (cached) {
      state.data = cached;
      render();
      toast('つながらないので前回の内容を表示しています');
    } else {
      view('<div class="alert">読み込めませんでした：' + esc(err.message) + '</div>');
    }
  }
}

async function save(sheet, rows) {
  await api('upsert', { sheet: sheet, rows: rows });
  await reload();
}

/* オフラインでも前回分は見られるようにしておく */
function cacheData(d) {
  try { localStorage.setItem('gohan.cache', JSON.stringify(d)); } catch (e) {}
}
function readCache() {
  try { return JSON.parse(localStorage.getItem('gohan.cache') || 'null'); } catch (e) { return null; }
}

/* ================================================================== */
/* 画面の振り分け                                                       */
/* ================================================================== */

function render() {
  if (state.tab === 'settings') return renderSettings();
  if (!state.data) return view('<div class="loading">読み込み中…</div>');
  if (state.tab === 'today') return renderToday();
  if (state.tab === 'plan') return renderPlan();
  if (state.tab === 'shopping') return renderShopping();
  if (state.tab === 'baby') return renderBaby();
}

function view(html) { document.getElementById('view').innerHTML = html; }

/* ================================================================== */
/* 今日                                                                */
/* ================================================================== */

function renderToday() {
  const d = state.data;
  const me = myMember();
  const today = ymd(new Date());
  let h = '';

  /* --- 今日やること --- */
  const todo = [];
  const dow = new Date().getDay(); // 0=日

  const expiring = d.stock.filter(function (s) {
    return num(s['残数']) > 0 && s['期限'] && String(s['期限']).slice(0, 10) <= today;
  });
  if (expiring.length) {
    todo.push({
      warn: true,
      text: '今日までに食べたいもの：' + expiring.map(function (s) { return s['名称']; }).join('、'),
    });
  }

  const thaw = d.stock.filter(function (s) {
    return s['保存場所'] === '冷凍' && s['種別'] === '作り置き'
      && String(s['期限']).slice(0, 10) === addDays(today, 1);
  });
  if (thaw.length) {
    todo.push({
      warn: false,
      text: '明日の昼の分を冷凍庫から冷蔵庫へ移す：' + thaw.map(function (s) { return s['名称']; }).join('、'),
    });
  }

  if (dow === 4) todo.push({ warn: false, text: '今日はコープが届く日です。届いたら「買い物」タブで到着にしてください' });
  if (dow === 5) todo.push({ warn: true, text: 'コープの注文は今日の19時まで' });

  if (todo.length) {
    h += '<h2 class="section">今日やること</h2>';
    todo.forEach(function (t) {
      h += '<div class="alert' + (t.warn ? '' : ' calm') + '">' + esc(t.text) + '</div>';
    });
  }

  /* --- あるもの：どうぞ --- */
  const mine = d.stock.filter(function (s) { return num(s['残数']) > 0; });
  const free = mine.filter(function (s) {
    return String(s['用途'] || '自由').indexOf('自由') === 0 && ngMark(me, s) !== '×';
  });
  const readyNow = free.filter(function (s) { return s['調理要否'] === 'そのまま食べられる'; });
  const needCook = free.filter(function (s) { return s['調理要否'] !== 'そのまま食べられる'; });

  h += '<h2 class="section">あるもの</h2>';
  h += '<p class="hint">「どうぞ」は献立に使う予定がないので、遠慮なく食べて大丈夫です。</p>';

  if (!free.length) {
    h += '<div class="empty">いま自由に使えるものが登録されていません。</div>';
  } else {
    if (readyNow.length) {
      h += '<p class="hint" style="margin-top:14px">そのまま食べられる</p>';
      readyNow.forEach(function (s) { h += stockCard(s, me); });
    }
    if (needCook.length) {
      h += '<p class="hint" style="margin-top:14px">温めるか、作れば食べられる</p>';
      needCook.forEach(function (s) { h += stockCard(s, me); });
    }
  }

  /* --- 予定あり --- */
  const reserved = mine.filter(function (s) { return s['用途'] === '予定あり'; });
  if (reserved.length) {
    h += '<h2 class="section">予定あり</h2>';
    h += '<p class="hint">献立で使う予定のものです。食べたいときは「これ食べたい」を押すと、差し替えの相談として残ります。</p>';
    reserved.forEach(function (s) { h += stockCard(s, me, true); });
  }

  /* --- 手伝えるとき --- */
  h += helpSection(me);

  /* --- 赤ちゃん --- */
  h += babySummary();

  view(h);

  document.querySelectorAll('[data-eat]').forEach(function (b) {
    b.addEventListener('click', function () { eatStock(b.dataset.eat); });
  });
  document.querySelectorAll('[data-want]').forEach(function (b) {
    b.addEventListener('click', function () { wantStock(b.dataset.want); });
  });
  document.querySelectorAll('[data-take]').forEach(function (b) {
    b.addEventListener('click', function () { takeTask(b.dataset.take); });
  });
}

function stockCard(s, me, isReserved) {
  const mark = ngMark(me, s);
  const bits = [];
  if (s['保存場所']) bits.push(s['保存場所']);
  if (s['期限']) bits.push(shortDate(s['期限']) + 'まで');
  if (num(s['残数']) > 1) bits.push('残り' + num(s['残数']));
  if (isReserved && s['plan_id']) {
    const p = byId(state.data.plan, s['plan_id']);
    if (p) bits.push(shortDate(p['日付']) + 'の' + p['食事区分']);
  }
  if (String(s['用途']).indexOf('献立でも使用') > -1) bits.push('献立でも使う');

  const badge = isReserved
    ? '<span class="badge reserved">予定あり</span>'
    : '<span class="badge free">どうぞ</span>';

  return '<div class="card"><div class="card-row"><div>'
    + '<h3>' + esc(s['名称']) + (mark === '△' ? ' <span class="badge plain">少なめに</span>' : '') + '</h3>'
    + (bits.length ? '<div class="meta">' + esc(bits.join('・')) + '</div>' : '')
    + '</div>' + badge + '</div>'
    + '<div class="btn-row">'
    + (isReserved
        ? '<button class="btn small" data-want="' + s['id'] + '">これ食べたい</button>'
        : '<button class="btn small" data-eat="' + s['id'] + '">食べた</button>')
    + '</div></div>';
}

/** 手伝えるとき：①仕込みを手伝う ②今すぐ作る ③野菜の使い切り */
function helpSection(me) {
  const d = state.data;
  let h = '';

  const open = d.tasks.filter(function (t) {
    return t['状態'] !== '完了' && (t['担当'] === 'おまかせ' || t['担当'] === (me && me.id));
  });

  const freeFoods = {};
  d.stock.forEach(function (s) {
    if (num(s['残数']) > 0 && String(s['用途'] || '自由').indexOf('自由') === 0) freeFoods[s['名称']] = true;
  });

  const quick = d.menus.filter(function (m) {
    const mats = splitList(m['材料']);
    if (!mats.length) return false;
    if (num(m['調理時間']) > 15) return false;
    return mats.every(function (f) { return freeFoods[f]; });
  }).slice(0, 4);

  // 期限が近い野菜は、レコルトのポタージュにできる
  const soon = addDays(ymd(new Date()), 3);
  const veg = d.stock.filter(function (s) {
    if (num(s['残数']) <= 0) return false;
    if (String(s['用途'] || '自由').indexOf('自由') !== 0) return false;
    const f = byKey(d.foods, '食材名', s['名称']);
    if (!f || f['栄養素分類'] !== 'ビタミン・ミネラル') return false;
    return s['期限'] && String(s['期限']).slice(0, 10) <= soon;
  });

  if (!open.length && !quick.length && !veg.length) return h;

  h += '<h2 class="section">手伝えるとき</h2>';

  if (open.length) {
    h += '<p class="hint">夫が「おまかせ」にした仕込みです。取ると担当になります。</p>';
    open.forEach(function (t) {
      h += '<div class="card"><div class="card-row"><div>'
        + '<h3>' + esc(t['内容']) + '</h3>'
        + '<div class="meta">' + esc([t['予定日'] ? shortDate(t['予定日']) : '', t['所要時間'] ? t['所要時間'] + '分' : ''].filter(Boolean).join('・')) + '</div>'
        + '</div><span class="badge plain">' + esc(t['担当']) + '</span></div>'
        + '<div class="btn-row"><button class="btn small primary" data-take="' + t['id'] + '">これやる</button></div>'
        + '</div>';
    });
  }

  if (quick.length) {
    h += '<p class="hint" style="margin-top:14px">自由な食材だけで作れる、短時間のもの</p>';
    quick.forEach(function (m) {
      h += '<div class="card"><h3>' + esc(m['メニュー名']) + '</h3>'
        + '<div class="meta">' + esc(m['調理時間'] ? m['調理時間'] + '分' : '') + esc(m['調理器具'] ? '・' + m['調理器具'] : '') + '</div>'
        + (m['手順メモ'] ? '<div class="meta">' + esc(m['手順メモ']) + '</div>' : '')
        + '</div>';
    });
  }

  if (veg.length) {
    h += '<p class="hint" style="margin-top:14px">使い切り</p>';
    h += '<div class="card"><h3>' + esc(veg.map(function (s) { return s['名称']; }).join('・')) + ' をポタージュに</h3>'
      + '<div class="meta">レコルト自動調理ポットLarge。材料を入れて「たべるスープ」→STARTだけです。</div>'
      + '<div class="btn-row"><a class="btn small" href="https://recolte-jp.com/recipe/" target="_blank" rel="noopener">レシピを見る</a></div>'
      + '</div>';
  }

  return h;
}

function babySummary() {
  const baby = state.data.members.find(function (m) { return m['区分'] === '乳児'; });
  if (!baby || !baby['誕生日']) return '';
  const a = ageOf(baby['誕生日']);
  const bf = state.data.stock.filter(function (s) { return s['種別'] === '市販BF' && num(s['残数']) > 0; });
  const logs = state.data.baby_log.filter(function (b) { return String(b['日付']).slice(0, 10) === ymd(new Date()); });

  const all = state.data.baby_foods || [];
  const tried = all.filter(function (f) { return f['初めて食べた日']; }).length;

  return '<h2 class="section">赤ちゃんの今日</h2>'
    + '<div class="card"><h3>生後' + a.months + 'か月' + a.days + '日' + (a.stage ? '・' + a.stage : '') + '</h3>'
    + '<div class="meta">' + (logs.length ? '今日の記録 ' + logs.length + '件' : 'まだ記録がありません')
    + (all.length ? '・食べた食材 ' + tried + '/' + all.length : '') + '</div>'
    + (bf.length ? '<div class="meta">市販ベビーフードの残り：' + esc(bf.map(function (s) { return s['名称'] + '×' + num(s['残数']); }).join('、')) + '</div>' : '')
    + '</div>';
}

async function eatStock(id) {
  const s = byId(state.data.stock, id);
  if (!s) return;
  s['残数'] = Math.max(0, num(s['残数']) - 1);
  await save('stock', [s]);
  toast('食べた記録をつけました');
}

async function wantStock(id) {
  const s = byId(state.data.stock, id);
  if (!s) return;
  await save('voices', [{
    投稿日時: new Date().toISOString(),
    投稿者: (myMember() || {}).名前 || '',
    種別: 'こうしてほしい',
    本文: '「' + s['名称'] + '」を食べたいです（献立の差し替え相談）',
    関連画面: '今日',
    状態: '未読',
  }]);
  toast('差し替えの相談として残しました');
}

async function takeTask(id) {
  const t = byId(state.data.tasks, id);
  const me = myMember();
  if (!t || !me) return;
  t['担当'] = me.id;
  await save('tasks', [t]);
  toast('担当になりました');
}

/* ================================================================== */
/* 計画                                                                */
/* ================================================================== */

/* 月の最終日 */
function monthEnd(month) {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return ymd(new Date(y, m, 0));
}

/* その月にかかる週（土曜始まり）を、日付7つの配列の配列で返す */
function weeksCovering(first, last) {
  const weeks = [];
  let s = weekStart(new Date(first + 'T00:00:00'));
  while (s <= last) {
    const days = [];
    for (let i = 0; i < 7; i++) days.push(addDays(s, i));
    weeks.push(days);
    s = addDays(s, 7);
  }
  return weeks;
}

function renderPlan() {
  const month = state.month || ymd(new Date()).slice(0, 7);
  state.month = month;

  const first = month + '-01';
  const last = monthEnd(month);
  const weeks = weeksCovering(first, last);
  const today = ymd(new Date());

  let h = '<div class="seg" style="margin-bottom:12px">'
    + '<button id="prev-month" aria-label="前の月">←</button>'
    + '<button aria-pressed="true">' + Number(month.slice(0, 4)) + '年' + Number(month.slice(5, 7)) + '月</button>'
    + '<button id="next-month" aria-label="次の月">→</button>'
    + '</div>';

  h += '<div class="btn-row" style="margin-top:0">'
    + '<button class="btn primary" id="suggest-month">1ヶ月分を自動で提案</button>'
    + '<button class="btn" id="clear-month">この月を空にする</button>'
    + '</div>';
  h += '<p class="hint">まず自動で埋めて、気になるマスだけ押して差し替えてください。'
    + '昼は平日だけ、朝と夜は毎日です。'
    + '苦手な食材（×）を含むものと、前にNGにしたものは出てきません。</p>';

  weeks.forEach(function (days) {
    const isThisWeek = days[0] <= today && today <= days[6];
    h += '<h2 class="section">' + shortDate(days[0]) + '〜' + shortDate(days[6])
      + (isThisWeek ? ' <span class="badge reserved">今週</span>' : '') + '</h2>';
    h += weekTable(days);
    h += '<div class="btn-row">'
      + '<button class="btn' + (isThisWeek ? ' primary' : '') + '" data-apply="' + days[0] + '|' + days[6] + '">この週を在庫に反映</button>'
      + '<button class="btn" data-shop="' + days[0] + '|' + days[6] + '">この週の買い物リスト</button>'
      + '</div>';
    h += lunchSheet(days);
  });

  h += '<p class="hint">「この週を在庫に反映」を押すと、その週の献立で使う主役の食材（肉・魚・卵・豆腐など）が'
    + '「予定あり」になり、それ以外は「どうぞ」のまま残ります。野菜を少し使っても計画は崩れないためです。'
    + '<br>在庫の予約は週ごとです。1ヶ月分をまとめて予約すると、家族が使えるものが無くなってしまうためです。</p>';

  view(h);
  bindPlanEvents(weeks);
}

/* 1週間分の表。列幅を決めておき、画面幅に収める */
function weekTable(days) {
  const d = state.data;
  const today = ymd(new Date());

  let h = '<table class="grid">'
    + '<colgroup><col class="c-date"><col class="c-asa"><col><col></colgroup>'
    + '<thead><tr><th></th>';
  SLOTS.forEach(function (s) { h += '<th>' + s + '</th>'; });
  h += '</tr></thead><tbody>';

  days.forEach(function (day) {
    const dow = new Date(day + 'T00:00:00').getDay();
    const weekend = (dow === 0 || dow === 6);
    h += '<tr' + (day === today ? ' class="today"' : '') + '>'
      + '<th>' + shortDate(day) + '<br>(' + WEEK_LABEL[dow] + ')</th>';

    SLOTS.forEach(function (slot) {
      const rows = d.plan.filter(function (p) {
        return String(p['日付']).slice(0, 10) === day && p['食事区分'] === slot && p['状態'] !== '変更';
      });
      // 土日の昼は普段作らない。ただし何か入っているときは隠さず出す。
      if (slot === '昼' && weekend && !rows.length) {
        h += '<td><span class="cell na">—</span></td>';
        return;
      }
      const label = rows.length
        ? rows.map(function (p) { return esc(menuName(p['menu_id'])); }).join('<br>')
        : '＋';
      h += '<td><button class="cell' + (rows.length ? '' : ' empty-cell') + '" data-cell="'
        + day + '|' + slot + '">' + label + '</button></td>';
    });
    h += '</tr>';
  });
  return h + '</tbody></table>';
}

/* その週の平日昼5食を、オーブンでまとめて作るための一覧 */
function lunchSheet(days) {
  const d = state.data;
  const lunches = [];
  days.forEach(function (day) {
    const dow = new Date(day + 'T00:00:00').getDay();
    if (dow === 0 || dow === 6) return;
    d.plan.forEach(function (p) {
      if (String(p['日付']).slice(0, 10) === day && p['食事区分'] === '昼' && p['状態'] !== '変更') lunches.push(p);
    });
  });
  if (!lunches.length) return '';

  let h = '<p class="hint">この週の昼は、週末に1食ずつ耐熱ガラス容器に入れて200℃。'
    + '月・火はパーシャル、水〜金は冷凍にします。</p>';
  lunches.forEach(function (p, i) {
    const m = byId(d.menus, p['menu_id']) || {};
    h += '<div class="card"><div class="card-row"><div>'
      + '<h3>' + shortDate(p['日付']) + '　' + esc(m['メニュー名'] || '') + '</h3>'
      + '<div class="meta">' + esc(splitList(m['材料']).join('・')) + '</div>'
      + '</div><span class="badge ' + (i < 2 ? 'plain' : 'reserved') + '">' + (i < 2 ? 'パーシャル' : '冷凍') + '</span>'
      + '</div></div>';
  });

  const groups = {};
  lunches.forEach(function (p) {
    const m = byId(d.menus, p['menu_id']) || {};
    if (m['共通グループ']) (groups[m['共通グループ']] = groups[m['共通グループ']] || []).push(m['メニュー名']);
  });
  Object.keys(groups).forEach(function (g) {
    if (groups[g].length > 1) {
      h += '<div class="note">' + esc(groups[g].join('と')) + ' は同じ' + esc(g) + 'を使えます。まとめて作ると楽です。</div>';
    }
  });

  h += '<div class="btn-row"><button class="btn" data-cook="' + days[0] + '|' + days[6] + '">作ったので在庫に入れる</button></div>';
  return h;
}

function bindPlanEvents(weeks) {
  const month = state.month;
  const first = month + '-01';
  const last = monthEnd(month);
  const from = weeks[0][0];
  const to = weeks[weeks.length - 1][6];

  document.getElementById('prev-month').addEventListener('click', function () {
    state.month = addMonths(first, -1).slice(0, 7);
    render();
  });
  document.getElementById('next-month').addEventListener('click', function () {
    state.month = addMonths(first, 1).slice(0, 7);
    render();
  });

  const sm = document.getElementById('suggest-month');
  sm.addEventListener('click', async function () {
    sm.disabled = true;
    toast('1ヶ月分の献立を組んでいます…');
    try {
      const r = await api('suggestWeek', { from: from, to: to });
      await reload();
      toast(r['入れた件数'] + '件を入れました。気になるマスを押すと差し替えられます');
    } catch (err) {
      toast('提案できませんでした：' + err.message);
    } finally {
      sm.disabled = false;
    }
  });

  document.getElementById('clear-month').addEventListener('click', async function () {
    if (!confirm(Number(month.slice(5, 7)) + '月の献立をすべて消します。よろしいですか？')) return;
    await api('clearWeek', { from: from, to: to });
    await reload();
    toast('空にしました');
  });

  document.querySelectorAll('[data-cell]').forEach(function (b) {
    b.addEventListener('click', function () {
      const parts = b.dataset.cell.split('|');
      pickMenu(parts[0], parts[1]);
    });
  });
  document.querySelectorAll('[data-apply]').forEach(function (b) {
    b.addEventListener('click', async function () {
      const w = b.dataset.apply.split('|');
      await api('applyPlan', { from: w[0], to: w[1] });
      await reload();
      toast('この週の「どうぞ／予定あり」を更新しました');
    });
  });
  document.querySelectorAll('[data-shop]').forEach(function (b) {
    b.addEventListener('click', async function () {
      const w = b.dataset.shop.split('|');
      await api('buildShopping', { from: w[0], to: w[1] });
      await reload();
      state.shopTab = 'list';
      go('shopping');
      toast('買い物リストを作りました');
    });
  });
  document.querySelectorAll('[data-cook]').forEach(function (b) {
    b.addEventListener('click', function () {
      const w = b.dataset.cook.split('|');
      const lunches = state.data.plan.filter(function (p) {
        const day = String(p['日付']).slice(0, 10);
        const dow = new Date(day + 'T00:00:00').getDay();
        return day >= w[0] && day <= w[1] && p['食事区分'] === '昼' && dow !== 0 && dow !== 6 && p['状態'] !== '変更';
      }).sort(function (a, b2) { return String(a['日付']).localeCompare(String(b2['日付'])); });
      cookLunches(lunches);
    });
  });
}

function pickMenu(day, slot) {
  const d = state.data;
  const dow = new Date(day + 'T00:00:00').getDay();

  // 昼は1食＝耐熱容器1つ＝1品なので差し替え。朝も1品。
  // 夜は主菜・副菜・汁物を組み合わせるので追加。
  const replaceMode = (slot !== '夜');

  const list = d.menus.filter(function (m) {
    if (slot === '昼' && m['時間帯'] === '夜') return false; // 夜だけのものは昼に出さない
    if (slot === '朝' && m['時間帯'] === '昼') return false;
    return true;
  });

  const existing = d.plan.filter(function (p) {
    return String(p['日付']).slice(0, 10) === day && p['食事区分'] === slot && p['状態'] !== '変更';
  });

  let h = '';
  if (existing.length) {
    h += '<p class="hint">いま入っているもの</p>';
    existing.forEach(function (p) {
      h += '<button class="pick" data-del="' + p['id'] + '">' + esc(menuName(p['menu_id']))
        + '<div class="meta">押すと外します</div></button>';
    });
  }

  h += '<p class="hint" style="margin-top:14px">'
    + (replaceMode
        ? (existing.length ? '押すと差し替えます' : '選んでください')
        : '追加する')
    + '</p>';

  list.forEach(function (m) {
    h += '<button class="pick" data-add="' + m['id'] + '">' + esc(m['メニュー名'])
      + '<div class="meta">' + esc([m['区分'], m['調理器具'], m['調理時間'] ? m['調理時間'] + '分' : ''].filter(Boolean).join('・')) + '</div></button>';
  });

  openSheet(shortDate(day) + '(' + WEEK_LABEL[dow] + ') の' + slot, h);

  document.querySelectorAll('[data-add]').forEach(function (b2) {
    b2.addEventListener('click', async function () {
      closeSheet();
      // 差し替えのときは、先に入っているものを外す
      if (replaceMode && existing.length) {
        await api('remove', { sheet: 'plan', ids: existing.map(function (p) { return p['id']; }) });
      }
      await save('plan', [{ 日付: day, 食事区分: slot, member_id: '', menu_id: b2.dataset.add, 状態: '予定' }]);
      toast(replaceMode && existing.length ? '差し替えました' : '入れました');
    });
  });
  document.querySelectorAll('[data-del]').forEach(function (b2) {
    b2.addEventListener('click', async function () {
      closeSheet();
      await api('remove', { sheet: 'plan', ids: [b2.dataset.del] });
      await reload();
      toast('外しました');
    });
  });
}

async function cookLunches(lunches) {
  const today = ymd(new Date());
  const rows = lunches.map(function (p, i) {
    const m = byId(state.data.menus, p['menu_id']) || {};
    return {
      名称: m['メニュー名'] || '',
      種別: '作り置き',
      作った日: today,
      残数: 1,
      保存場所: i < 2 ? 'パーシャル' : '冷凍',
      期限: p['日付'],
      用途: '予定あり',
      plan_id: p['id'],
      調理要否: '要調理',
      取り置き先: p['member_id'] || '',
    };
  });
  await save('stock', rows);
  toast(rows.length + '食を在庫に入れました');
}

/* ================================================================== */
/* 買い物                                                              */
/* ================================================================== */

function renderShopping() {
  // 食費は家計の話なので、ライトユーザー（お義母さん）の画面には出さない
  const canSeeMoney = (myMember() || {})['区分'] !== 'ライト';
  if (!canSeeMoney && state.shopTab === 'money') state.shopTab = 'list';

  let h = '<div class="seg" style="margin-bottom:16px">'
    + segBtn('coop', 'コープ注文') + segBtn('list', '買い物リスト')
    + (canSeeMoney ? segBtn('money', '今月の食費') : '')
    + '</div>';

  if (state.shopTab === 'coop') h += shoppingCoop();
  else if (state.shopTab === 'list') h += shoppingList();
  else if (canSeeMoney) h += shoppingMoney();

  view(h);

  document.querySelectorAll('[data-shoptab]').forEach(function (b) {
    b.addEventListener('click', function () { state.shopTab = b.dataset.shoptab; render(); });
  });
  document.querySelectorAll('[data-bought]').forEach(function (b) {
    b.addEventListener('click', function () { toggleBought(b.dataset.bought); });
  });
  document.querySelectorAll('[data-arrive]').forEach(function (b) {
    b.addEventListener('click', function () { arriveOrder(b.dataset.arrive); });
  });
  const ae = document.getElementById('add-expense');
  if (ae) ae.addEventListener('click', addExpense);
}

function segBtn(key, label) {
  return '<button data-shoptab="' + key + '" aria-pressed="' + (state.shopTab === key) + '">' + label + '</button>';
}

function shoppingCoop() {
  const d = state.data;
  const today = ymd(new Date());
  const arrive = nextThursday(addDays(today, 14));

  let h = '<div class="alert calm">今からの注文は <b>' + shortDate(arrive) + '（木）</b> に届きます。'
    + '締切は毎週金曜の19時です。</div>';
  h += '<div class="btn-row">'
    + '<a class="btn primary" href="https://www.coop-kobe.net" target="_blank" rel="noopener">コープこうべを開く</a>'
    + '</div>';

  /* --- 2週間後までの献立で使う食材のうち、いま無いもの --- */
  const limit = addDays(today, 14);
  const need = {};
  d.plan.forEach(function (p) {
    const day = String(p['日付']).slice(0, 10);
    if (day < today || day > limit || p['状態'] === '変更') return;
    const m = byId(d.menus, p['menu_id']);
    if (!m) return;
    splitList(m['材料']).forEach(function (f) {
      if (!need[f]) need[f] = { 回数: 0, 初出: day };
      need[f].回数++;
    });
  });

  const inStock = {};
  d.stock.forEach(function (s) { if (num(s['残数']) > 0) inStock[s['名称']] = true; });

  const missing = Object.keys(need)
    .filter(function (f) { return !inStock[f]; })
    .map(function (f) {
      const info = byKey(d.foods, '食材名', f) || {};
      return { 名前: f, 調達先: info['標準の調達先'] || 'スーパー', 回数: need[f].回数, 初出: need[f].初出 };
    })
    .sort(function (x, y) { return y.回数 - x.回数; });

  const coopFirst = missing.filter(function (x) { return x.調達先 === 'コープ'; });
  const others = missing.filter(function (x) { return x.調達先 !== 'コープ'; });

  h += '<h2 class="section">2週間後までに要りそうなもの</h2>';
  if (!missing.length) {
    h += '<div class="empty">いまの献立と在庫では、足りなくなるものはありません。</div>';
  } else {
    h += '<p class="hint">' + shortDate(today) + '〜' + shortDate(limit)
      + ' の献立で使う食材のうち、いま在庫に無いものです。使う回数が多い順に並べています。</p>';
    if (coopFirst.length) {
      h += '<p class="hint" style="margin-top:14px">コープで頼むもの</p>';
      coopFirst.forEach(function (x) {
        h += '<div class="kv"><span class="k">' + esc(x.名前) + '</span><span>'
          + x.回数 + '回・' + shortDate(x.初出) + 'から</span></div>';
      });
    }
    if (others.length) {
      h += '<p class="hint" style="margin-top:14px">スーパー・八百屋で買うもの（参考）</p>';
      others.forEach(function (x) {
        h += '<div class="kv"><span class="k">' + esc(x.名前) + '</span><span>'
          + esc(x.調達先) + '・' + x.回数 + '回</span></div>';
      });
    }
  }

  /* --- 到着待ちがあるときだけ出す --- */
  const open = d.orders.filter(function (o) { return o['状態'] === '注文済'; });
  if (open.length) {
    h += '<h2 class="section">到着待ち</h2>';
    open.sort(function (a2, b2) { return String(a2['到着予定日']).localeCompare(String(b2['到着予定日'])); })
      .forEach(function (o) {
        h += '<div class="card"><div class="card-row"><div>'
          + '<h3>' + esc(o['商品名']) + '</h3>'
          + '<div class="meta">' + shortDate(o['到着予定日']) + '着・' + esc(String(o['数量'] || 1)) + '個'
          + (o['金額'] ? '・' + yen(o['金額']) : '') + '</div></div></div>'
          + '<div class="btn-row"><button class="btn small primary" data-arrive="' + o['id'] + '|到着">届いた</button>'
          + '<button class="btn small" data-arrive="' + o['id'] + '|欠品">欠品だった</button></div></div>';
    });
  }

  h += '<div class="note">カタログの中身は毎週変わるので、アプリでは持っていません。'
    + '金曜の締切前にコープこうべのサイトを開いて、上のリストと見比べながら注文してください。'
    + '<br>注文した中身をアプリに手で入れる機能は、手間のわりに合わないので付けていません。</div>';
  return h;
}

function shoppingList() {
  const rows = state.data.shopping;
  if (!rows.length) {
    return '<div class="empty">「計画」タブで献立を入れて、「買い物リストを作る」を押してください。</div>';
  }
  const groups = {};
  rows.forEach(function (r) { (groups[r['調達先'] || 'スーパー'] = groups[r['調達先'] || 'スーパー'] || []).push(r); });

  const order = ['八百屋', 'ライフ', '近所のスーパー', 'スーパー', 'コープ'];
  const keys = Object.keys(groups).sort(function (a, b) {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  let h = '<p class="hint">野菜は八百屋を先に見て、なければスーパーへ。分量は出していません。</p>';
  keys.forEach(function (k) {
    h += '<h2 class="section">' + esc(k) + '</h2>';
    groups[k].forEach(function (r) {
      const done = !!r['買った'];
      h += '<div class="card" style="' + (done ? 'opacity:.5' : '') + '"><div class="card-row"><div>'
        + '<h3>' + esc(r['食材名']) + '</h3>'
        + (r['昼で使うメニュー'] ? '<div class="meta">昼：' + esc(r['昼で使うメニュー']) + '</div>' : '')
        + (r['夜で使うメニュー'] ? '<div class="meta">夜：' + esc(r['夜で使うメニュー']) + '</div>' : '')
        + '</div><button class="btn small" data-bought="' + r['id'] + '">' + (done ? '戻す' : '買った') + '</button>'
        + '</div></div>';
    });
  });
  return h;
}

function shoppingMoney() {
  const d = state.data;
  const budget = num(configVal('月予算')) || 60000;
  const month = ymd(new Date()).slice(0, 7);
  const rows = d.expenses.filter(function (e) { return String(e['日付']).slice(0, 7) === month; });
  const total = rows.reduce(function (a, e) { return a + num(e['金額']); }, 0);

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const passed = now.getDate();
  const forecast = passed > 0 ? Math.round(total / passed * daysInMonth) : 0;
  const pct = Math.min(100, Math.round(total / budget * 100));

  const byStore = {};
  rows.forEach(function (e) { byStore[e['店'] || 'その他'] = (byStore[e['店'] || 'その他'] || 0) + num(e['金額']); });

  let h = '<div class="card">'
    + '<h3>' + Number(month.slice(0, 4)) + '年' + Number(month.slice(5, 7)) + '月の食費</h3>'
    + '<div class="bar' + (forecast > budget ? ' over' : '') + '"><span style="width:' + pct + '%"></span></div>'
    + '<div class="kv"><span class="k">今まで</span><span>' + yen(total) + ' / ' + yen(budget) + '</span></div>'
    + '<div class="kv"><span class="k">このペースだと月末に</span><span>' + yen(forecast) + '</span></div>'
    + (forecast > budget
        ? '<div class="alert" style="margin-top:10px">予算より ' + yen(forecast - budget) + ' 多くなりそうです</div>'
        : '<div class="alert calm" style="margin-top:10px">このペースなら予算内に収まりそうです</div>')
    + '</div>';

  h += '<div class="btn-row"><button class="btn primary" id="add-expense">買い物を1件足す</button></div>';

  h += '<h2 class="section">店ごと</h2>';
  Object.keys(byStore).forEach(function (s) {
    h += '<div class="kv"><span class="k">' + esc(s) + '</span><span>' + yen(byStore[s]) + '</span></div>';
  });

  h += '<h2 class="section">今月の記録</h2>';
  if (!rows.length) h += '<div class="empty">まだありません。</div>';
  rows.slice().reverse().forEach(function (e) {
    h += '<div class="kv"><span class="k">' + shortDate(e['日付']) + '　' + esc(e['店']) + '</span><span>' + yen(e['金額']) + '</span></div>';
  });
  return h;
}

async function arriveOrder(arg) {
  const parts = arg.split('|');
  const o = byId(state.data.orders, parts[0]);
  if (!o) return;
  o['状態'] = parts[1];
  const rows = [];
  if (parts[1] === '到着') {
    rows.push({
      名称: o['商品名'], 種別: '生鮮', 作った日: ymd(new Date()),
      残数: num(o['数量']) || 1, 保存場所: '冷蔵', 期限: '',
      用途: '自由', plan_id: '', 調理要否: '要調理', 取り置き先: '',
    });
  }
  await api('upsert', { sheet: 'orders', rows: [o] });
  if (rows.length) await api('upsert', { sheet: 'stock', rows: rows });
  if (parts[1] === '欠品') {
    await api('upsert', { sheet: 'shopping', rows: [{ 食材名: o['商品名'], 調達先: 'ライフ', 買った: '' }] });
  }
  await reload();
  toast(parts[1] === '到着' ? '在庫に入れました' : 'スーパーの買い物リストに移しました');
}

function addExpense() {
  openSheet('買い物を1件足す',
    '<label class="field">日付<input type="date" id="e-date" value="' + ymd(new Date()) + '"></label>'
    + '<label class="field">店<select id="e-store">'
    + ['コープこうべ', 'ライフ', '近所のスーパー', '八百屋', 'その他'].map(function (s) {
        return '<option>' + s + '</option>';
      }).join('') + '</select></label>'
    + '<label class="field">合計金額<input type="number" id="e-amount" inputmode="numeric"></label>'
    + '<label class="field">メモ（任意）<input type="text" id="e-memo"></label>'
    + '<div class="btn-row"><button class="btn primary" id="e-save">保存</button></div>');
  document.getElementById('e-save').addEventListener('click', async function () {
    const amount = num(document.getElementById('e-amount').value);
    if (!amount) return toast('金額を入れてください');
    closeSheet();
    await save('expenses', [{
      日付: document.getElementById('e-date').value,
      店: document.getElementById('e-store').value,
      金額: amount,
      支払者: (myMember() || {}).名前 || '',
      メモ: document.getElementById('e-memo').value,
    }]);
    toast('記録しました');
  });
}

async function toggleBought(id) {
  const r = byId(state.data.shopping, id);
  if (!r) return;
  r['買った'] = r['買った'] ? '' : ymd(new Date());
  await save('shopping', [r]);
}

/* ================================================================== */
/* 離乳食（第一弾）                                                     */
/* ================================================================== */

/** 月齢から、食材表のどの列を見るかを決める */
function stageKey(months) {
  if (months >= 12) return '12-18';
  if (months >= 9) return '9-11';
  if (months >= 7) return '7-8';
  if (months >= 5) return '5-6';
  return '';
}

/**
 * アレルギー表示が義務づけられている原材料（特定原材料8品目）を含む食材。
 * 一度食べたきりで間があくと、次にあげるとき不安になりやすいので、
 * 「前回から何日たったか」という事実だけを出す。判断はしない。
 */
const KEY_ALLERGENS = {
  '卵': '卵', '牛乳': '乳', 'プレーンヨーグルト': '乳', 'カッテージチーズ': '乳',
  '粉チーズ': '乳', 'プロセスチーズ': '乳', '溶けるチーズ': '乳',
  'うどん': '小麦', 'そうめん': '小麦', 'マカロニ': '小麦', 'スパゲティ': '小麦',
  '中華めん': '小麦', '食パン': '小麦', 'ロールパン': '小麦', '麸': '小麦',
  'えび': 'えび', '桜えび': 'えび',
};

function renderBaby() {
  const d = state.data;
  const baby = d.members.find(function (m) { return m['区分'] === '乳児'; });
  if (!baby || !baby['誕生日']) {
    return view('<div class="empty">設定タブで赤ちゃんの誕生日を入れると、月齢と段階が出ます。</div>');
  }

  const a = ageOf(baby['誕生日']);
  const key = stageKey(a.months);
  const today = ymd(new Date());
  const all = d.baby_foods || [];

  let h = '<div class="card"><h3>生後' + a.months + 'か月' + a.days + '日</h3>'
    + '<div class="meta">' + (a.stage ? a.stage + '（' + key + 'カ月ごろ）' : '離乳食はまだ先です') + '</div></div>';

  if (!key) {
    h += '<div class="alert calm">離乳食のはじまりは ' + shortDate(addMonths(baby['誕生日'], 5))
      + ' ごろの見込みです。下の一覧で、始まったら何が食べられるかを先に見ておけます。</div>';
  }

  /* --- 今日の記録 --- */
  h += '<h2 class="section">今日の記録</h2>';
  const logs = d.baby_log.filter(function (b) { return String(b['日付']).slice(0, 10) === today; });
  if (!logs.length) h += '<div class="empty">まだありません。</div>';
  logs.forEach(function (b) {
    h += '<div class="card"><div class="card-row"><div>'
      + '<h3>' + esc(b['メニュー名']) + '</h3>'
      + '<div class="meta">' + esc([b['食事区分'], b['食べた量'], b['機嫌'],
          b['ミルクml'] ? 'ミルク' + num(b['ミルクml']) + 'ml' : ''].filter(Boolean).join('・')) + '</div>'
      + (b['はじめて食材'] ? '<div class="meta"><span class="badge free">はじめて</span> ' + esc(b['はじめて食材']) + '</div>' : '')
      + (b['メモ'] ? '<div class="meta">' + esc(b['メモ']) + '</div>' : '')
      + '</div><button class="btn small" data-babyedit="' + b['id'] + '">直す</button></div></div>';
  });
  h += '<div class="btn-row"><button class="btn primary" id="baby-add">記録する</button></div>';
  h += '<p class="hint">押した時点でスプレッドシートに書き込まれます。あとでまとめて保存ではないので、'
    + '途中でアプリを閉じても消えません。</p>';

  /* --- 間があいているもの（事実の提示だけ） --- */
  const gaps = all.filter(function (f) {
    return KEY_ALLERGENS[f['食材名']] && f['初めて食べた日'];
  }).map(function (f) {
    return { f: f, days: daysBetween(f['初めて食べた日'], today) };
  }).sort(function (x, y) { return y.days - x.days; });

  if (gaps.length) {
    h += '<h2 class="section">間があいているもの</h2>';
    h += '<p class="hint">前回からの日数を出しているだけです。あけ方の判断はしていません。'
      + '気になるときはかかりつけ医や健診で相談してください。</p>';
    gaps.slice(0, 8).forEach(function (g) {
      const long = g.days >= 14;
      h += '<div class="card"><div class="card-row"><div>'
        + '<h3>' + esc(g.f['食材名']) + '</h3>'
        + '<div class="meta">' + esc(KEY_ALLERGENS[g.f['食材名']]) + '・前回 ' + shortDate(g.f['初めて食べた日']) + '</div>'
        + '</div><span class="badge ' + (long ? 'warn' : 'plain') + '">' + g.days + '日前</span></div></div>';
    });
  }

  /* --- はじめての食材（まだ始まっていない時期は、初期の一覧を下見として出す） --- */
  {
    const look = key || '5-6';
    const eatable = all.filter(function (f) {
      const mark = String(f[look] || '');
      return (mark.indexOf('○') === 0 || mark.indexOf('△') === 0) && !f['初めて食べた日'];
    });
    const done = all.filter(function (f) { return f['初めて食べた日']; });

    h += '<h2 class="section">' + (key ? 'はじめての食材' : '始まったら食べられるもの')
      + '（' + look + 'カ月ごろ）</h2>';
    h += '<p class="hint">' + (key
      ? '初めてあげた日を押して記録しておくと、次に何を試すか決めやすくなります。'
      : 'いまは下見だけです。5カ月になったら記録できるようになります。')
      + '記号の下は、その時期の大きさ・形状の目安です。</p>';

    if (!eatable.length) {
      h += '<div class="empty">この時期に食べられるものは、すべて記録済みです。</div>';
    } else {
      const groups = {};
      eatable.forEach(function (f) { (groups[f['小分類']] = groups[f['小分類']] || []).push(f); });
      Object.keys(groups).forEach(function (g) {
        h += '<p class="hint" style="margin-top:14px">' + esc(g) + '</p>';
        groups[g].forEach(function (f) {
          const mark = String(f[look]);
          const shape = f[look + '形状'];
          h += '<div class="card"><div class="card-row"><div>'
            + '<h3>' + esc(f['食材名']) + '</h3>'
            + '<div class="meta">' + esc(mark) + (shape ? '　' + esc(shape) : '') + '</div>'
            + '</div>'
            + (key ? '<button class="btn small" data-firsttry="' + esc(f['食材名']) + '">はじめて食べた</button>' : '')
            + '</div></div>';
        });
      });
    }

    if (done.length) {
      h += '<h2 class="section">食べたことがあるもの（' + done.length + '）</h2>';
      h += '<div class="card"><div class="meta">' + esc(done.map(function (f) { return f['食材名']; }).join('、')) + '</div></div>';
    }
  }

  /* --- 気をつける食材 --- */
  if ((d.baby_ng || []).length) {
    h += '<h2 class="section">気をつける食材</h2>';
    d.baby_ng.forEach(function (n) {
      h += '<div class="alert">' + esc(n['区分']) + '：' + esc(n['食材']) + '</div>';
    });
  }

  /* --- 記号の見方 --- */
  if ((d.baby_legend || []).length) {
    h += '<h2 class="section">記号の見方</h2><div class="card">';
    d.baby_legend.forEach(function (l) {
      h += '<div class="kv"><span class="k">' + esc(l['記号']) + '</span><span style="flex:1;text-align:left">' + esc(l['意味']) + '</span></div>';
    });
    h += '</div>';
  }

  h += '<div class="note">食材の一覧は『365日の離乳食カレンダー』の103食材チェックリストをもとにしています。'
    + 'あくまで目安で、このアプリは医学的な判断をしません。'
    + 'アレルギーの既往や湿疹があるとき、迷ったときは、かかりつけ医や健診で相談してください。'
    + '<br><br>栄養バランスの円グラフ、材料ごとの入力、ミルクの記録、市販ベビーフードの連動は次の段階で入れます'
    + '（機能を削るのではなく、開始日に間に合わせるため順番を後ろにしています）。</div>';

  view(h);

  document.querySelectorAll('[data-firsttry]').forEach(function (b) {
    b.addEventListener('click', function () { recordFirstTry(b.dataset.firsttry); });
  });
  document.getElementById('baby-add').addEventListener('click', function () { editBabyLog(null); });
  document.querySelectorAll('[data-babyedit]').forEach(function (b) {
    b.addEventListener('click', function () { editBabyLog(b.dataset.babyedit); });
  });
}

/**
 * 離乳食の記録を足す・直す。
 * 保存を押した時点でスプレッドシートに書き込む（端末に貯めておかない）。
 */
function editBabyLog(id) {
  const b = id ? (byId(state.data.baby_log, id) || {}) : {};
  const slots = ['朝', '昼', '夕', 'おやつ'];
  const amounts = ['予定', '拒否', '少し', '半分', '完食'];
  const moods = ['ごきげん', 'ふつう', 'ぐずり'];

  function seg(name, list, cur) {
    return '<div class="seg" data-seg="' + name + '">' + list.map(function (v) {
      return '<button data-v="' + esc(v) + '" aria-pressed="' + (cur === v) + '">' + esc(v) + '</button>';
    }).join('') + '</div>';
  }

  openSheet(id ? '記録を直す' : '離乳食の記録',
    '<label class="field">いつ<input type="date" id="b-date" value="'
      + esc(String(b['日付'] || ymd(new Date())).slice(0, 10)) + '"></label>'
    + '<label class="field">食事</label>' + seg('slot', slots, b['食事区分'] || '昼')
    + '<label class="field">メニュー<input type="text" id="b-menu" value="' + esc(b['メニュー名'] || '') + '" placeholder="10倍がゆ、にんじんペースト など"></label>'
    + '<label class="field">はじめての食材（あれば）<input type="text" id="b-first" value="' + esc(b['はじめて食材'] || '') + '" list="b-foods"></label>'
    + '<datalist id="b-foods">'
      + (state.data.baby_foods || []).map(function (f) { return '<option value="' + esc(f['食材名']) + '">'; }).join('')
      + '</datalist>'
    + '<label class="field">どれくらい食べたか</label>' + seg('amount', amounts, b['食べた量'] || '完食')
    + '<label class="field">機嫌</label>' + seg('mood', moods, b['機嫌'] || 'ごきげん')
    + '<label class="field">このあとのミルク（ml・任意）<input type="number" id="b-milk" inputmode="numeric" value="' + esc(String(b['ミルクml'] || '')) + '"></label>'
    + '<label class="field">メモ・様子<textarea id="b-memo">' + esc(b['メモ'] || '') + '</textarea></label>'
    + '<div class="btn-row"><button class="btn primary" id="b-save">保存</button>'
      + (id ? '<button class="btn" id="b-del">削除</button>' : '') + '</div>');

  const picked = { slot: b['食事区分'] || '昼', amount: b['食べた量'] || '完食', mood: b['機嫌'] || 'ごきげん' };
  document.querySelectorAll('[data-seg]').forEach(function (g) {
    g.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        picked[g.dataset.seg] = btn.dataset.v;
        g.querySelectorAll('button').forEach(function (x) {
          x.setAttribute('aria-pressed', String(x === btn));
        });
      });
    });
  });

  document.getElementById('b-save').addEventListener('click', async function () {
    const menu = document.getElementById('b-menu').value.trim();
    if (!menu) return toast('メニューを入れてください');
    const first = document.getElementById('b-first').value.trim();
    const date = document.getElementById('b-date').value;
    closeSheet();

    const row = {
      id: id || '',
      日付: date,
      食事区分: picked.slot,
      メニュー名: menu,
      参考URL: b['参考URL'] || '',
      材料: b['材料'] || '',
      はじめて食材: first,
      食べた量: picked.amount,
      機嫌: picked.mood,
      メモ: document.getElementById('b-memo').value,
      ミルクml: num(document.getElementById('b-milk').value) || '',
    };
    if (!row.id) delete row.id;

    await api('upsert', { sheet: 'baby_log', rows: [row] });

    // はじめて食べた食材は、チェックリスト側にも日付を入れる
    if (first) {
      const f = byKey(state.data.baby_foods, '食材名', first);
      if (f && !f['初めて食べた日']) {
        f['初めて食べた日'] = date;
        await api('upsert', { sheet: 'baby_foods', rows: [f] });
      }
    }
    await reload();
    toast('記録しました');
  });

  const del = document.getElementById('b-del');
  if (del) del.addEventListener('click', async function () {
    if (!confirm('この記録を消します。よろしいですか？')) return;
    closeSheet();
    await api('remove', { sheet: 'baby_log', ids: [id] });
    await reload();
    toast('消しました');
  });
}

async function recordFirstTry(name) {
  const f = byKey(state.data.baby_foods, '食材名', name);
  if (!f) return;
  f['初めて食べた日'] = ymd(new Date());
  await save('baby_foods', [f]);
  toast(name + 'の「はじめて」を記録しました');
}

/* ================================================================== */
/* 設定                                                                */
/* ================================================================== */

function renderSettings() {
  let h = '<h2 class="section">つなぎ先</h2>'
    + '<label class="field">GASのウェブアプリURL<input type="url" id="s-url" value="' + esc(cfg.url || '') + '" placeholder="https://script.google.com/macros/s/.../exec"></label>'
    + '<label class="field">家族の合言葉<input type="password" id="s-secret" value="' + esc(cfg.secret || '') + '"></label>'
    + '<div class="btn-row"><button class="btn primary" id="s-save">保存してつなぐ</button></div>'
    + '<div class="note">この2つはこの端末の中にだけ保存されます。アプリのコードにも、GitHubにも入りません。'
    + '<br>いま動いている画面のバージョン： <b>' + APP_VERSION + '</b></div>';

  if (state.data) {
    h += '<h2 class="section">わたしは誰か</h2><div class="seg" id="me-seg">';
    state.data.members.forEach(function (m) {
      h += '<button data-me="' + m.id + '" aria-pressed="' + (cfg.me === m.id) + '">' + esc(m['名前']) + '</button>';
    });
    h += '</div>';

    h += '<h2 class="section">家族の設定</h2>';
    state.data.members.forEach(function (m) {
      h += '<div class="card"><div class="card-row"><div>'
        + '<h3>' + esc(m['名前']) + '</h3>'
        + '<div class="meta">' + esc(m['区分']) + (m['誕生日'] ? '・' + shortDate(m['誕生日']) : '') + '</div>'
        + '</div><button class="btn small" data-editmember="' + m.id + '">直す</button></div></div>';
    });

    h += '<h2 class="section">苦手な食材</h2>'
      + '<p class="hint">自分の分を入れてください。△は「少量なら食べられる」です。'
      + '調理法によって変わるものは、メモに書いておくと提案に反映されます。</p>';
    const me = myMember();
    if (!me) {
      h += '<div class="empty">先に「わたしは誰か」を選んでください。</div>';
    } else {
      state.data.foods.forEach(function (f) {
        const p = state.data.prefs.find(function (x) {
          return String(x['member_id']) === String(me.id) && x['食材名'] === f['食材名'];
        }) || {};
        h += '<div class="card"><div class="card-row"><div><h3>' + esc(f['食材名']) + '</h3>'
          + (p['メモ'] ? '<div class="meta">' + esc(p['メモ']) + '</div>' : '')
          + '</div><div class="seg">'
          + ['○', '△', '×'].map(function (v) {
              return '<button data-pref="' + esc(f['食材名']) + '|' + v + '" aria-pressed="'
                + ((p['評価'] || '○') === v) + '">' + v + '</button>';
            }).join('')
          + '</div></div>'
          + '<div class="btn-row"><button class="btn small" data-prefmemo="' + esc(f['食材名']) + '">メモ</button></div>'
          + '</div>';
      });
    }

    const unread = state.data.voices.filter(function (v) { return v['状態'] === '未読'; });
    h += '<h2 class="section">みんなの声' + (unread.length ? '（未対応 ' + unread.length + '件）' : '') + '</h2>';
    if (!state.data.voices.length) h += '<div class="empty">まだありません。</div>';
    state.data.voices.slice().reverse().forEach(function (v) {
      h += '<div class="card"><div class="card-row"><div>'
        + '<h3>' + esc(v['本文']) + '</h3>'
        + '<div class="meta">' + esc([v['投稿者'], v['種別'], v['関連画面'], shortDate(v['投稿日時'])].filter(Boolean).join('・')) + '</div>'
        + (v['返信'] ? '<div class="meta">返信：' + esc(v['返信']) + '</div>' : '')
        + '</div><span class="badge ' + (v['状態'] === '未読' ? 'warn' : 'plain') + '">' + esc(v['状態'] || '未読') + '</span></div>'
        + (v['画像ID'] ? '<img class="shot" data-img="' + esc(v['画像ID']) + '" alt="添付されたスクリーンショット">' : '')
        + '<div class="btn-row"><button class="btn small" data-voice="' + v['id'] + '">状態と返信</button></div>'
        + '</div>';
    });

    h += '<h2 class="section">月予算</h2>'
      + '<label class="field">1か月の食費の目安<input type="number" id="s-budget" value="' + esc(String(configVal('月予算') || 60000)) + '"></label>'
      + '<div class="btn-row"><button class="btn" id="s-budget-save">保存</button></div>';
  }

  view(h);

  document.getElementById('s-save').addEventListener('click', function () {
    cfg.url = document.getElementById('s-url').value.trim();
    cfg.secret = document.getElementById('s-secret').value;
    saveCfg();
    reload();
    toast('保存しました');
  });
  document.querySelectorAll('[data-me]').forEach(function (b) {
    b.addEventListener('click', function () { cfg.me = b.dataset.me; saveCfg(); paintMe(); render(); });
  });
  document.querySelectorAll('[data-editmember]').forEach(function (b) {
    b.addEventListener('click', function () { editMember(b.dataset.editmember); });
  });
  document.querySelectorAll('[data-pref]').forEach(function (b) {
    b.addEventListener('click', function () {
      const parts = b.dataset.pref.split('|');
      setPref(parts[0], parts[1], null);
    });
  });
  document.querySelectorAll('[data-prefmemo]').forEach(function (b) {
    b.addEventListener('click', function () { editPrefMemo(b.dataset.prefmemo); });
  });
  document.querySelectorAll('[data-voice]').forEach(function (b) {
    b.addEventListener('click', function () { editVoice(b.dataset.voice); });
  });
  document.querySelectorAll('[data-img]').forEach(function (img) { loadImage(img); });
  const bb = document.getElementById('s-budget-save');
  if (bb) bb.addEventListener('click', async function () {
    await save('config', [{ 'キー': '月予算', '値': num(document.getElementById('s-budget').value) }]);
    toast('保存しました');
  });
}

function editMember(id) {
  const m = byId(state.data.members, id);
  if (!m) return;
  openSheet(m['名前'] + ' の設定',
    '<label class="field">呼び名<input type="text" id="m-name" value="' + esc(m['名前']) + '"></label>'
    + '<label class="field">誕生日' + (m['区分'] === '乳児' ? '（月齢の計算に使います）' : '（任意）')
    + '<input type="date" id="m-birth" value="' + esc(String(m['誕生日'] || '').slice(0, 10)) + '"></label>'
    + '<div class="btn-row"><button class="btn primary" id="m-save">保存</button></div>');
  document.getElementById('m-save').addEventListener('click', async function () {
    closeSheet();
    m['名前'] = document.getElementById('m-name').value.trim() || m['名前'];
    m['誕生日'] = document.getElementById('m-birth').value;
    await save('members', [m]);
    paintMe();
    toast('保存しました');
  });
}

async function setPref(food, value, memo) {
  const me = myMember();
  if (!me) return;
  // 同じ人・同じ食材の行は1つだけ。id があれば更新、無ければ新規に追加される。
  const row = state.data.prefs.find(function (x) {
    return String(x['member_id']) === String(me.id) && x['食材名'] === food;
  }) || { member_id: me.id, 食材名: food, 評価: '○', メモ: '' };
  if (value !== null) row['評価'] = value;
  if (memo !== null && memo !== undefined) row['メモ'] = memo;
  await save('prefs', [row]);
}

function editPrefMemo(food) {
  const me = myMember();
  const row = state.data.prefs.find(function (x) {
    return me && String(x['member_id']) === String(me.id) && x['食材名'] === food;
  }) || {};
  openSheet(food + ' のメモ',
    '<p class="hint">調理法で変わるものはここに。例：「生はだめだけど、火を通せば食べられる」</p>'
    + '<textarea id="p-memo">' + esc(row['メモ'] || '') + '</textarea>'
    + '<div class="btn-row"><button class="btn primary" id="p-save">保存</button></div>');
  document.getElementById('p-save').addEventListener('click', async function () {
    const v = document.getElementById('p-memo').value;
    closeSheet();
    await setPref(food, null, v);
    toast('保存しました');
  });
}

function editVoice(id) {
  const v = byId(state.data.voices, id);
  if (!v) return;
  openSheet('みんなの声',
    '<p class="hint">' + esc(v['本文']) + '</p>'
    + '<label class="field">状態<select id="v-state">'
    + ['未読', '対応中', '完了', '見送り'].map(function (s) {
        return '<option' + (v['状態'] === s ? ' selected' : '') + '>' + s + '</option>';
      }).join('') + '</select></label>'
    + '<label class="field">返信（投稿した人のトップ画面に出ます）<textarea id="v-reply">' + esc(v['返信'] || '') + '</textarea></label>'
    + '<div class="btn-row"><button class="btn primary" id="v-save">保存</button></div>');
  document.getElementById('v-save').addEventListener('click', async function () {
    closeSheet();
    v['状態'] = document.getElementById('v-state').value;
    v['返信'] = document.getElementById('v-reply').value;
    await save('voices', [v]);
    toast('保存しました');
  });
}

async function loadImage(img) {
  try {
    const r = await api('getImage', { fileId: img.dataset.img });
    img.src = 'data:' + r.mimeType + ';base64,' + r.dataBase64;
  } catch (e) {
    img.remove();
  }
}

/* ================================================================== */
/* 意見箱                                                              */
/* ================================================================== */

function openVoice() {
  const tabName = { today: '今日', plan: '計画', shopping: '買い物', baby: '離乳食', settings: '設定' }[state.tab];
  openSheet('ひとこと',
    '<p class="hint">気づいたことを一言で大丈夫です。スクリーンショットも付けられます。</p>'
    + '<div class="seg" id="v-kind">'
    + ['不具合', 'こうしてほしい', 'よかった'].map(function (k, i) {
        return '<button data-kind="' + k + '" aria-pressed="' + (i === 1) + '">' + k + '</button>';
      }).join('') + '</div>'
    + '<label class="field">ひとこと<textarea id="v-text"></textarea></label>'
    + '<label class="field">スクリーンショット（任意）<input type="file" accept="image/*" id="v-file"></label>'
    + '<div class="btn-row"><button class="btn primary" id="v-send">送る</button></div>');

  let kind = 'こうしてほしい';
  document.querySelectorAll('[data-kind]').forEach(function (b) {
    b.addEventListener('click', function () {
      kind = b.dataset.kind;
      document.querySelectorAll('[data-kind]').forEach(function (x) {
        x.setAttribute('aria-pressed', String(x === b));
      });
    });
  });

  document.getElementById('v-send').addEventListener('click', async function () {
    const text = document.getElementById('v-text').value.trim();
    if (!text) return toast('ひとこと書いてください');
    const file = document.getElementById('v-file').files[0];
    closeSheet();
    toast('送っています…');
    let fileId = '';
    try {
      if (file) {
        const b64 = await fileToBase64(file);
        const r = await api('uploadImage', { name: file.name, mimeType: file.type, dataBase64: b64 });
        fileId = r.fileId;
      }
      await save('voices', [{
        投稿日時: new Date().toISOString(),
        投稿者: (myMember() || {}).名前 || '',
        種別: kind,
        本文: text,
        画像ID: fileId,
        関連画面: tabName,
        状態: '未読',
        返信: '',
      }]);
      toast('ありがとうございます。届きました');
    } catch (err) {
      toast('送れませんでした：' + err.message);
    }
  });
}

function fileToBase64(file) {
  return new Promise(function (resolve, reject) {
    const r = new FileReader();
    r.onload = function () { resolve(String(r.result).split(',')[1]); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* ================================================================== */
/* 共通の小物                                                          */
/* ================================================================== */

function loadCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; }
}
function saveCfg() {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
}

function myMember() {
  if (!state.data) return null;
  return byId(state.data.members, cfg.me) || null;
}

function paintMe() {
  const b = document.getElementById('whoami');
  const m = myMember();
  b.textContent = m ? m['名前'] : 'わたしは？';
}

function pickMe() {
  if (!state.data) return go('settings');
  let h = '';
  state.data.members.forEach(function (m) {
    h += '<button class="pick" data-pickme="' + m.id + '">' + esc(m['名前'])
      + '<div class="meta">' + esc(m['役割'] || m['区分']) + '</div></button>';
  });
  openSheet('だれとして見ますか', h);
  document.querySelectorAll('[data-pickme]').forEach(function (b) {
    b.addEventListener('click', function () {
      cfg.me = b.dataset.pickme;
      saveCfg();
      closeSheet();
      paintMe();
      render();
    });
  });
}

/** その人にとってこの在庫がどうか（'' / '△' / '×'） */
function ngMark(me, stockRow) {
  if (!me || !state.data) return '';
  const foods = stockRow['種別'] === '作り置き'
    ? splitList((byKey(state.data.menus, 'メニュー名', stockRow['名称']) || {})['材料'])
    : [stockRow['名称']];
  let mark = '';
  foods.forEach(function (f) {
    const p = state.data.prefs.find(function (x) {
      return String(x['member_id']) === String(me.id) && x['食材名'] === f;
    });
    if (!p) return;
    if (p['評価'] === '×') mark = '×';
    else if (p['評価'] === '△' && mark !== '×') mark = '△';
  });
  return mark;
}

function menuName(id) {
  const m = byId(state.data.menus, id);
  return m ? m['メニュー名'] : '(不明)';
}
function configVal(key) {
  const r = byKey(state.data.config, 'キー', key);
  return r ? r['値'] : '';
}

function byId(rows, id) {
  if (!rows || !id) return null;
  return rows.find(function (r) { return String(r.id) === String(id); }) || null;
}
function byKey(rows, key, val) {
  if (!rows) return null;
  return rows.find(function (r) { return String(r[key]) === String(val); }) || null;
}
function splitList(v) {
  if (!v) return [];
  return String(v).split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
}
function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function yen(n) { return '¥' + Number(n || 0).toLocaleString('ja-JP'); }

function ymd(d) {
  const z = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
}
function addDays(s, n) {
  const d = new Date(String(s).slice(0, 10) + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return ymd(d);
}
function daysBetween(from, to) {
  const a = new Date(String(from).slice(0, 10) + 'T00:00:00');
  const b = new Date(String(to).slice(0, 10) + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}
function addMonths(s, n) {
  const d = new Date(String(s).slice(0, 10) + 'T00:00:00');
  d.setMonth(d.getMonth() + n);
  return ymd(d);
}
function shortDate(s) {
  const t = String(s || '').slice(0, 10);
  return t ? Number(t.slice(5, 7)) + '/' + Number(t.slice(8, 10)) : '';
}
/** 週は土曜始まり */
function weekStart(d) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 1) % 7));
  return ymd(x);
}
function nextThursday(from) {
  let d = String(from).slice(0, 10);
  for (let i = 0; i < 7; i++) {
    if (new Date(d + 'T00:00:00').getDay() === 4) return d;
    d = addDays(d, 1);
  }
  return d;
}
function ageOf(birth) {
  const b = new Date(String(birth).slice(0, 10) + 'T00:00:00');
  const n = new Date();
  let months = (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth());
  if (n.getDate() < b.getDate()) months--;
  const anchor = new Date(b);
  anchor.setMonth(anchor.getMonth() + months);
  const days = Math.floor((n - anchor) / 86400000);
  let stage = '';
  if (months >= 12) stage = '完了期';
  else if (months >= 9) stage = '後期';
  else if (months >= 7) stage = '中期';
  else if (months >= 5) stage = '初期';
  return { months: months, days: days, stage: stage };
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function openSheet(title, html) {
  document.getElementById('sheet-title').textContent = title;
  document.getElementById('sheet-content').innerHTML = html;
  document.getElementById('sheet').hidden = false;
}
function closeSheet() { document.getElementById('sheet').hidden = true; }

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
}
