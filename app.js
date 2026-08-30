'use strict';

/**
 * ごはん台帳 — フロント
 *
 * GASのURLと合言葉はこのファイルに書かない。各自が設定画面で入れ、
 * その端末の localStorage にだけ残る。リポジトリには秘密情報を置かない。
 */

const APP_VERSION = '2026-08-30-18';
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

/* ---------- 保存期限の見かた ----------
 * 古い「期限」列には食べる予定日が入っている行がある。
 * 安全の判断には使わず、「保存期限」だけを見る。
 * 「保存期限」が空で「期限」だけある行は、未確認として扱う。
 */
function useBy(s) { return String(s['保存期限'] || '').slice(0, 10); }
function isExpired(s) { const u = useBy(s); return !!u && u < ymd(new Date()); }
function isDueToday(s) { const u = useBy(s); return !!u && u === ymd(new Date()); }
function limitUnknown(s) { return !useBy(s) && !!s['期限']; }

function renderToday() {
  const d = state.data;
  const me = myMember();
  const today = ymd(new Date());
  let h = '';

  /* --- 今日やること --- */
  const todo = [];
  const dow = new Date().getDay(); // 0=日

  const live = d.stock.filter(function (s) { return num(s['残数']) > 0; });

  const gone = live.filter(isExpired);
  if (gone.length) {
    todo.push({
      warn: true,
      text: '保存期限が過ぎています。食べずに処分してください：'
        + gone.map(function (s) { return s['名称'] + '（' + shortDate(useBy(s)) + 'まで）'; }).join('、'),
    });
  }

  const dueToday = live.filter(isDueToday);
  if (dueToday.length) {
    todo.push({
      warn: true,
      text: '今日までに食べたいもの：' + dueToday.map(function (s) { return s['名称']; }).join('、'),
    });
  }

  const thaw = live.filter(function (s) {
    return s['保存場所'] === '冷凍' && s['種別'] === '作り置き'
      && String(s['食べる予定日']).slice(0, 10) === addDays(today, 1);
  });
  if (thaw.length) {
    todo.push({
      warn: false,
      text: '明日の昼の分を冷凍庫から冷蔵庫へ移す：' + thaw.map(function (s) { return s['名称']; }).join('、'),
    });
  }

  // ごはんは大・小で分けて数える。合計だけだと「大がもう無い」が見えない。
  const riceRows = d.stock.filter(function (s) {
    return s['種別'] === 'ごはん' && num(s['残数']) > 0 && !isExpired(s);
  }).sort(function (a, b) {
    return String(a['保存期限'] || '9999').localeCompare(String(b['保存期限'] || '9999'));
  });
  const RICE_SIZES = ['大', '小'];
  const riceBySize = {};
  RICE_SIZES.forEach(function (size) {
    riceBySize[size] = riceRows.filter(function (s) { return s['名称'] === 'ごはん（' + size + '）'; });
  });
  const riceLeft = {};
  RICE_SIZES.forEach(function (size) {
    riceLeft[size] = riceBySize[size].reduce(function (n, s) { return n + num(s['残数']); }, 0);
  });
  const riceWarn = num(configVal('ごはん警告パック数')) || 2;
  const riceLow = RICE_SIZES.filter(function (size) { return riceLeft[size] <= riceWarn; });

  if (riceLeft['大'] + riceLeft['小'] === 0) {
    todo.push({ warn: true, text: 'ごはんがありません。お米を炊いてください' });
  } else if (riceLow.length) {
    todo.push({
      warn: true,
      text: 'ごはんが少なくなっています（'
        + RICE_SIZES.map(function (size) { return size + ' ' + riceLeft[size]; }).join('・')
        + '）。そろそろ炊いてください',
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

  /* --- ごはん（炊いてパックに分けたもの） --- */
  h += '<h2 class="section">ごはん</h2>';
  {
    const oldest = riceRows[0];
    const low = riceLow.length > 0;
    h += '<div class="card"><div class="card-row"><div>'
      + '<h3>' + RICE_SIZES.map(function (size) {
          return size + ' ' + riceLeft[size];
        }).join('　／　') + '</h3>'
      + (oldest && oldest['保存期限']
          ? '<div class="meta">古い分は ' + shortDate(oldest['保存期限']) + 'まで（'
            + shortDate(oldest['作った日']) + 'に炊いた分）</div>'
          : '<div class="meta">パックの残り数です</div>')
      + '</div><span class="badge ' + (low ? 'warn' : 'free') + '">'
      + (low ? 'そろそろ炊く' : 'じゅうぶん') + '</span></div>'
      + '<div class="btn-row">'
      + RICE_SIZES.map(function (size) {
          return riceLeft[size]
            ? '<button class="btn small" data-riceeat="' + size + '">' + size + 'を1つ食べた</button>'
            : '';
        }).join('')
      + '<button class="btn small' + (low ? ' primary' : '') + '" id="rice-cook">炊いた</button>'
      + '</div></div>';
    if (low) {
      h += '<p class="hint">' + esc(riceLow.join('と')) + 'が' + riceWarn + 'パック以下です。'
        + '「お米を炊く」が下の「手伝えるとき」にも出ています。黎次さんが頼まなくても届きます。</p>';
    }
  }

  /* --- あるもの：どうぞ --- */
  // 市販ベビーフードは離乳食タブで扱うので、大人の一覧には出さない
  const mine = d.stock.filter(function (s) {
    // 市販ベビーフードは離乳食タブ、ごはんは専用の欄で扱う
    return num(s['残数']) > 0 && s['種別'] !== '市販BF' && s['種別'] !== 'ごはん';
  });
  const free = mine.filter(function (s) {
    if (isExpired(s)) return false; // 期限切れは勧めない
    if (String(s['用途'] || '自由').indexOf('自由') !== 0) return false;
    // 誰かの取り置きは、その人以外の「どうぞ」に出さない
    const held = s['取り置き先'];
    if (held && me && String(held) !== String(me.id)) return false;
    return ngMark(me, s) !== '×';
  });
  const readyNow = free.filter(function (s) { return s['調理要否'] === 'そのまま食べられる'; });
  const needCook = free.filter(function (s) { return s['調理要否'] !== 'そのまま食べられる'; });

  h += '<h2 class="section">あるもの</h2>';
  h += '<p class="hint">「どうぞ」は献立に使う予定がないので、遠慮なく食べて大丈夫です。</p>';
  h += '<div class="btn-row" style="margin-top:8px">'
    + '<button class="btn" id="stock-add">あるものを足す</button></div>';

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
  document.querySelectorAll('[data-riceeat]').forEach(function (b) {
    b.addEventListener('click', async function () {
      const size = b.dataset.riceeat;
      const oldest = riceBySize[size][0];   // 古い分から減らす
      if (!oldest) return;
      try {
        const r = await api('consume', { stockId: oldest['id'], n: 1 });
        await reload();
        toast(size + 'を1つ食べました');
        if (r['ごはん'] && r['ごはん']['出した']) {
          toast('残りが少ないので「お米を炊く」を出しました');
        }
      } catch (err) { toast(err.message); }
    });
  });
  document.getElementById('rice-cook').addEventListener('click', cookRice);
  document.getElementById('stock-add').addEventListener('click', function () { editStock(null); });
  document.querySelectorAll('[data-stockedit]').forEach(function (b) {
    b.addEventListener('click', function () { editStock(b.dataset.stockedit); });
  });
}

/**
 * お米を炊いたときの登録。
 * 炊いた回ごとに1行で持つので、パックごとの日持ちを取り違えない。
 */
function cookRice() {
  const large = num(configVal('一度に炊くパック数（大）')) || 4;
  const small = num(configVal('一度に炊くパック数（小）')) || 4;
  const keep = num(configVal('ごはんの日持ち')) || 3;

  openSheet('お米を炊いた',
    '<label class="field">大きいパック<input type="number" id="rc-large" inputmode="numeric" min="0" value="'
      + large + '"></label>'
    + '<label class="field">小さいパック<input type="number" id="rc-small" inputmode="numeric" min="0" value="'
      + small + '"></label>'
    + '<label class="field">炊いた日<input type="date" id="rc-date" value="' + ymd(new Date()) + '"></label>'
    + '<p class="hint">冷蔵での目安として、炊いた日から' + keep + '日後を保存期限に入れます。'
      + '数を変えたいときは、スプレッドシートの config で直せます。</p>'
    + '<div class="btn-row"><button class="btn primary" id="rc-save">登録する</button></div>');

  document.getElementById('rc-save').addEventListener('click', async function () {
    const L = num(document.getElementById('rc-large').value);
    const S = num(document.getElementById('rc-small').value);
    if (L + S <= 0) return toast('パック数を入れてください');
    closeSheet();
    try {
      const r = await api('cookRice', {
        large: L, small: S, cookedOn: document.getElementById('rc-date').value,
      });
      await reload();
      toast('大' + r['足した大'] + '・小' + r['足した小'] + 'を足しました'
        + '（残り 大' + r['残り']['大'] + '・小' + r['残り']['小'] + '）');
    } catch (err) { toast('登録できませんでした：' + err.message); }
  });
}

/**
 * 在庫を足す・直す。
 *
 * 買ってきたもの、いま冷蔵庫にあるものを、ここから登録する。
 * 新しく足したものは「自由」なので、そのまま家族の「どうぞ」に出る。
 * 献立で使う予定にしたいときは、計画タブで「この週を在庫に反映」を押す。
 */
function editStock(id, prefill) {
  const st = id ? (byId(state.data.stock, id) || {}) : {};
  const from = prefill || {};
  const d = state.data;

  const kinds = ['生鮮', '冷凍食材', '常備', '作り置き'];
  const places = ['冷蔵', 'パーシャル', '冷凍', '常温'];
  const cur = {
    種別: st['種別'] || from.種別 || '生鮮',
    保存場所: st['保存場所'] || from.保存場所 || '冷蔵',
  };

  function seg(key, list) {
    return '<div class="seg" data-stseg="' + key + '">' + list.map(function (v) {
      return '<button data-v="' + esc(v) + '" aria-pressed="' + (cur[key] === v) + '">' + esc(v) + '</button>';
    }).join('') + '</div>';
  }

  openSheet(id ? 'あるものを直す' : 'あるものを足す',
    '<label class="field">種類</label>' + seg('種別', kinds)
    + '<label class="field">名前（押して選ぶ）'
      + '<input type="text" id="sk-search" placeholder="さがす（例：玉）"></label>'
    + '<div class="seg" id="sk-chips" style="max-height:30vh;overflow-y:auto;padding:4px 0"></div>'
    + '<p class="hint" id="sk-picked">（まだ選んでいません）</p>'
    + '<div class="btn-row"><button class="btn small" type="button" id="sk-newtoggle">一覧に無いものを足す</button></div>'
    + '<div id="sk-newbox" hidden>'
      + '<label class="field">名前<input type="text" id="sk-newname" placeholder="ズッキーニ など"></label>'
      + '<label class="field">分類<select id="sk-newkind">'
        + ['ビタミン・ミネラル', 'タンパク質', '炭水化物', 'その他'].map(function (v) {
            return '<option>' + v + '</option>'; }).join('')
        + '</select></label>'
      + '<label class="field">よく買う店<select id="sk-newshop">'
        + ['八百屋', 'ライフ', '近所のスーパー', 'コープ'].map(function (v) {
            return '<option>' + v + '</option>'; }).join('')
        + '</select></label>'
      + '<div class="btn-row"><button class="btn small primary" type="button" id="sk-newadd">この名前を使う</button></div>'
      + '<p class="hint">保存すると、食材の台帳にも入ります。次からは一覧に出ます。</p>'
    + '</div>'
    + '<label class="field">いくつ<input type="number" id="sk-qty" inputmode="numeric" min="0" value="'
      + esc(String(st['id'] ? num(st['残数']) : 1)) + '"></label>'
    + '<label class="field">置き場所</label>' + seg('保存場所', places)
    + '<label class="field">いつまで食べられるか（分かれば）<input type="date" id="sk-useby" value="'
      + esc(String(st['保存期限'] || '').slice(0, 10)) + '"></label>'
    + '<label class="field"><input type="checkbox" id="sk-ready" style="width:auto;margin-right:8px"'
      + (st['調理要否'] === 'そのまま食べられる' ? ' checked' : '') + '>そのまま食べられる</label>'
    + '<label class="field">誰かの取り置きにする（任意）<select id="sk-hold">'
      + '<option value="">みんなのもの</option>'
      + (d.members || []).map(function (m) {
          return '<option value="' + esc(m.id) + '"' + (String(st['取り置き先']) === String(m.id) ? ' selected' : '')
            + '>' + esc(m['名前']) + '</option>';
        }).join('')
      + '</select></label>'
    + '<label class="field">メモ（任意）<input type="text" id="sk-memo" value="' + esc(st['メモ'] || '') + '"></label>'
    + '<div class="btn-row"><button class="btn primary" id="sk-save">保存</button>'
      + (id ? '<button class="btn" id="sk-del">消す</button>' : '') + '</div>');

  let picked = st['名称'] || from.名称 || '';
  let newFood = null;   // 一覧に無くて、その場で足す食材

  // 作り置きの名前はメニュー台帳から選ぶ。
  // 名前がメニューの材料や名前と一致していないと、「予定あり」の判定が効かない。
  function nameChoices() {
    const base = (cur.種別 === '作り置き')
      ? (d.menus || []).map(function (m) { return m['メニュー名']; })
      : (d.foods || []).map(function (f) { return f['食材名']; });
    return newFood ? base.concat([newFood['食材名']]) : base;
  }

  function paintNames() {
    const q = document.getElementById('sk-search').value.trim();
    const seen = {};
    const html = nameChoices().filter(function (n) {
      if (!n || seen[n]) return false;
      seen[n] = true;
      if (q && n.indexOf(q) < 0 && n !== picked) return false;
      return true;
    }).map(function (n) {
      return '<button type="button" data-nm="' + esc(n) + '" aria-pressed="' + (n === picked) + '">'
        + esc(n) + '</button>';
    }).join('');

    const box = document.getElementById('sk-chips');
    box.innerHTML = html || '<span class="hint">見つかりません。下の「一覧に無いものを足す」から足せます。</span>';
    box.querySelectorAll('[data-nm]').forEach(function (b) {
      b.addEventListener('click', function () {
        picked = (picked === b.dataset.nm) ? '' : b.dataset.nm;
        paintNames();
      });
    });
    document.getElementById('sk-picked').textContent = picked || '（まだ選んでいません）';
    // 作り置きは名前がメニュー名なので、その場で足せない
    document.getElementById('sk-newtoggle').hidden = (cur.種別 === '作り置き');
  }

  document.querySelectorAll('[data-stseg]').forEach(function (g) {
    g.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        cur[g.dataset.stseg] = btn.dataset.v;
        g.querySelectorAll('button').forEach(function (x) {
          x.setAttribute('aria-pressed', String(x === btn));
        });
        if (g.dataset.stseg === '種別') paintNames();
      });
    });
  });

  document.getElementById('sk-search').addEventListener('input', paintNames);
  document.getElementById('sk-newtoggle').addEventListener('click', function () {
    const box = document.getElementById('sk-newbox');
    box.hidden = !box.hidden;
  });
  document.getElementById('sk-newadd').addEventListener('click', function () {
    const n = document.getElementById('sk-newname').value.trim();
    if (!n) return toast('名前を入れてください');
    newFood = {
      食材名: n,
      栄養素分類: document.getElementById('sk-newkind').value,
      月齢OK目安: '',
      標準の調達先: document.getElementById('sk-newshop').value,
    };
    picked = n;
    document.getElementById('sk-newbox').hidden = true;
    document.getElementById('sk-search').value = '';
    paintNames();
    toast('「' + n + '」を使います');
  });
  paintNames();

  document.getElementById('sk-save').addEventListener('click', async function () {
    const name = picked;
    if (!name) return toast('名前を選んでください');
    closeSheet();
    // その場で足した食材は、先に台帳へ入れる
    if (newFood && newFood['食材名'] === name) {
      try { await api('addFoods', { rows: [newFood] }); } catch (e) { /* 既にあれば無視 */ }
    }
    const row = {
      id: id || '',
      名称: name,
      種別: cur.種別,
      作った日: st['作った日'] || ymd(new Date()),
      残数: num(document.getElementById('sk-qty').value),
      保存場所: cur.保存場所,
      期限: st['期限'] || '',
      用途: st['用途'] || '自由',
      plan_id: st['plan_id'] || '',
      調理要否: document.getElementById('sk-ready').checked ? 'そのまま食べられる' : '要調理',
      取り置き先: document.getElementById('sk-hold').value,
      メモ: document.getElementById('sk-memo').value,
      食べる予定日: st['食べる予定日'] || '',
      保存期限: document.getElementById('sk-useby').value,
      調理ロット: st['調理ロット'] || '',
    };
    if (!row.id) delete row.id;
    await save('stock', [row]);
    toast(id ? '直しました' : '「' + name + '」を足しました');
  });

  const del = document.getElementById('sk-del');
  if (del) del.addEventListener('click', async function () {
    if (!confirm('この在庫を消します。よろしいですか？')) return;
    closeSheet();
    await api('remove', { sheet: 'stock', ids: [id] });
    await reload();
    toast('消しました');
  });
}

function stockCard(s, me, isReserved) {
  const mark = ngMark(me, s);
  const bits = [];
  if (s['保存場所']) bits.push(s['保存場所']);
  if (useBy(s)) bits.push(shortDate(useBy(s)) + 'まで');
  else if (limitUnknown(s)) bits.push('保存期限は未確認');
  if (s['食べる予定日']) bits.push(shortDate(s['食べる予定日']) + 'に食べる予定');
  if (num(s['残数']) > 1) bits.push('残り' + num(s['残数']));
  if (isReserved && s['plan_id'] && !s['食べる予定日']) {
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
    + (isReserved && !(me && String(s['取り置き先']) === String(me.id))
        ? '<button class="btn small" data-want="' + esc(s['id']) + '">これ食べたい</button>'
        : '<button class="btn small" data-eat="' + esc(s['id']) + '">食べた</button>')
    + '<button class="btn small" data-stockedit="' + esc(s['id']) + '">直す</button>'
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
    if (num(s['残数']) <= 0 || isExpired(s)) return false;
    if (String(s['用途'] || '自由').indexOf('自由') !== 0) return false;
    const f = byKey(d.foods, '食材名', s['名称']);
    if (!f || f['栄養素分類'] !== 'ビタミン・ミネラル') return false;
    return useBy(s) && useBy(s) <= soon;
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
        + '<div class="btn-row"><button class="btn small primary" data-take="' + esc(t['id']) + '">これやる</button></div>'
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

/**
 * 残数は端末で計算せず、サーバーに「1つ食べた」とだけ伝える。
 * 2人が同時に食べても、両方ぶん減る。
 */
async function eatStock(id) {
  try {
    const r = await api('consume', { stockId: id, n: 1 });
    await reload();
    toast('食べた記録をつけました（残り' + r['残数'] + '）');
  } catch (err) {
    toast(err.message);
  }
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
  // 段取りページを開いているときは、そちらを出す
  if (state.cookWeek) return renderCookSheet();

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
    + '<button class="btn primary" id="suggest-month">AIに1ヶ月分を組んでもらう</button>'
    + '</div>'
    + '<div class="btn-row">'
    + '<button class="btn small" id="suggest-rule">ルールで組む（AIを使わない）</button>'
    + '<button class="btn small" id="clear-month">この月を空にする</button>'
    + '</div>';
  h += '<p class="hint">まず自動で埋めて、気になるマスだけ押して差し替えてください。'
    + 'AIは、家族の苦手・最近作ったもの・栄養のかたより・いまの在庫・食費の残りを見て組みます。'
    + '週ごとに分けて呼ぶので、1ヶ月で4〜5回、あわせて数十円くらいです。</p>';

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

/**
 * 週末に、平日昼の5食をまとめて作るための段取り。
 *
 * 順番は、実際に台所で動く順に並べている。
 *   買っておくもの → まとめてやる下ごしらえ → 容器に詰める → 焼く → 冷まして保存 → 在庫に入れる
 *
 * 同じ肉だねを使うもの、同じ野菜を切るもの、同じ温度で焼けるものを
 * ひとまとめにするのが、いちばん時間の効くところ。
 */
function renderCookSheet() {
  const d = state.data;
  const w = String(state.cookWeek).split('|');
  const from = w[0], to = w[1];
  const today = ymd(new Date());
  state.cookDone = state.cookDone || {};

  /* その週の平日昼 */
  const lunches = d.plan.filter(function (p) {
    const day = String(p['日付']).slice(0, 10);
    if (day < from || day > to) return false;
    if (p['食事区分'] !== '昼' || p['状態'] === '変更') return false;
    const dow = new Date(day + 'T00:00:00').getDay();
    return dow !== 0 && dow !== 6;
  }).sort(function (a, b) { return String(a['日付']).localeCompare(String(b['日付'])); });

  let h = '<div class="btn-row" style="margin-top:0">'
    + '<button class="btn" id="cs-back">← 計画にもどる</button></div>';
  h += '<h2 class="section">' + shortDate(from) + '〜' + shortDate(to) + ' の昼ごはんをまとめて作る</h2>';

  if (!lunches.length) {
    h += '<div class="empty">この週の平日昼が入っていません。計画タブで先に決めてください。</div>';
    view(h);
    document.getElementById('cs-back').addEventListener('click', function () {
      state.cookWeek = null; render();
    });
    return;
  }

  const items = lunches.map(function (p) {
    const m = byId(d.menus, p['menu_id']) || {};
    const eatOn = String(p['日付']).slice(0, 10);
    const gap = daysBetween(today, eatOn);
    const partialDays = num(m['日持ちパーシャル']) || 3;
    const frozenDays = num(m['日持ち冷凍']) || 0;
    let place = (gap >= 0 && gap <= partialDays) ? 'パーシャル' : '冷凍';
    if (place === '冷凍' && frozenDays <= 0) place = 'パーシャル';
    return { plan: p, menu: m, eatOn: eatOn, place: place };
  });

  function step(no, title, body, hint) {
    const key = 'step' + no;
    const done = !!state.cookDone[key];
    return '<div class="card"' + (done ? ' style="opacity:.55"' : '') + '>'
      + '<div class="card-row"><div><h3>' + no + '. ' + esc(title) + '</h3>'
      + (hint ? '<div class="meta">' + esc(hint) + '</div>' : '') + '</div>'
      + '<button class="btn small" data-cstep="' + key + '">' + (done ? '戻す' : 'できた') + '</button></div>'
      + '<div style="margin-top:10px">' + body + '</div></div>';
  }

  /* --- 1. 買っておくもの --- */
  const need = {};
  items.forEach(function (it) {
    splitList(it.menu['材料']).forEach(function (f) { need[f] = (need[f] || 0) + 1; });
  });
  const inStock = {};
  d.stock.forEach(function (s) { if (num(s['残数']) > 0) inStock[s['名称']] = true; });
  const buy = Object.keys(need).filter(function (f) { return !inStock[f]; });

  h += step(1, '買っておくもの', buy.length
    ? buy.map(function (f) {
        const info = byKey(d.foods, '食材名', f) || {};
        return '<div class="kv"><span class="k">' + esc(f)
          + (need[f] > 1 ? '（' + need[f] + '品で使う）' : '') + '</span><span>'
          + esc(info['標準の調達先'] || '') + '</span></div>';
      }).join('')
    : '<div class="meta">足りないものはありません。</div>',
    '在庫に無いものだけ出しています');

  /* --- 2. まとめてやる下ごしらえ --- */
  const groups = {};
  items.forEach(function (it) {
    const g = it.menu['共通グループ'];
    if (g) (groups[g] = groups[g] || []).push(it.menu['メニュー名']);
  });
  const shared = Object.keys(need).filter(function (f) { return need[f] >= 2; });

  let prep = '';
  Object.keys(groups).forEach(function (g) {
    if (groups[g].length > 1) {
      prep += '<div class="alert calm"><b>' + esc(g) + '</b>をまとめて作る　→　'
        + esc(groups[g].join('　と　')) + '</div>';
    }
  });
  if (shared.length) {
    prep += '<div class="meta" style="margin-top:6px">2品以上で使う食材は、先にまとめて切っておくと早いです。</div>';
    shared.forEach(function (f) {
      prep += '<div class="kv"><span class="k">' + esc(f) + '</span><span>' + need[f] + '品で使う</span></div>';
    });
  }
  if (!prep) prep = '<div class="meta">まとめてできる下ごしらえはありません。</div>';
  h += step(2, 'まとめてやる下ごしらえ', prep, 'ここがいちばん時間の効くところです');

  /* --- 3. 容器に詰める --- */
  h += step(3, '耐熱ガラス容器に詰める',
    items.map(function (it, i) {
      const dow = new Date(it.eatOn + 'T00:00:00').getDay();
      return '<div class="card" style="padding:10px 12px;margin-bottom:6px">'
        + '<div class="card-row"><div><h3>' + (i + 1) + '　'
        + shortDate(it.eatOn) + '(' + WEEK_LABEL[dow] + ')　' + esc(it.menu['メニュー名'] || '') + '</h3>'
        + '<div class="meta">' + esc(splitList(it.menu['材料']).join('・')) + '</div></div>'
        + '<span class="badge ' + (it.place === '冷凍' ? 'reserved' : 'plain') + '">' + it.place + '</span></div>'
        + (it.menu['手順メモ'] ? '<div class="meta" style="margin-top:6px">' + esc(it.menu['手順メモ']) + '</div>' : '')
        + '</div>';
    }).join(''),
    '1食ずつ、食べる日の順に');

  /* --- 4. 焼く（温度ごと） --- */
  const byTemp = {};
  items.forEach(function (it) {
    const t = num(it.menu['オーブン温度']) || 0;
    const k = t ? (t + '℃') : 'オーブン以外';
    (byTemp[k] = byTemp[k] || []).push(it);
  });
  let bake = '';
  Object.keys(byTemp).sort().forEach(function (k) {
    const g = byTemp[k];
    const mins = g.map(function (it) { return num(it.menu['調理時間']) || 0; }).filter(Boolean);
    const maxMin = mins.length ? Math.max.apply(null, mins) : 0;
    bake += '<div class="alert calm"><b>' + esc(k) + '</b>　' + g.length + '個を同時に'
      + (maxMin ? '　目安 ' + maxMin + '分' : '') + '</div>'
      + g.map(function (it) {
          return '<div class="kv"><span class="k">' + esc(it.menu['メニュー名'] || '') + '</span><span>'
            + (num(it.menu['調理時間']) ? num(it.menu['調理時間']) + '分' : '') + '</span></div>';
        }).join('');
  });
  bake += '<div class="note">魚は汁が出るので、容器を分けるかアルミホイルをかぶせると味が混ざりません。'
    + '厚みで時間が変わるので、いちばん厚いところに火が通っているか確かめてください。</div>';
  h += step(4, 'オーブンで焼く', bake, '同じ温度のものは一緒に入れられます');

  /* --- 5. 冷まして保存 --- */
  const partial = items.filter(function (it) { return it.place === 'パーシャル'; });
  const frozen = items.filter(function (it) { return it.place === '冷凍'; });
  h += step(5, '粗熱をとって保存',
    items.map(function (it) {
      const gap = daysBetween(today, it.eatOn);
      const limit = num(it.menu['日持ちパーシャル']) || 3;
      const dow = new Date(it.eatOn + 'T00:00:00').getDay();
      return '<div class="kv"><span class="k">'
        + shortDate(it.eatOn) + '(' + WEEK_LABEL[dow] + ')　' + esc(it.menu['メニュー名'] || '') + '</span>'
        + '<span><b>' + it.place + '</b>　'
        + (it.place === 'パーシャル'
            ? gap + '日後（パーシャルは' + limit + '日まで）'
            : gap + '日後（パーシャルの' + limit + '日を超える）')
        + '</span></div>';
    }).join('')
    + '<div class="note">焼き上がったら長く室温に置かず、粗熱がとれたらすぐ入れてください。'
      + '冷凍にした分は、食べる前日の夜に冷蔵庫へ移します（「今日」タブに出ます）。'
      + '<br><br>パーシャルにする日数は、メニュー台帳の「日持ちパーシャル」で決まります。'
      + 'もっと早めに冷凍したいときは、その数を小さくしてください。'
      + '日持ちは目安です。怪しいと感じたら食べずに処分してください。</div>',
    '食べる日までの日数と、メニューごとの日持ちで決めています');

  /* --- 6. 在庫に入れる --- */
  h += step(6, '在庫に入れる',
    '<div class="meta">押すと' + items.length + '食が在庫に入り、保存期限も入ります。'
      + '同じ予定にすでに入っているものは足しません。</div>'
    + '<div class="btn-row"><button class="btn primary" id="cs-cook">作ったので在庫に入れる</button></div>',
    'ここまで終わったら');

  view(h);

  document.getElementById('cs-back').addEventListener('click', function () {
    state.cookWeek = null; render();
  });
  document.querySelectorAll('[data-cstep]').forEach(function (b) {
    b.addEventListener('click', function () {
      const k = b.dataset.cstep;
      state.cookDone[k] = !state.cookDone[k];
      render();
    });
  });
  document.getElementById('cs-cook').addEventListener('click', function () {
    cookLunches(from, to);
  });
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

  h += '<div class="btn-row">'
    + '<button class="btn primary" data-cooksheet="' + days[0] + '|' + days[6] + '">まとめて作る段取りを見る</button>'
    + '<button class="btn" data-cook="' + days[0] + '|' + days[6] + '">作ったので在庫に入れる</button>'
    + '</div>';
  return h;
}

function bindPlanEvents(weeks) {
  const month = state.month;
  const first = month + '-01';
  const last = monthEnd(month);
  // 表示は週単位でまたぐが、変更の対象はその月の中だけに限る。
  // weeks の端を使うと、9月を空にしたつもりで8月末や10月頭まで消えてしまう。
  const from = first;
  const to = last;

  document.getElementById('prev-month').addEventListener('click', function () {
    state.month = addMonths(first, -1).slice(0, 7);
    render();
  });
  document.getElementById('next-month').addEventListener('click', function () {
    state.month = addMonths(first, 1).slice(0, 7);
    render();
  });

  // その月にかかる各週を、月の範囲に切りそろえる
  const parts = weeks.map(function (w) {
    return { from: w[0] < first ? first : w[0], to: w[6] > last ? last : w[6] };
  }).filter(function (w) { return w.from <= w.to; });

  const sm = document.getElementById('suggest-month');
  sm.addEventListener('click', async function () {
    if (!confirm('AIに' + Number(month.slice(5, 7)) + '月の献立を組んでもらいます。\n'
      + '週ごとに' + parts.length + '回に分けて呼びます（数十円ほど）。\n'
      + 'いまの' + Number(month.slice(5, 7)) + '月の献立は置き換わります。よろしいですか？')) return;

    sm.disabled = true;
    const notes = [];
    let ok = 0, ng = 0;
    for (let i = 0; i < parts.length; i++) {
      const w = parts[i];
      toast((i + 1) + '/' + parts.length + '週目（' + shortDate(w.from) + '〜）を組んでいます…');
      try {
        const r = await api('planWeekAI', { from: w.from, to: w.to });
        ok++;
        if (r['考えたこと']) notes.push(shortDate(w.from) + '〜：' + r['考えたこと']);
      } catch (err) {
        ng++;
        notes.push(shortDate(w.from) + '〜：組めませんでした（' + err.message + '）');
      }
    }
    sm.disabled = false;
    await reload();
    toast(ok + '週ぶんを入れました' + (ng ? '（' + ng + '週は失敗）' : ''));
    if (notes.length) alert('AIが考えたこと\n\n' + notes.join('\n\n'));
  });

  document.getElementById('suggest-rule').addEventListener('click', async function () {
    if (!confirm('AIを使わず、決まったルールだけで組みます。よろしいですか？')) return;
    try {
      const r = await api('suggestWeek', { from: from, to: to });
      await reload();
      toast(r['入れた件数'] + '件を入れました');
    } catch (err) { toast('組めませんでした：' + err.message); }
  });

  document.getElementById('clear-month').addEventListener('click', async function () {
    if (!confirm(Number(month.slice(5, 7)) + '月（' + shortDate(from) + '〜' + shortDate(to)
      + '）の献立をすべて消します。前後の月はそのままです。よろしいですか？')) return;
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
  document.querySelectorAll('[data-cooksheet]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.cookWeek = b.dataset.cooksheet;
      state.cookDone = {};
      window.scrollTo(0, 0);
      render();
    });
  });
  document.querySelectorAll('[data-cook]').forEach(function (b) {
    b.addEventListener('click', function () {
      const w = b.dataset.cook.split('|');
      cookLunches(w[0], w[1]);
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
      h += '<button class="pick" data-del="' + esc(p['id']) + '">' + esc(menuName(p['menu_id']))
        + '<div class="meta">押すと外します</div></button>';
    });
  }

  h += '<p class="hint" style="margin-top:14px">'
    + (replaceMode
        ? (existing.length ? '押すと差し替えます' : '選んでください')
        : '追加する')
    + '</p>';

  // 一覧に無いものは、その場で書いて入れられるようにする
  h += '<button class="pick" id="pick-free"><b>自分で書いて入れる</b>'
    + '<div class="meta">一覧に無いものを、その場で足します</div></button>';

  list.forEach(function (m) {
    h += '<button class="pick" data-add="' + esc(m['id']) + '">' + esc(m['メニュー名'])
      + '<div class="meta">' + esc([m['区分'], m['調理器具'], m['調理時間'] ? m['調理時間'] + '分' : ''].filter(Boolean).join('・')) + '</div></button>';
  });

  openSheet(shortDate(day) + '(' + WEEK_LABEL[dow] + ') の' + slot, h);

  document.querySelectorAll('[data-add]').forEach(function (b2) {
    b2.addEventListener('click', async function () {
      closeSheet();
      try {
        if (replaceMode) {
          // 「外す」と「入れる」を分けると、途中で失敗して空になる。1回で入れ替える。
          await api('replaceSlot', { date: day, slot: slot, menu_ids: [b2.dataset.add] });
        } else {
          const ids = existing.map(function (p) { return p['menu_id']; }).concat([b2.dataset.add]);
          await api('replaceSlot', { date: day, slot: slot, menu_ids: ids });
        }
        await reload();
        toast(replaceMode && existing.length ? '差し替えました' : '入れました');
      } catch (err) {
        toast('入れられませんでした：' + err.message);
      }
    });
  });
  document.querySelectorAll('[data-del]').forEach(function (b2) {
    b2.addEventListener('click', async function () {
      closeSheet();
      const rest = existing
        .filter(function (p) { return p['id'] !== b2.dataset.del; })
        .map(function (p) { return p['menu_id']; });
      await api('replaceSlot', { date: day, slot: slot, menu_ids: rest });
      await reload();
      toast('外しました');
    });
  });

  document.getElementById('pick-free').addEventListener('click', function () {
    freeMenu(day, slot, replaceMode ? existing : []);
  });
}

/**
 * 一覧に無い献立を、その場で足す。
 *
 * 材料は必ず食材マスタから選ぶ。自由入力にすると
 * 「豚ロース」「豚ロース肉」「豚ろーす」が別物になり、
 * 買い物リストも「どうぞ／予定あり」の判定も崩れるため。
 *
 * メニュー名を入れて「AIに下書きしてもらう」を押すと、
 * 材料・分量入りの作り方・器具・日持ちの目安が埋まる。
 * 違うところは人が直す。直した結果はそのまま台帳に残るので、次から候補に出る。
 */
function freeMenu(day, slot, toReplace) {
  const d = state.data;
  const dow = day ? new Date(day + 'T00:00:00').getDay() : 0;
  const chosen = {};          // 選んだ食材
  let newFoods = [];          // AIが提案した、まだ台帳に無い食材

  function chipHtml(filter) {
    const q = String(filter || '').trim();
    const rows = (d.foods || []).map(function (f) { return { 食材名: f['食材名'], 新: false }; })
      .concat(newFoods.map(function (f) { return { 食材名: f['食材名'], 新: true }; }));
    const seen = {};
    return rows.filter(function (r) {
      if (seen[r.食材名]) return false;
      seen[r.食材名] = true;
      if (q && r.食材名.indexOf(q) < 0 && !chosen[r.食材名]) return false;
      return true;
    }).map(function (r) {
      return '<button type="button" data-food="' + esc(r.食材名) + '" aria-pressed="'
        + (!!chosen[r.食材名]) + '">' + esc(r.食材名) + (r.新 ? '＋' : '') + '</button>';
    }).join('');
  }

  function paintChips() {
    const box = document.getElementById('fm-chips');
    if (!box) return;
    box.innerHTML = chipHtml(document.getElementById('fm-search').value);
    box.querySelectorAll('[data-food]').forEach(function (b) {
      b.addEventListener('click', function () {
        const n = b.dataset.food;
        if (chosen[n]) delete chosen[n]; else chosen[n] = true;
        b.setAttribute('aria-pressed', String(!!chosen[n]));
        paintCount();
      });
    });
    paintCount();
  }
  function paintCount() {
    const el = document.getElementById('fm-count');
    if (el) el.textContent = Object.keys(chosen).length ? Object.keys(chosen).join('、') : '（まだ選んでいません）';
  }
  function setSeg(key, v) {
    const g = document.querySelector('[data-fmseg="' + key + '"]');
    if (!g) return;
    g.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.v === v));
    });
  }
  function getSeg(key) {
    const g = document.querySelector('[data-fmseg="' + key + '"]');
    const on = g && g.querySelector('[aria-pressed="true"]');
    return on ? on.dataset.v : '';
  }
  function seg(key, list, cur) {
    return '<div class="seg" data-fmseg="' + key + '">' + list.map(function (v) {
      return '<button type="button" data-v="' + esc(v) + '" aria-pressed="' + (cur === v) + '">' + esc(v) + '</button>';
    }).join('') + '</div>';
  }

  openSheet(day ? (shortDate(day) + '(' + WEEK_LABEL[dow] + ') の' + slot + '　自分で足す') : 'メニューを足す',
    '<label class="field">つくるもの<input type="text" id="fm-name" placeholder="唐揚げ、肉じゃが など"></label>'
    + '<div class="btn-row"><button class="btn primary" id="fm-ai">AIに下書きしてもらう</button></div>'
    + '<p class="hint" id="fm-status">メニュー名を入れて押すと、材料と作り方の下書きが入ります。'
      + 'そのあと自由に直せます。</p>'

    + '<label class="field">区分</label>' + seg('区分', ['主菜', '副菜', '汁物'], '主菜')
    + '<label class="field">いつ食べる</label>' + seg('時間帯', ['昼', '夜', '両方'], slot === '昼' ? '昼' : '夜')

    + '<label class="field">材料（食材の名前を押して選ぶ）'
      + '<input type="text" id="fm-search" placeholder="さがす（例：豚）"></label>'
    + '<div class="seg" id="fm-chips" style="max-height:34vh;overflow-y:auto;padding:4px 0"></div>'
    + '<p class="hint" id="fm-count">（まだ選んでいません）</p>'

    + '<label class="field">作り方（2人分の分量つき）<textarea id="fm-memo"></textarea></label>'
    + '<label class="field">調理器具<input type="text" id="fm-tool" placeholder="オーブン、フライパン など"></label>'
    + '<label class="field">調理時間（分）<input type="number" id="fm-min" inputmode="numeric"></label>'
    + '<label class="field">冷凍</label>' + seg('冷凍可', ['はい', 'いいえ'], 'いいえ')
    + '<label class="field">冷凍から作れるか</label>' + seg('解凍要否', ['不要', '要'], '要')
    + '<div class="note">日持ちの日数はAIが出した目安です。'
      + '実際は食材や冷まし方で変わるので、怪しいときは食べずに処分してください。</div>'
    + '<div class="btn-row" style="margin-top:6px">'
      + '<label class="field" style="margin:0">冷蔵<input type="number" id="fm-k1" inputmode="numeric" style="width:5rem"></label>'
      + '<label class="field" style="margin:0">パーシャル<input type="number" id="fm-k2" inputmode="numeric" style="width:5rem"></label>'
      + '<label class="field" style="margin:0">冷凍<input type="number" id="fm-k3" inputmode="numeric" style="width:5rem"></label>'
    + '</div>'

    + '<div class="btn-row"><button class="btn primary" id="fm-save">'
      + (day ? '入れる' : '台帳に足す') + '</button></div>');

  paintChips();
  document.getElementById('fm-search').addEventListener('input', paintChips);

  /* --- AIに下書きしてもらう --- */
  document.getElementById('fm-ai').addEventListener('click', async function () {
    const name = document.getElementById('fm-name').value.trim();
    if (!name) return toast('つくるものを書いてください');
    const btn = this;
    const status = document.getElementById('fm-status');
    btn.disabled = true;
    status.textContent = 'AIが考えています…（10秒ほど）';
    try {
      const r = await api('draftMenu', { name: name, slot: slot || '' });

      newFoods = (r['新しい食材'] || []).filter(function (f) { return f && f['食材名']; });
      (r['材料'] || []).forEach(function (m) { chosen[m] = true; });
      paintChips();

      setSeg('区分', r['区分'] || '主菜');
      setSeg('時間帯', r['時間帯'] || '夜');
      setSeg('冷凍可', r['冷凍可'] || 'いいえ');
      setSeg('解凍要否', r['解凍要否'] || '要');
      document.getElementById('fm-memo').value = r['手順メモ'] || '';
      document.getElementById('fm-tool').value = r['調理器具'] || '';
      document.getElementById('fm-min').value = r['調理時間'] || '';
      document.getElementById('fm-k1').value = r['日持ち冷蔵'] || '';
      document.getElementById('fm-k2').value = r['日持ちパーシャル'] || '';
      document.getElementById('fm-k3').value = r['日持ち冷凍'] || '';

      const bits = ['下書きが入りました。違うところは直してください。'];
      if (newFoods.length) {
        bits.push('新しい食材（' + newFoods.map(function (f) { return f['食材名']; }).join('、')
          + '）は「＋」付きで出ています。選んで保存すると食材の台帳にも入ります。');
      }
      if ((r['不明な材料'] || []).length) {
        bits.push('※ 台帳に無い材料が混ざっていました：' + r['不明な材料'].join('、'));
      }
      status.textContent = bits.join(' ');
    } catch (err) {
      status.textContent = '下書きできませんでした：' + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  /* --- 保存 --- */
  document.getElementById('fm-save').addEventListener('click', async function () {
    const name = document.getElementById('fm-name').value.trim();
    if (!name) return toast('つくるものを書いてください');
    const mats = Object.keys(chosen);
    if (!mats.length && !confirm('材料を選んでいません。このまま保存しますか？')) return;
    closeSheet();

    try {
      // 選んだ中に新しい食材があれば、先に食材の台帳へ
      const add = newFoods.filter(function (f) { return chosen[f['食材名']]; });
      if (add.length) await api('addFoods', { rows: add });

      const exist = byKey(state.data.menus, 'メニュー名', name);
      const row = {
        id: exist ? exist.id : '',
        メニュー名: name,
        区分: getSeg('区分') || '主菜',
        時間帯: getSeg('時間帯') || '夜',
        材料: mats.join(','),
        調理器具: document.getElementById('fm-tool').value.trim(),
        オーブン温度: exist ? exist['オーブン温度'] : '',
        調理時間: num(document.getElementById('fm-min').value) || '',
        冷凍可: getSeg('冷凍可') || 'いいえ',
        解凍要否: getSeg('解凍要否') || '要',
        日持ち冷蔵: num(document.getElementById('fm-k1').value) || '',
        日持ちパーシャル: num(document.getElementById('fm-k2').value) || '',
        日持ち冷凍: num(document.getElementById('fm-k3').value) || '',
        共通グループ: exist ? exist['共通グループ'] : '',
        参考URL: exist ? exist['参考URL'] : '',
        手順メモ: document.getElementById('fm-memo').value,
      };
      if (!row.id) delete row.id;
      const saved = await api('upsert', { sheet: 'menus', rows: [row] });
      const menuId = saved[0].id;

      if (day) {
        const keep = (toReplace && toReplace.length)
          ? []
          : state.data.plan.filter(function (p) {
              return String(p['日付']).slice(0, 10) === day && p['食事区分'] === slot && p['状態'] !== '変更';
            }).map(function (p) { return p['menu_id']; });
        await api('replaceSlot', { date: day, slot: slot, menu_ids: keep.concat([menuId]) });
      }
      await reload();
      toast('「' + name + '」を保存しました');
    } catch (err) {
      toast('保存できませんでした：' + err.message);
    }
  });
}

/**
 * 週末に作った昼の分を在庫に入れる。
 *
 * 保存場所と保存期限はサーバー側で決める（作った日から食べる日までの間隔と、
 * メニューごとの日持ちを見る）。同じ予定にすでに作り置きがあれば作らないので、
 * 二度押しや通信の再送でも二重にならない。
 */
async function cookLunches(from, to) {
  try {
    toast('在庫に入れています…');
    const r = await api('cookLunches', { from: from, to: to, cookedOn: ymd(new Date()) });
    await reload();
    let msg = r['入れた件数'] + '食を在庫に入れました';
    if (r['すでにあった件数']) msg += '（' + r['すでにあった件数'] + '食はすでに入っていました）';
    toast(msg);
    if (r['注意'] && r['注意'].length) {
      alert('気をつけること\n\n' + r['注意'].join('\n'));
    }
  } catch (err) {
    toast('入れられませんでした：' + err.message);
  }
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
  document.querySelectorAll('[data-tostock]').forEach(function (b) {
    b.addEventListener('click', function () { editStock(null, { 名称: b.dataset.tostock }); });
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
          + '<div class="btn-row"><button class="btn small primary" data-arrive="' + esc(o['id']) + '|到着">届いた</button>'
          + '<button class="btn small" data-arrive="' + esc(o['id']) + '|欠品">欠品だった</button></div></div>';
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
        + '</div><button class="btn small" data-bought="' + esc(r['id']) + '">' + (done ? '戻す' : '買った') + '</button>'
        + '</div>'
        + '<div class="btn-row"><button class="btn small" data-tostock="' + esc(r['食材名']) + '">在庫に入れる</button></div>'
        + '</div>';
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

/** コープの注文を「到着」か「欠品」にする。在庫への反映もサーバー側でまとめて行う。 */
async function arriveOrder(arg) {
  const parts = arg.split('|');
  try {
    await api('arriveOrder', { orderId: parts[0], state: parts[1] });
    await reload();
    toast(parts[1] === '到着' ? '在庫に入れました' : 'スーパーの買い物リストに移しました');
  } catch (err) {
    toast('できませんでした：' + err.message);
  }
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
 *
 * 「何日あけるべきか」はこのアプリでは判断しない。
 * 初めて食べた日と、最後に食べた日を、事実として並べるだけにする。
 */
const KEY_ALLERGENS = {
  '卵': '卵', '牛乳': '乳', 'プレーンヨーグルト': '乳', 'カッテージチーズ': '乳',
  '粉チーズ': '乳', 'プロセスチーズ': '乳', '溶けるチーズ': '乳',
  'うどん': '小麦', 'そうめん': '小麦', 'マカロニ': '小麦', 'スパゲティ': '小麦',
  '中華めん': '小麦', '食パン': '小麦', 'ロールパン': '小麦', '麸': '小麦',
  'えび': 'えび', '桜えび': 'えび',
};

/**
 * 離乳食の記録から、食材ごとの「初めて食べた日」と「最後に食べた日」を求める。
 *
 * 「予定」と「拒否」は食べていないので数えない。
 * 記録を直したり消したりすれば、ここも自動で変わる（別に持たないため）。
 */
/**
 * 離乳食の材料。
 * 新しい記録は [{"食材":"食パン","量":20,"単位":"g"}] の形で持つ。
 * 古い「食パン、牛乳」の形も読めるようにしておく（量は空になる）。
 */
function babyMats(v) {
  if (!v) return [];
  const t = String(v).trim();
  if (t.charAt(0) === '[') {
    try {
      const a = JSON.parse(t);
      if (Array.isArray(a)) return a.filter(function (m) { return m && m['食材']; });
    } catch (e) { /* 古い形として読む */ }
  }
  return splitList(t).map(function (n) { return { 食材: n, 量: '', 単位: '' }; });
}
function babyMatNames(v) {
  return babyMats(v).map(function (m) { return m['食材']; }).filter(Boolean);
}

/** 栄養素の分類ごとの重さ。本の表と同じ3分類で数える。 */
const BABY_CLASS = ['炭水化物', 'ビタミン・ミネラル', 'タンパク質', 'その他'];
const BABY_CLASS_COLOR = {
  '炭水化物': '#d9a441',
  'ビタミン・ミネラル': '#6f9160',
  'タンパク質': '#c2703f',
  'その他': '#b0a89f',
};

function babyNutrition(logs) {
  const cls = {};
  (state.data.baby_foods || []).forEach(function (f) { cls[f['食材名']] = f['大分類']; });

  const sums = {};
  BABY_CLASS.forEach(function (k) { sums[k] = 0; });
  let total = 0, skipped = 0;

  logs.forEach(function (b) {
    if (b['食べた量'] === '予定' || b['食べた量'] === '拒否') return;
    babyMats(b['材料']).forEach(function (m) {
      const unit = String(m['単位'] || 'g');
      const g = (unit === 'g') ? num(m['量']) : 0;
      if (!g) { if (m['食材']) skipped++; return; }
      const k = cls[m['食材']] || 'その他';
      sums[k] = (sums[k] || 0) + g;
      total += g;
    });
  });
  return { sums: sums, total: total, skipped: skipped };
}

/** 重さの割合のドーナツ。外部の部品は使わずSVGで描く。 */
function babyDonut(sums, total) {
  const R = 54, r = 33, cx = 70, cy = 70;
  if (!total) return '';

  const used = BABY_CLASS.filter(function (k) { return sums[k] > 0; });
  let svg = '<svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="栄養バランスの割合">';

  if (used.length === 1) {
    // 1種類だけのときは円弧が描けないので、輪をそのまま描く
    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + ((R + r) / 2) + '" fill="none"'
      + ' stroke="' + BABY_CLASS_COLOR[used[0]] + '" stroke-width="' + (R - r) + '"/>';
  } else {
    let acc = 0;
    used.forEach(function (k) {
      const a0 = acc / total * Math.PI * 2 - Math.PI / 2;
      acc += sums[k];
      const a1 = acc / total * Math.PI * 2 - Math.PI / 2;
      const big = (a1 - a0) > Math.PI ? 1 : 0;
      const P = function (rad, ang) {
        return (cx + rad * Math.cos(ang)).toFixed(2) + ' ' + (cy + rad * Math.sin(ang)).toFixed(2);
      };
      svg += '<path d="M' + P(R, a0) + ' A' + R + ' ' + R + ' 0 ' + big + ' 1 ' + P(R, a1)
        + ' L' + P(r, a1) + ' A' + r + ' ' + r + ' 0 ' + big + ' 0 ' + P(r, a0) + ' Z"'
        + ' fill="' + BABY_CLASS_COLOR[k] + '"/>';
    });
  }

  svg += '<text x="70" y="66" text-anchor="middle" font-size="22" font-weight="700" fill="currentColor">'
    + total + '</text>'
    + '<text x="70" y="86" text-anchor="middle" font-size="10" fill="currentColor" opacity=".6">'
    + '離乳食の合計g</text></svg>';
  return svg;
}

function babyFoodHistory() {
  const out = {};
  (state.data.baby_log || []).forEach(function (b) {
    const amount = b['食べた量'];
    if (amount === '予定' || amount === '拒否') return; // 実際には食べていない
    const day = String(b['日付'] || '').slice(0, 10);
    if (!day) return;
    babyMatNames(b['材料']).forEach(function (f) {
      const rec = out[f] || (out[f] = { first: day, last: day, count: 0 });
      if (day < rec.first) rec.first = day;
      if (day > rec.last) rec.last = day;
      rec.count++;
    });
  });
  return out;
}

/** その日時点での月齢 */
function ageOfOn(birth, on) {
  const bd = new Date(String(birth).slice(0, 10) + 'T00:00:00');
  const n = new Date(String(on).slice(0, 10) + 'T00:00:00');
  let months = (n.getFullYear() - bd.getFullYear()) * 12 + (n.getMonth() - bd.getMonth());
  if (n.getDate() < bd.getDate()) months--;
  const anchor = new Date(bd);
  anchor.setMonth(anchor.getMonth() + months);
  const days = Math.floor((n - anchor) / 86400000);
  let stage = '';
  if (months >= 12) stage = '完了期';
  else if (months >= 9) stage = '後期';
  else if (months >= 7) stage = '中期';
  else if (months >= 5) stage = '初期';
  return { months: months, days: days, stage: stage };
}

const BABY_SLOTS = ['朝', '昼', '夕', 'おやつ'];
const BABY_CLASS_MARK = { '炭水化物': '炭', 'ビタミン・ミネラル': 'ビ', 'タンパク質': 'タ', 'その他': '他' };

function renderBaby() {
  const d = state.data;
  const baby = d.members.find(function (m) { return m['区分'] === '乳児'; });
  if (!baby || !baby['誕生日']) {
    return view('<div class="empty">設定タブで赤ちゃんの誕生日を入れると、月齢と段階が出ます。</div>');
  }

  const day = state.babyDate || ymd(new Date());
  state.babyDate = day;
  const a = ageOfOn(baby['誕生日'], day);
  const key = stageKey(a.months);
  const today = ymd(new Date());
  const all = d.baby_foods || [];
  const cls = {};
  all.forEach(function (f) { cls[f['食材名']] = f['大分類']; });

  /* --- 日付の行き来 --- */
  let h = '<div class="seg" style="margin-bottom:10px">'
    + '<button id="bd-prev" aria-label="前の日">←</button>'
    + '<button aria-pressed="true">' + shortDate(day) + '（' + WEEK_LABEL[new Date(day + 'T00:00:00').getDay()] + '）</button>'
    + '<button id="bd-next" aria-label="次の日">→</button>'
    + (day !== today ? '<button id="bd-today">今日へ</button>' : '')
    + '</div>';
  h += '<p class="hint">生後' + a.months + 'か月' + a.days + '日'
    + (a.stage ? '　' + a.stage + '（' + key + 'カ月ごろ）' : '　離乳食はまだ先です') + '</p>';

  /* --- その日の記録を、食事ごとに --- */
  const logs = d.baby_log.filter(function (b) { return String(b['日付']).slice(0, 10) === day; });

  BABY_SLOTS.forEach(function (slot) {
    const rows = logs.filter(function (b) { return b['食事区分'] === slot; });
    if (!rows.length) return;

    const slotGram = babyNutrition(rows).total;
    h += '<h2 class="section">' + slot + (slotGram ? '　<span class="badge plain">' + slotGram + 'g</span>' : '') + '</h2>';

    rows.forEach(function (b) {
      const mats = babyMats(b['材料']);
      const gram = babyNutrition([b]).total;
      const firsts = {};
      splitList(b['はじめて食材']).forEach(function (n) { firsts[n] = true; });
      const mood = { 'ごきげん': '☺', 'ふつう': '・', 'ぐずり': '☹' }[b['機嫌']] || '';

      h += '<div class="card"><div class="card-row"><div>'
        + '<h3>' + esc(b['メニュー名']) + '</h3>'
        + '<div class="meta">' + (gram ? gram + 'g　' : '') + esc(mood ? mood + ' ' + b['機嫌'] : '') + '</div>'
        + '</div><span class="badge ' + (b['食べた量'] === '完食' ? 'free' : 'plain') + '">'
        + esc(b['食べた量'] || '') + '</span></div>';

      if (mats.length) {
        h += '<div style="margin-top:8px">';
        mats.forEach(function (m) {
          const k = cls[m['食材']] || 'その他';
          h += '<div class="kv" style="align-items:center">'
            + '<span class="k"><span class="badge plain" style="min-width:1.6em;text-align:center">'
              + esc(BABY_CLASS_MARK[k] || '他') + '</span> ' + esc(m['食材'])
              + (firsts[m['食材']] ? ' <span class="badge free">はじめて</span>' : '') + '</span>'
            + '<span>' + esc(m['量'] !== '' && m['量'] !== undefined ? m['量'] + (m['単位'] || 'g') : '—') + '</span>'
            + '</div>';
        });
        h += '</div>';
      }

      if (b['参考URL']) {
        h += '<div class="btn-row"><a class="btn small" href="' + esc(b['参考URL'])
          + '" target="_blank" rel="noopener">参考にしたレシピ</a></div>';
      }
      if (b['メモ']) h += '<div class="note">' + esc(b['メモ']) + '</div>';
      h += '<div class="btn-row"><button class="btn small" data-babyedit="' + esc(b['id']) + '">編集</button></div>';
      h += '</div>';
    });
  });

  if (!logs.length) {
    h += '<div class="empty">' + shortDate(day) + 'の記録はまだありません。</div>';
  }

  h += '<div class="btn-row"><button class="btn primary" id="baby-add">記録する</button></div>';
  h += '<p class="hint">押した時点でスプレッドシートに書き込まれます。'
    + 'あとでまとめて保存ではないので、途中でアプリを閉じても消えません。</p>';

  /* --- ミルクと栄養バランス --- */
  const milk = logs.reduce(function (n, b) { return n + num(b['ミルクml']); }, 0);
  const nut = babyNutrition(logs);

  if (nut.total || milk) {
    h += '<h2 class="section">栄養バランス（重さの割合）</h2>';
    h += '<div class="card"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">'
      + '<div>' + babyDonut(nut.sums, nut.total) + '</div>'
      + '<div style="flex:1;min-width:11rem">'
      + BABY_CLASS.filter(function (k) { return nut.sums[k] > 0; }).map(function (k) {
          const pct = Math.round(nut.sums[k] / nut.total * 100);
          return '<div class="kv"><span class="k">'
            + '<span style="display:inline-block;width:.7em;height:.7em;border-radius:50%;background:'
            + BABY_CLASS_COLOR[k] + ';margin-right:6px"></span>' + esc(k) + '</span>'
            + '<span>' + pct + '%　' + nut.sums[k] + 'g</span></div>';
        }).join('')
      + (milk ? '<div class="kv"><span class="k">このあとのミルク</span><span>' + milk + 'ml</span></div>' : '')
      + '</div></div>';
    if (nut.skipped) {
      h += '<div class="note">「適量」など重さにできない材料 ' + nut.skipped + '件は、合計に入れていません。</div>';
    }
    h += '</div>';
  }

  /* --- 市販ベビーフードのストック --- */
  const bfs = d.stock.filter(function (s) { return s['種別'] === '市販BF'; });
  const bfLeft = bfs.filter(function (s) { return num(s['残数']) > 0; });

  h += '<h2 class="section">市販ベビーフードのストック</h2>';
  if (!bfLeft.length) {
    h += '<div class="empty">まだありません。買ったものを足しておくと、残りがひと目で分かります。</div>';
  } else {
    bfLeft.sort(function (x, y) {
      return String(x['期限'] || '9999').localeCompare(String(y['期限'] || '9999'));
    }).forEach(function (s) {
      const bits = [];
      if (s['メモ']) bits.push(s['メモ']);
      if (s['期限']) bits.push(shortDate(s['期限']) + 'まで');
      const soon = s['期限'] && String(s['期限']).slice(0, 10) <= addDays(today, 14);
      h += '<div class="card"><div class="card-row"><div>'
        + '<h3>' + esc(s['名称']) + '</h3>'
        + (bits.length ? '<div class="meta">' + esc(bits.join('・')) + '</div>' : '')
        + '</div><span class="badge ' + (soon ? 'warn' : 'plain') + '">残り' + num(s['残数']) + '</span></div>'
        + '<div class="btn-row">'
        + '<button class="btn small primary" data-bfgive="' + esc(s['id']) + '">これをあげた</button>'
        + '<button class="btn small" data-bfedit="' + esc(s['id']) + '">直す</button>'
        + '</div></div>';
    });
  }
  h += '<div class="btn-row"><button class="btn" id="bf-add">買ったものを足す</button></div>';

  /* --- 食べた記録（初回と直近） --- */
  const hist = babyFoodHistory();
  const tracked = all.filter(function (f) {
    return KEY_ALLERGENS[f['食材名']] && (hist[f['食材名']] || f['初めて食べた日']);
  }).sort(function (x, y) {
    const hx = hist[x['食材名']], hy = hist[y['食材名']];
    return String(hy ? hy.last : '').localeCompare(String(hx ? hx.last : ''));
  });

  if (tracked.length) {
    h += '<h2 class="section">食べた記録（卵・乳・小麦・えび）</h2>';
    h += '<p class="hint">初めて食べた日と、最後に食べた日を並べているだけです。'
      + '何日あけるべきかの判断はしていません。'
      + '気になるときは、かかりつけ医や健診で相談してください。</p>';
    tracked.forEach(function (f) {
      const name = f['食材名'];
      const rec = hist[name];
      const checked = String(f['初めて食べた日'] || '').slice(0, 10);
      let meta, right;
      if (rec) {
        // チェックリストの初回が記録より前なら、そちらが本当の初回
        const first = (checked && checked < rec.first) ? checked : rec.first;
        meta = '初回 ' + shortDate(first)
          + (first !== rec.first ? '（チェックのみ）' : '')
          + '／直近 ' + shortDate(rec.last) + '（記録' + rec.count + '回）';
        const gap = daysBetween(rec.last, today);
        right = '<span class="badge plain">' + (gap >= 0 ? '直近から' + gap + '日' : 'これから') + '</span>';
      } else {
        // 初回の印だけがある。直近は分からないので推測しない。
        meta = '初回 ' + shortDate(checked) + '　その後の記録はありません';
        right = '<span class="badge plain">初回のみ</span>';
      }
      h += '<div class="card"><div class="card-row"><div>'
        + '<h3>' + esc(name) + '</h3>'
        + '<div class="meta">' + esc(KEY_ALLERGENS[name]) + '・' + esc(meta) + '</div>'
        + '</div>' + right + '</div></div>';
    });
  }

  /* --- はじめての食材 --- */
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
          h += '<div class="card"><div class="card-row"><div>'
            + '<h3>' + esc(f['食材名']) + '</h3>'
            + '<div class="meta">' + esc(String(f[look])) + (f[look + '形状'] ? '　' + esc(f[look + '形状']) : '') + '</div>'
            + '</div>'
            + (key ? '<button class="btn small" data-firsttry="' + esc(f['食材名']) + '">はじめて食べた</button>' : '')
            + '</div></div>';
        });
      });
    }

    if (done.length) {
      const names = done.map(function (f) {
        return f['食材名'] + (hist[f['食材名']] ? '' : '（初回のみ）');
      });
      h += '<h2 class="section">食べたことがあるもの（' + done.length + '）</h2>';
      h += '<div class="card"><div class="meta">' + esc(names.join('、')) + '</div></div>';
    }
  }

  /* --- 気をつける食材・記号 --- */
  if ((d.baby_ng || []).length) {
    h += '<h2 class="section">気をつける食材</h2>';
    d.baby_ng.forEach(function (n) {
      h += '<div class="alert">' + esc(n['区分']) + '：' + esc(n['食材']) + '</div>';
    });
  }
  if ((d.baby_legend || []).length) {
    h += '<h2 class="section">記号の見方</h2><div class="card">';
    d.baby_legend.forEach(function (l) {
      h += '<div class="kv"><span class="k">' + esc(l['記号']) + '</span>'
        + '<span style="flex:1;text-align:left">' + esc(l['意味']) + '</span></div>';
    });
    h += '</div>';
  }

  h += '<div class="note">食材の一覧は『365日の離乳食カレンダー』の103食材チェックリストをもとにしています。'
    + 'あくまで目安で、このアプリは医学的な判断をしません。'
    + 'アレルギーの既往や湿疹があるとき、迷ったときは、かかりつけ医や健診で相談してください。</div>';

  view(h);

  const prev = document.getElementById('bd-prev');
  if (prev) prev.addEventListener('click', function () { state.babyDate = addDays(day, -1); render(); });
  const next = document.getElementById('bd-next');
  if (next) next.addEventListener('click', function () { state.babyDate = addDays(day, 1); render(); });
  const tdy = document.getElementById('bd-today');
  if (tdy) tdy.addEventListener('click', function () { state.babyDate = today; render(); });

  document.querySelectorAll('[data-firsttry]').forEach(function (b) {
    b.addEventListener('click', function () { recordFirstTry(b.dataset.firsttry); });
  });
  document.getElementById('baby-add').addEventListener('click', function () { editBabyLog(null); });
  document.querySelectorAll('[data-babyedit]').forEach(function (b) {
    b.addEventListener('click', function () { editBabyLog(b.dataset.babyedit); });
  });
  document.getElementById('bf-add').addEventListener('click', function () { editBabyFood(null); });
  document.querySelectorAll('[data-bfedit]').forEach(function (b) {
    b.addEventListener('click', function () { editBabyFood(b.dataset.bfedit); });
  });
  document.querySelectorAll('[data-bfgive]').forEach(function (b) {
    b.addEventListener('click', function () {
      const st = byId(state.data.stock, b.dataset.bfgive);
      if (st) editBabyLog(null, { name: st['名称'], stockId: st['id'] });
    });
  });
}

/**
 * 離乳食の記録を足す・直す。
 *
 * 材料は食材の一覧から選び、量と単位を入れる。
 * 重さ（g）で入れたものだけが栄養バランスの割合に入る。
 * 保存を押した時点でスプレッドシートに書き込む（端末に貯めておかない）。
 */
function editBabyLog(id, prefill) {
  const b = id ? (byId(state.data.baby_log, id) || {}) : {};
  const from = prefill || {};
  const foods = state.data.baby_foods || [];
  const units = ['g', 'ml', '大さじ', '小さじ', '個', '適量'];

  let mats = babyMats(b['材料']);
  if (!mats.length) mats = [{ 食材: '', 量: '', 単位: 'g' }];

  const picked = {
    slot: b['食事区分'] || from.slot || '昼',
    amount: b['食べた量'] || '完食',
    mood: b['機嫌'] || 'ごきげん',
  };

  function seg(name, list, cur) {
    return '<div class="seg" data-seg="' + name + '">' + list.map(function (v) {
      return '<button type="button" data-v="' + esc(v) + '" aria-pressed="' + (cur === v) + '">'
        + esc(v) + '</button>';
    }).join('') + '</div>';
  }

  function matRow(m, i) {
    return '<div class="card" style="padding:10px 12px" data-matrow="' + i + '">'
      + '<div style="display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap">'
      + '<label class="field" style="margin:0;flex:2;min-width:9rem">食材'
        + '<select data-mat="食材">'
        + '<option value="">（選ぶ）</option>'
        + foods.map(function (f) {
            return '<option value="' + esc(f['食材名']) + '"'
              + (f['食材名'] === m['食材'] ? ' selected' : '') + '>' + esc(f['食材名']) + '</option>';
          }).join('')
        + '</select></label>'
      + '<label class="field" style="margin:0;flex:1;min-width:4.5rem">量'
        + '<input type="number" inputmode="decimal" data-mat="量" value="' + esc(String(m['量'] || '')) + '"></label>'
      + '<label class="field" style="margin:0;flex:1;min-width:5rem">単位'
        + '<select data-mat="単位">'
        + units.map(function (u) {
            return '<option' + ((m['単位'] || 'g') === u ? ' selected' : '') + '>' + u + '</option>';
          }).join('')
        + '</select></label>'
      + '</div>'
      + '<div class="btn-row"><button class="btn small" type="button" data-matdel="' + i + '">この材料を消す</button></div>'
      + '</div>';
  }

  function paintMats() {
    const box = document.getElementById('b-mats');
    box.innerHTML = mats.map(matRow).join('');
    box.querySelectorAll('[data-matdel]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        mats.splice(Number(btn.dataset.matdel), 1);
        if (!mats.length) mats = [{ 食材: '', 量: '', 単位: 'g' }];
        paintMats();
      });
    });
    box.querySelectorAll('[data-matrow]').forEach(function (row) {
      const i = Number(row.dataset.matrow);
      row.querySelectorAll('[data-mat]').forEach(function (el) {
        el.addEventListener('change', function () { mats[i][el.dataset.mat] = el.value; });
      });
    });
  }

  openSheet(id ? '記録を直す' : '離乳食の記録',
    '<label class="field">いつ<input type="date" id="b-date" value="'
      + esc(String(b['日付'] || state.babyDate || ymd(new Date())).slice(0, 10)) + '"></label>'
    + '<label class="field">食事</label>' + seg('slot', BABY_SLOTS, picked.slot)
    + '<label class="field">メニュー<input type="text" id="b-menu" value="'
      + esc(b['メニュー名'] || from.name || '') + '" placeholder="鮭ペーストのパンがゆ など"></label>'
    + (from.stockId ? '<p class="hint">保存すると、市販ベビーフードの残りが1つ減ります。</p>' : '')
    + '<label class="field">参考にしたレシピ（任意）<input type="url" id="b-url" value="'
      + esc(b['参考URL'] || '') + '" placeholder="https://..."></label>'

    + '<label class="field">材料</label>'
    + '<div id="b-mats"></div>'
    + '<div class="btn-row"><button class="btn small" type="button" id="b-matadd">＋ 材料を追加</button></div>'
    + '<p class="hint">重さ（g）で入れたものが、栄養バランスの割合に入ります。'
      + '「適量」など重さにできないものは合計に含めません。</p>'

    + '<label class="field">どれくらい食べたか</label>' + seg('amount', ['予定', '拒否', '少し', '半分', '完食'], picked.amount)
    + '<p class="hint">「予定」と「拒否」は食べていないので、初めて食べた日には数えません。</p>'
    + '<label class="field">機嫌</label>' + seg('mood', ['ごきげん', 'ふつう', 'ぐずり'], picked.mood)
    + '<label class="field">このあとのミルク（ml・任意）<input type="number" id="b-milk" inputmode="numeric" value="'
      + esc(String(b['ミルクml'] || '')) + '"></label>'
    + '<label class="field">メモ・様子<textarea id="b-memo">' + esc(b['メモ'] || '') + '</textarea></label>'
    + '<div class="btn-row"><button class="btn primary" id="b-save">保存</button>'
      + (id ? '<button class="btn" id="b-del">削除</button>' : '') + '</div>');

  paintMats();
  document.getElementById('b-matadd').addEventListener('click', function () {
    mats.push({ 食材: '', 量: '', 単位: 'g' });
    paintMats();
  });

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
    const date = document.getElementById('b-date').value;

    const clean = mats.filter(function (m) { return m['食材']; }).map(function (m) {
      return { 食材: m['食材'], 量: m['量'] === '' ? '' : num(m['量']), 単位: m['単位'] || 'g' };
    });

    // 「予定」と「拒否」は食べていないので、初めて食べた日には数えない
    const ate = picked.amount !== '予定' && picked.amount !== '拒否';
    const before = babyFoodHistory();
    const firsts = ate
      ? clean.map(function (m) { return m['食材']; }).filter(function (f) { return !before[f]; })
      : [];

    closeSheet();

    const row = {
      id: id || '',
      日付: date,
      食事区分: picked.slot,
      メニュー名: menu,
      参考URL: document.getElementById('b-url').value.trim(),
      材料: JSON.stringify(clean),
      はじめて食材: firsts.join('、'),
      食べた量: picked.amount,
      機嫌: picked.mood,
      メモ: document.getElementById('b-memo').value,
      ミルクml: num(document.getElementById('b-milk').value) || '',
    };
    if (!row.id) delete row.id;

    try {
      await api('upsert', { sheet: 'baby_log', rows: [row] });

      // 初めて食べた食材は、103食材のチェックリスト側にも日付を入れる
      const marks = [];
      firsts.forEach(function (name) {
        const f = byKey(state.data.baby_foods, '食材名', name);
        if (f && !f['初めて食べた日']) { f['初めて食べた日'] = date; marks.push(f); }
      });
      if (marks.length) await api('upsert', { sheet: 'baby_foods', rows: marks });

      if (from.stockId && ate) {
        const st = byId(state.data.stock, from.stockId);
        if (st && num(st['残数']) > 0) await api('consume', { stockId: from.stockId, n: 1 });
      }

      state.babyDate = date;
      await reload();
      toast(firsts.length ? '記録しました（はじめて：' + firsts.join('、') + '）' : '記録しました');
    } catch (err) {
      toast('保存できませんでした：' + err.message);
    }
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

/**
 * 市販ベビーフードのストックを足す・直す。
 * 在庫シートに 種別「市販BF」として入れ、取り置き先を赤ちゃんにするので
 * 大人の「どうぞ」には出ない。
 */
function editBabyFood(id) {
  const st = id ? (byId(state.data.stock, id) || {}) : {};
  const baby = state.data.members.find(function (m) { return m['区分'] === '乳児'; }) || {};

  openSheet(id ? '市販ベビーフードを直す' : '買ったものを足す',
    '<label class="field">商品名<input type="text" id="bf-name" value="' + esc(st['名称'] || '')
      + '" placeholder="○○の野菜スープ 7か月から など"></label>'
    + '<label class="field">個数<input type="number" id="bf-qty" inputmode="numeric" min="0" value="'
      + esc(String(num(st['残数']) || 1)) + '"></label>'
    + '<label class="field">賞味期限（任意）<input type="date" id="bf-exp" value="'
      + esc(String(st['期限'] || '').slice(0, 10)) + '"></label>'
    + '<label class="field">メモ（月齢の表示など・任意）<input type="text" id="bf-memo" value="'
      + esc(st['メモ'] || '') + '" placeholder="7か月から"></label>'
    + '<div class="btn-row"><button class="btn primary" id="bf-save">保存</button>'
      + (id ? '<button class="btn" id="bf-del">消す</button>' : '') + '</div>');

  document.getElementById('bf-save').addEventListener('click', async function () {
    const name = document.getElementById('bf-name').value.trim();
    if (!name) return toast('商品名を入れてください');
    closeSheet();
    const row = {
      id: id || '',
      名称: name,
      種別: '市販BF',
      作った日: st['作った日'] || ymd(new Date()),
      残数: num(document.getElementById('bf-qty').value),
      保存場所: '常温',
      期限: document.getElementById('bf-exp').value,
      用途: '自由',
      plan_id: '',
      調理要否: 'そのまま食べられる',
      取り置き先: baby.id || '',
      メモ: document.getElementById('bf-memo').value,
    };
    if (!row.id) delete row.id;
    await save('stock', [row]);
    toast('保存しました');
  });

  const del = document.getElementById('bf-del');
  if (del) del.addEventListener('click', async function () {
    if (!confirm('この行を消します。よろしいですか？')) return;
    closeSheet();
    await api('remove', { sheet: 'stock', ids: [id] });
    await reload();
    toast('消しました');
  });
}

async function recordFirstTry(name) {
  const f = byKey(state.data.baby_foods, '食材名', name);
  if (!f) return;
  f['初めて食べた日'] = ymd(new Date());
  await save('baby_foods', [f]);
  toast(name + 'に印を付けました');
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
      h += '<button data-me="' + esc(m.id) + '" aria-pressed="' + (cfg.me === m.id) + '">' + esc(m['名前']) + '</button>';
    });
    h += '</div>';

    h += '<h2 class="section">家族の設定</h2>';
    state.data.members.forEach(function (m) {
      h += '<div class="card"><div class="card-row"><div>'
        + '<h3>' + esc(m['名前']) + '</h3>'
        + '<div class="meta">' + esc(m['区分']) + (m['誕生日'] ? '・' + shortDate(m['誕生日']) : '') + '</div>'
        + '</div><button class="btn small" data-editmember="' + esc(m.id) + '">直す</button></div></div>';
    });

    h += '<h2 class="section">苦手な食材</h2>'
      + '<p class="hint">自分の分を入れてください。△は「少量なら食べられる」です。'
      + '献立の提案に効くのは ○ △ × だけです。'
      + 'メモは人が読むための覚え書きで、いまは提案には使われていません。</p>';
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
        + '<div class="btn-row"><button class="btn small" data-voice="' + esc(v['id']) + '">状態と返信</button></div>'
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
    h += '<button class="pick" data-pickme="' + esc(m.id) + '">' + esc(m['名前'])
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
