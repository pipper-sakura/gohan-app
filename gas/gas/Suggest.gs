/**
 * Suggest.gs — 1週間分の献立を自動で組む
 *
 * 使う人は「提案されたものを直す」だけで済むようにする。
 * 空のマスを1つずつ選ぶのは、直したいときだけ。
 *
 * いまはルールで組んでいる（無料・すぐ返る）。
 * Claude API を入れたら、この関数の中身を差し替えれば画面はそのまま使える。
 *
 * 守っているルール（ChatGPTの「献立」プロジェクトの運用に合わせたもの）
 *   ・昼は平日5食のみ。週末の昼は作らない
 *   ・昼はオーブンで一括調理でき、魚は冷凍のまま焼けるものだけ
 *   ・夜は毎日。主菜・副菜・汁物を1つずつ
 *   ・鍋のように2日続けて食べるものは、木・金に置く
 *   ・同じ食材が同じ日の昼と夜で重ならないようにする
 *   ・家族の誰かが「×」にしている食材を含むメニューは出さない
 *   ・前にNGにした組み合わせ（メニュー×時間帯）は出さない
 *   ・最近作っていないものから順に選ぶ
 */

/**
 * 期間の指定を検証する。
 * 画面の不具合や打ち間違いで、意図しない範囲を消してしまうのを防ぐ。
 */
function checkRange_(from, to) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const a = String(from || '').slice(0, 10);
  const b = String(to || '').slice(0, 10);
  if (!re.test(a) || !re.test(b)) throw new Error('日付の形式が正しくありません: ' + a + '〜' + b);
  if (a > b) throw new Error('開始日が終了日より後です: ' + a + '〜' + b);
  if (daysBetween_(a, b) > 62) throw new Error('一度に扱えるのは62日までです: ' + a + '〜' + b);
  return { from: a, to: b };
}

/** payload: {from, to} */
function h_suggestWeek(p) {
  const r = checkRange_(p.from, p.to);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return suggestWeek(r.from, r.to);
  } finally {
    lock.releaseLock();
  }
}

/** payload: {from, to} その期間の予定をすべて消す */
function h_clearWeek(p) {
  const r = checkRange_(p.from, p.to);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const before = readSheet_('plan').filter(function (p) { return inRange_(p['日付'], r.from, r.to); }).length;
    replacePlanRange_(r.from, r.to, []);
    return { removed: before };
  } finally {
    lock.releaseLock();
  }
}

/**
 * その期間の予定を、渡した内容で置き換える。
 * 「先に消す」をやめたので、途中で失敗しても元の献立が残る。
 */
function replacePlanRange_(from, to, newRows) {
  const all = readSheet_('plan');
  const keep = all.filter(function (p) { return !inRange_(p['日付'], from, to); });
  const add = newRows.map(function (r) {
    r.id = r.id || newId_();
    r['更新日時'] = new Date();
    return r;
  });
  writeSheetRows_('plan', keep.concat(add));
  return { 残した件数: keep.length, 入れた件数: add.length };
}

function clearPlanRange_(from, to) {
  const ids = readSheet_('plan')
    .filter(function (p) { return inRange_(p['日付'], from, to); })
    .map(function (p) { return p['id']; });
  if (ids.length) h_remove({ sheet: 'plan', ids: ids });
  return ids.length;
}

/**
 * 期間内の献立を組む。1週間でも1ヶ月でも同じ関数で動く。
 *
 * 1ヶ月だとメニューの数が足りないので、「二度と出さない」ではなく
 * 「一定の日数をあけて順に回す」やり方にしている。
 */
function suggestWeek(from, to) {
  const menus = readSheet_('menus');
  // 先に消さない。組み終わってから、1回の書き込みで置き換える。
  const allPlans = readSheet_('plan');
  const replaced = allPlans.filter(function (p) { return inRange_(p['日付'], from, to); }).length;
  const history = allPlans.filter(function (p) { return !inRange_(p['日付'], from, to); });

  /* --- 誰かが「×」にしている食材 --- */
  const banned = {};
  readSheet_('prefs').forEach(function (p) {
    if (p['評価'] === '×') banned[p['食材名']] = true;
  });

  /* --- 前にNGにした（メニュー × 時間帯） --- */
  const ng = {};
  readSheet_('feedback').forEach(function (f) {
    if (f['判定'] === 'NG') ng[f['menu_id'] + '|' + f['時間帯']] = true;
  });

  /* --- 最後に作った日。無ければ「ずっと前」として扱う --- */
  const lastAt = {};
  history.forEach(function (p) {
    const d = String(p['日付']).slice(0, 10);
    if (!lastAt[p['menu_id']] || d > lastAt[p['menu_id']]) lastAt[p['menu_id']] = d;
  });
  function lastOf(m) { return lastAt[m['id']] || '0000-00-00'; }

  function usable(m, slot) {
    if (ng[m['id'] + '|' + slot]) return false;
    const t = m['時間帯'];
    if (t && t !== '両方' && t !== slot) return false;
    return splitList_(m['材料']).every(function (f) { return !banned[f]; });
  }

  /* --- 候補 --- */
  // 昼：オーブンで一括調理でき、冷凍のまま焼けるもの
  const lunchMains = menus.filter(function (m) {
    return m['区分'] === '主菜' && usable(m, '昼')
      && String(m['調理器具']).indexOf('オーブン') >= 0
      && m['解凍要否'] === '不要';
  });
  const dinnerMains = menus.filter(function (m) { return m['区分'] === '主菜' && usable(m, '夜'); });
  const sides = menus.filter(function (m) { return m['区分'] === '副菜' && usable(m, '夜'); });
  const soups = menus.filter(function (m) { return m['区分'] === '汁物' && usable(m, '夜'); });
  // 2日続けて食べるもの（鍋・シチュー）
  const twoDayMenus = dinnerMains.filter(function (m) {
    return String(m['手順メモ']).indexOf('2日分') >= 0;
  });

  /* --- 日付 --- */
  const days = [];
  for (let d = String(from).slice(0, 10); d <= String(to).slice(0, 10); d = addDays_(d, 1)) {
    days.push({ date: d, dow: new Date(d + 'T00:00:00+09:00').getDay() });
  }

  const rows = [];
  const ingredientsByDay = {};

  function note(date, m) {
    lastAt[m['id']] = date;
    const set = ingredientsByDay[date] || (ingredientsByDay[date] = {});
    splitList_(m['材料']).forEach(function (f) { set[f] = true; });
  }
  function add(date, slot, m) {
    rows.push({ 日付: date, 食事区分: slot, member_id: '', menu_id: m['id'], 状態: '予定' });
    note(date, m);
  }
  function clashes(date, m) {
    const set = ingredientsByDay[date] || {};
    return splitList_(m['材料']).some(function (f) { return set[f]; });
  }
  function gapDays(m, date) {
    const l = lastOf(m);
    if (l === '0000-00-00') return 9999;
    return daysBetween_(l, date);
  }

  /**
   * 最後に作ったのが一番古いものから順に見て、
   * ①間隔があいていて、その日の食材ともぶつからないもの → ②間隔だけ満たすもの → ③一番古いもの
   */
  function choose(list, date, minGap) {
    const sorted = list.slice().sort(function (a, b) {
      return String(lastOf(a)).localeCompare(String(lastOf(b)));
    });
    for (let i = 0; i < sorted.length; i++) {
      if (gapDays(sorted[i], date) >= minGap && !clashes(date, sorted[i])) return sorted[i];
    }
    for (let i = 0; i < sorted.length; i++) {
      if (gapDays(sorted[i], date) >= minGap) return sorted[i];
    }
    return sorted[0] || null;
  }

  /* --- 1. 平日の昼（週末に一括で作る分） --- */
  days.forEach(function (d) {
    if (d.dow === 0 || d.dow === 6) return; // 土日の昼は作らない
    const m = choose(lunchMains, d.date, 6);
    if (m) add(d.date, '昼', m);
  });

  /* --- 2. 木曜は隔週で鍋。金曜も同じものを2日目として食べる --- */
  const hotpotDays = {};
  const thursdays = days.filter(function (d) { return d.dow === 4; });
  thursdays.forEach(function (thu, i) {
    if (i % 2 !== 0 || !twoDayMenus.length) return;
    const m = choose(twoDayMenus, thu.date, 0);
    if (!m) return;
    add(thu.date, '夜', m);
    hotpotDays[thu.date] = true;

    const fri = addDays_(thu.date, 1);
    if (days.some(function (d) { return d.date === fri; })) {
      rows.push({ 日付: fri, 食事区分: '夜', member_id: '', menu_id: m['id'], 状態: '予定' });
      note(fri, m);
      hotpotDays[fri] = true;
    }
  });

  /* --- 3. 残りの日の夜の主菜 --- */
  days.forEach(function (d) {
    if (hotpotDays[d.date]) return;
    const pool = dinnerMains.filter(function (m) { return twoDayMenus.indexOf(m) < 0; });
    const m = choose(pool.length ? pool : dinnerMains, d.date, 8);
    if (m) add(d.date, '夜', m);
  });

  /* --- 4. 夜の副菜と汁物。鍋の日は付けない（それだけで足りる） --- */
  days.forEach(function (d) {
    if (hotpotDays[d.date]) return;
    const side = choose(sides, d.date, 5);
    if (side) add(d.date, '夜', side);
    const soup = choose(soups, d.date, 4);
    if (soup) add(d.date, '夜', soup);
  });

  replacePlanRange_(from, to, rows);

  return {
    置き換えた件数: replaced,
    入れた件数: rows.length,
    昼の候補数: lunchMains.length,
    夜の候補数: dinnerMains.length,
    メモ: '朝は候補がまだないので空のままです。決まったらメニューを「朝」で登録してください。',
  };
}

/** 2つの日付の差（日数） */
function daysBetween_(from, to) {
  const a = new Date(String(from).slice(0, 10) + 'T00:00:00+09:00');
  const b = new Date(String(to).slice(0, 10) + 'T00:00:00+09:00');
  return Math.round((b - a) / 86400000);
}

/* ------------------------------------------------------------------ */
/* ChatGPTで決まっていた 8/29〜8/31 の計画                              */
/* ------------------------------------------------------------------ */

/**
 * 9月に入る前の3日分だけを入れる。
 * 9/1以降は September.gs の seedSeptember を使う（そちらのほうが新しい）。
 * GASエディタで seedAugustTail を1回実行する。
 */
function seedAugustTail() {
  const P = [
    ['2026-08-29', '夜', 'y1'],  // 豚ロースの焼肉たれ＋ポン酢炒め
    ['2026-08-29', '夜', 'f1'],  // れんこんのおかか醤油
    ['2026-08-29', '夜', 's1'],  // じゃがいもと玉ねぎの味噌汁

    ['2026-08-30', '夜', 'y2'],  // 鮭のクリーム煮
    ['2026-08-30', '夜', 'f2'],  // ほうれん草のおひたし

    ['2026-08-31', '昼', 'u1'],  // 豚ロースのにんにく醤油焼き＋じゃがいも
    ['2026-08-31', '夜', 'y3'],  // ミートソースパスタ
    ['2026-08-31', '夜', 'f3'],  // ラタトゥイユ
    ['2026-08-31', '夜', 's4'],  // 玉ねぎポタージュ
  ];

  replacePlanRange_('2026-08-29', '2026-08-31', P.map(function (r) {
    return { 日付: r[0], 食事区分: r[1], member_id: '', menu_id: r[2], 状態: '予定' };
  }));

  SpreadsheetApp.getUi().alert(
    '8/29〜8/31 の計画を入れました（' + P.length + '件）。\n'
    + '9/1以降は seedSeptember を実行してください。'
  );
}
