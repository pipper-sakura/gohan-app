/**
 * Domain.gs — このアプリの中心にあるルール
 *
 * 1. 献立を確定したら、在庫に「予定あり／自由」を付け直す
 * 2. 平日昼の5食に、パーシャルと冷凍を自動で振り分ける
 * 3. 週の献立から買い物リストを作る（食材／昼のメニュー／夜のメニュー の3列）
 */

/* ------------------------------------------------------------------ */
/* 1. 在庫の「予定あり／自由」                                          */
/* ------------------------------------------------------------------ */

/**
 * 期間内の献立を見て、在庫の用途を付け直す。
 *
 * 考え方：
 *   ・作り置き（完成品）は、それ自体が誰かの食事なので「予定あり」
 *   ・肉・魚・卵・豆腐など主役の食材は、使われると献立が崩れるので「予定あり」
 *   ・野菜や常備品は、少し使われても計画は崩れないので「自由」のまま。
 *     ただし献立でも使う予定があることは「自由（献立でも使用）」として伝える
 *
 * 量を持たない設計なので、機械的に全部ロックすると
 * 「使っていいものが何も無い」画面になってしまう。それを避けるための線引き。
 */
function reserveStockForPlan(from, to) {
  const plans = readSheet_('plan');
  const inWindow = plans.filter(function (p) {
    return inRange_(p['日付'], from, to) && p['状態'] !== '変更';
  });
  const planById = indexBy_(plans, 'id');
  const menus = indexBy_(readSheet_('menus'), 'id');
  const foods = indexBy_(readSheet_('foods'), '食材名');

  // この期間の献立で使う「メニュー」と「食材」
  const plannedMenu = {};   // menu_id -> plan_id
  const plannedFood = {};   // 食材名 -> plan_id
  inWindow.forEach(function (p) {
    const m = menus[p['menu_id']];
    if (!m) return;
    if (!plannedMenu[p['menu_id']]) plannedMenu[p['menu_id']] = p['id'];
    splitList_(m['材料']).forEach(function (f) {
      if (!plannedFood[f]) plannedFood[f] = p['id'];
    });
  });

  const stock = readSheet_('stock');
  const updates = [];

  stock.forEach(function (s) {
    // 市販ベビーフードは献立とは別に管理するので触らない
    if (s['種別'] === '市販BF') return;

    // すでに別の週の予定に紐づいている在庫は、そのまま守る。
    // ここを見ないと「今週を反映」で来週用の作り置きが自由に戻ってしまう。
    const holder = s['plan_id'] ? planById[s['plan_id']] : null;
    if (holder && !inRange_(holder['日付'], from, to)) return;

    const before = s['用途'];
    const beforePlan = s['plan_id'];

    if (s['種別'] === '作り置き') {
      // 作り置きは、作ったときに結び付けた plan_id で判断する。
      // 名前で結び直すと、同じ料理が複数日にあるときに取り違える。
      if (holder) {
        s['用途'] = '予定あり';
      } else {
        s['用途'] = '自由';
        s['plan_id'] = '';
      }
    } else if (plannedFood[s['名称']] && isMainIngredient_(s['名称'], foods)) {
      s['用途'] = '予定あり';
      s['plan_id'] = plannedFood[s['名称']];
    } else if (plannedFood[s['名称']]) {
      s['用途'] = '自由（献立でも使用）';
      s['plan_id'] = '';
    } else {
      s['用途'] = '自由';
      s['plan_id'] = '';
    }

    if (s['用途'] !== before || s['plan_id'] !== beforePlan) updates.push(s);
  });

  if (updates.length) writeSheetRows_('stock', stock);
  return { updated: updates.length };
}

/* ------------------------------------------------------------------ */
/* 週末に作った昼の分を在庫へ入れる（R03・R06）                          */
/* ------------------------------------------------------------------ */

/**
 * payload: {from, to, cookedOn}
 *
 * ・保存場所は「作った日から食べる日までの間隔」と、メニューごとの日持ちで決める。
 *   並び順の先頭2件をパーシャルにする、という決め方をやめた。
 * ・食べる予定日と保存期限を別々に持つ。予定日を先へ動かしても期限は延びない。
 * ・同じ予定にすでに作り置きがあれば作らない。二度押しや再送で二重にならない。
 */
function h_cookLunches(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const r = checkRange_(p.from, p.to);
    const cookedOn = String(p.cookedOn || '').slice(0, 10) ||
      Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

    const menus = indexBy_(readSheet_('menus'), 'id');
    const stock = readSheet_('stock');

    const already = {};
    stock.forEach(function (s) {
      if (s['種別'] === '作り置き' && s['plan_id']) already[String(s['plan_id'])] = true;
    });

    const lunches = readSheet_('plan').filter(function (pl) {
      if (!inRange_(pl['日付'], r.from, r.to)) return false;
      if (pl['食事区分'] !== '昼' || pl['状態'] === '変更') return false;
      const dow = new Date(String(pl['日付']).slice(0, 10) + 'T00:00:00+09:00').getDay();
      return dow !== 0 && dow !== 6;
    }).sort(function (x, y) {
      return String(x['日付']).localeCompare(String(y['日付']));
    });

    const added = [];
    const warnings = [];

    lunches.forEach(function (pl) {
      if (already[String(pl['id'])]) return; // すでに作ってある
      const m = menus[pl['menu_id']] || {};
      const eatOn = String(pl['日付']).slice(0, 10);
      const gap = daysBetween_(cookedOn, eatOn);

      const partialDays = Number(m['日持ちパーシャル']) || 3;
      const frozenDays = Number(m['日持ち冷凍']) || 0;

      // パーシャルで間に合う範囲ならパーシャル、間に合わなければ冷凍
      let place = (gap >= 0 && gap <= partialDays) ? 'パーシャル' : '冷凍';
      if (place === '冷凍' && frozenDays <= 0) {
        // 冷凍できないメニュー。パーシャルのまま置くが、注意を返す
        place = 'パーシャル';
        warnings.push(eatOn + ' ' + (m['メニュー名'] || '') + '：冷凍できないので早めに食べてください');
      }
      const keepDays = place === 'パーシャル' ? partialDays : frozenDays;
      const useBy = addDays_(cookedOn, keepDays);

      if (eatOn > useBy) {
        warnings.push(eatOn + ' ' + (m['メニュー名'] || '') + '：食べる予定日が保存期限（' + useBy + '）を過ぎています');
      }

      added.push({
        id: newId_(),
        名称: m['メニュー名'] || '',
        種別: '作り置き',
        作った日: cookedOn,
        残数: 1,
        保存場所: place,
        期限: '',                 // 古い列は使わない
        用途: '予定あり',
        plan_id: pl['id'],
        調理要否: '要調理',
        取り置き先: pl['member_id'] || '',
        メモ: '',
        食べる予定日: eatOn,
        保存期限: useBy,
        調理ロット: cookedOn,
        更新日時: new Date(),
      });
    });

    if (added.length) writeSheetRows_('stock', stock.concat(added));
    return { 入れた件数: added.length, すでにあった件数: lunches.length - added.length, 注意: warnings };
  } finally {
    lock.releaseLock();
  }
}

/**
 * payload: {orderId, state}
 * コープの注文を「到着」または「欠品」にする。
 * 同じ注文から二重に在庫を作らないよう、調理ロットに注文IDを残す。
 */
function h_arriveOrder(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const orders = readSheet_('orders');
    let order = null;
    for (let i = 0; i < orders.length; i++) {
      if (String(orders[i]['id']) === String(p.orderId)) { order = orders[i]; break; }
    }
    if (!order) throw new Error('その注文が見つかりません');
    if (['到着', '欠品'].indexOf(p.state) < 0) throw new Error('状態が正しくありません');

    const tag = 'order:' + order['id'];

    if (p.state === '到着') {
      const stock = readSheet_('stock');
      const dup = stock.some(function (s) { return String(s['調理ロット']) === tag; });
      if (!dup) {
        stock.push({
          id: newId_(), 名称: order['商品名'], 種別: '生鮮',
          作った日: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'),
          残数: Number(order['数量']) || 1, 保存場所: '冷蔵', 期限: '',
          用途: '自由', plan_id: '', 調理要否: '要調理', 取り置き先: '',
          メモ: '', 食べる予定日: '', 保存期限: '', 調理ロット: tag, 更新日時: new Date(),
        });
        writeSheetRows_('stock', stock);
      }
    } else {
      h_upsert({ sheet: 'shopping', rows: [{ 食材名: order['商品名'], 調達先: 'ライフ', 買った: '' }] });
    }

    order['状態'] = p.state;
    writeSheetRows_('orders', orders);
    return { 状態: p.state };
  } finally {
    lock.releaseLock();
  }
}

/** 主役の食材か（使われると献立が崩れるか） */
function isMainIngredient_(name, foods) {
  const f = foods[name];
  if (!f) return false;
  return f['栄養素分類'] === 'タンパク質';
}

/* ------------------------------------------------------------------ */
/* 2. 平日昼5食の保存場所                                              */
/* ------------------------------------------------------------------ */

/**
 * 明日の昼の分で、冷凍から冷蔵へ移すべきものを返す。
 * トップ画面の「今日やること」に出す。
 */
function thawTonight(today) {
  const tomorrow = addDays_(today, 1);
  return readSheet_('stock').filter(function (s) {
    return s['保存場所'] === '冷凍'
      && s['種別'] === '作り置き'
      && Number(s['残数']) > 0
      && String(s['食べる予定日']).slice(0, 10) === tomorrow;
  });
}

/* ------------------------------------------------------------------ */
/* 3. 買い物リスト                                                     */
/* ------------------------------------------------------------------ */

/**
 * 期間内の献立から買い物リストを作り直す。
 * 出力は「食材／昼で使うメニュー／夜で使うメニュー」の3列。分量は出さない。
 * すでに在庫にあるものは除く。
 */
function buildShoppingList(from, to) {
  const plans = readSheet_('plan').filter(function (p) {
    return inRange_(p['日付'], from, to) && p['状態'] !== '変更';
  });
  const menus = indexBy_(readSheet_('menus'), 'id');
  const foods = indexBy_(readSheet_('foods'), '食材名');

  // 期限が切れているものは「ある」と数えない。買い物から漏れてしまうため。
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const inStock = {};
  readSheet_('stock').forEach(function (s) {
    if (Number(s['残数']) <= 0) return;
    const useBy = String(s['保存期限'] || '').slice(0, 10);
    if (useBy && useBy < todayStr) return;
    inStock[s['名称']] = true;
  });

  // 食材ごとに、昼と夜のメニュー名を集める
  const byFood = {};
  plans.forEach(function (p) {
    const m = menus[p['menu_id']];
    if (!m) return;
    const slot = p['食事区分'];
    splitList_(m['材料']).forEach(function (food) {
      if (!byFood[food]) byFood[food] = { 昼: [], 夜: [], 朝: [] };
      const list = byFood[food][slot];
      if (list && list.indexOf(m['メニュー名']) === -1) list.push(m['メニュー名']);
    });
  });

  const rows = Object.keys(byFood)
    .filter(function (food) { return !inStock[food]; })
    .map(function (food) {
      const f = foods[food] || {};
      const g = byFood[food];
      return {
        食材名: food,
        '昼で使うメニュー': g['昼'].join('、'),
        '夜で使うメニュー': g['夜'].concat(g['朝']).join('、'),
        調達先: f['標準の調達先'] || 'スーパー',
        買った: '',
      };
    });

  // 八百屋 → スーパー → コープ の順に並べる（野菜は八百屋を先に見るため）
  const order = { 八百屋: 0, ライフ: 1, スーパー: 1, '近所のスーパー': 2, コープ: 3 };
  rows.sort(function (a, b) {
    const d = (order[a.調達先] === undefined ? 9 : order[a.調達先])
            - (order[b.調達先] === undefined ? 9 : order[b.調達先]);
    return d !== 0 ? d : String(a.食材名).localeCompare(String(b.食材名), 'ja');
  });

  // 作り直しても、買った印と、手で足した行は残す。
  // 全部消すと、買い物の途中で作り直したときにチェックが飛んでしまう。
  const before = readSheet_('shopping');
  const bought = {};
  const manual = [];
  before.forEach(function (r) {
    if (r['買った']) bought[r['食材名']] = r['買った'];
    if (r['手で追加']) manual.push(r);
  });

  rows.forEach(function (r) {
    if (bought[r['食材名']]) r['買った'] = bought[r['食材名']];
  });

  const seen = {};
  rows.forEach(function (r) { seen[r['食材名']] = true; });
  manual.forEach(function (r) { if (!seen[r['食材名']]) rows.push(r); });

  clearSheetRows_('shopping');
  return h_upsert({ sheet: 'shopping', rows: rows });
}

/* ------------------------------------------------------------------ */
/* 小さな道具                                                          */
/* ------------------------------------------------------------------ */

function indexBy_(rows, key) {
  const o = {};
  rows.forEach(function (r) { o[String(r[key])] = r; });
  return o;
}

/** 「豚ロース,玉ねぎ」→ ['豚ロース','玉ねぎ']（全角読点も区切りとして扱う） */
function splitList_(v) {
  if (!v) return [];
  return String(v).split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function inRange_(d, from, to) {
  const s = String(d).slice(0, 10);
  return s >= String(from).slice(0, 10) && s <= String(to).slice(0, 10);
}

function addDays_(ymd, n) {
  const d = new Date(String(ymd).slice(0, 10) + 'T00:00:00+09:00');
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function clearSheetRows_(name) {
  const sh = sheet_(name);
  // clearContent では getLastRow が縮まず、次の appendRow が空行の後ろに入ってしまう
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
}

/* ------------------------------------------------------------------ */
/* ごはん（炊いたお米）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 炊飯器で5合炊いて、大4パック・小4パックに小分けして冷蔵する運用に合わせる。
 *
 * ・大と小は別々に数える。合計だけだと「大がもう無い」が見えないため。
 * ・炊いた回ごとに行を分ける。パックによって炊いた日が違うため。
 * ・大か小のどちらかが少なくなったら、自動で「お米を炊く」を仕込みタスクに入れる。
 *   夫が毎回頼まなくても、桜子さんとのりちゃんの画面に出る。
 */
const RICE_SIZES = ['大', '小'];

function riceConfig_() {
  const c = {};
  readSheet_('config').forEach(function (r) { c[r['キー']] = r['値']; });
  return {
    warnAt: Number(c['ごはん警告パック数']) || 2,     // 大・小それぞれ、これ以下で「炊いてください」
    large: Number(c['一度に炊くパック数（大）']) || 4,
    small: Number(c['一度に炊くパック数（小）']) || 4,
    keepDays: Number(c['ごはんの日持ち']) || 3,       // 冷蔵での目安
  };
}

function riceName_(size) { return 'ごはん（' + size + '）'; }

/** 大・小それぞれの残りパック数 */
function riceLeft_(stock) {
  const out = { 大: 0, 小: 0 };
  stock.forEach(function (s) {
    if (s['種別'] !== 'ごはん') return;
    RICE_SIZES.forEach(function (size) {
      if (String(s['名称']) === riceName_(size)) out[size] += Number(s['残数']) || 0;
    });
  });
  return out;
}

/**
 * payload: {large, small, cookedOn}
 * 炊いた分を大・小それぞれ在庫に入れ、出ていた依頼を完了にする。
 */
function h_cookRice(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cfg = riceConfig_();
    const counts = {
      大: p.large === undefined ? cfg.large : Number(p.large),
      小: p.small === undefined ? cfg.small : Number(p.small),
    };
    if (!(counts.大 >= 0 && counts.小 >= 0) || (counts.大 + counts.小) <= 0) {
      throw new Error('パック数が正しくありません');
    }

    const cookedOn = String(p.cookedOn || '').slice(0, 10) ||
      Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
    const useBy = addDays_(cookedOn, cfg.keepDays);

    const stock = readSheet_('stock');
    RICE_SIZES.forEach(function (size) {
      if (!counts[size]) return;
      stock.push({
        id: newId_(),
        名称: riceName_(size),
        種別: 'ごはん',
        作った日: cookedOn,
        残数: counts[size],
        保存場所: '冷蔵',
        期限: '',
        用途: '自由',
        plan_id: '',
        調理要否: '要調理',      // 温めが要る
        取り置き先: '',
        メモ: cookedOn + 'に炊いた分',
        食べる予定日: '',
        保存期限: useBy,
        調理ロット: 'rice:' + cookedOn + ':' + size,
        更新日時: new Date(),
      });
    });
    writeSheetRows_('stock', stock);

    // 出ていた依頼を片付ける
    const tasks = readSheet_('tasks');
    let closed = 0;
    tasks.forEach(function (t) {
      if (t['状態'] !== '完了' && String(t['内容']).indexOf('お米を炊く') === 0) {
        t['状態'] = '完了';
        closed++;
      }
    });
    if (closed) writeSheetRows_('tasks', tasks);

    return { 足した大: counts.大, 足した小: counts.小, 残り: riceLeft_(stock), 片付けた依頼: closed };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 大か小のどちらかが少なくなっていたら「お米を炊く」を仕込みタスクに入れる。
 * すでに出ている依頼があれば足さない。
 */
function ensureRiceTask_() {
  const cfg = riceConfig_();
  const left = riceLeft_(readSheet_('stock'));
  const tasks = readSheet_('tasks');

  const open = tasks.some(function (t) {
    return t['状態'] !== '完了' && String(t['内容']).indexOf('お米を炊く') === 0;
  });

  const low = (left.大 <= cfg.warnAt) || (left.小 <= cfg.warnAt);
  if (!low || open) return { 出した: false, 残り: left };

  tasks.push({
    id: newId_(),
    内容: 'お米を炊く（大' + left.大 + '・小' + left.小 + '）',
    menu_id: '',
    予定日: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'),
    所要時間: 60,
    担当: 'おまかせ',
    状態: '未着手',
  });
  writeSheetRows_('tasks', tasks);
  return { 出した: true, 残り: left };
}


/* ------------------------------------------------------------------ */
/* 予定と違うものを食べたとき                                           */
/* ------------------------------------------------------------------ */

/**
 * payload: {planId, newMenuId}
 *
 * 元の予定は消さずに「変更」にして残し、実際に食べたものを足す。
 * 消してしまうと、何を食べなかったのかが分からなくなるため。
 * 1回の書き込みでまとめて行う。
 */
function h_swapMeal(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const rows = readSheet_('plan');
    let old = null;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i]['id']) === String(p.planId)) { old = rows[i]; break; }
    }
    if (!old) throw new Error('その予定が見つかりません');

    old['状態'] = '変更';
    old['更新日時'] = new Date();

    if (p.newMenuId) {
      const menus = indexBy_(readSheet_('menus'), 'id');
      if (!menus[p.newMenuId]) throw new Error('そのメニューがありません');
      rows.push({
        id: newId_(),
        日付: old['日付'],
        食事区分: old['食事区分'],
        member_id: old['member_id'] || '',
        menu_id: p.newMenuId,
        状態: '食べた',
        更新日時: new Date(),
      });
    }
    writeSheetRows_('plan', rows);
    return { 変更した: old['id'], 足した: p.newMenuId || null };
  } finally {
    lock.releaseLock();
  }
}

/** payload: {planId, 状態} 予定の状態だけを変える（食べた／予定にもどす） */
function h_markMeal(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (['予定', '食べた', '変更'].indexOf(p['状態']) < 0) throw new Error('状態が正しくありません');
    const rows = readSheet_('plan');
    let target = null;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i]['id']) === String(p.planId)) { target = rows[i]; break; }
    }
    if (!target) throw new Error('その予定が見つかりません');
    target['状態'] = p['状態'];
    target['更新日時'] = new Date();
    writeSheetRows_('plan', rows);
    return { 状態: target['状態'] };
  } finally {
    lock.releaseLock();
  }
}

/** payload: {menu_id, 時間帯, 判定, 理由} 献立の good / no good を残す */
function h_feedback(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (['OK', 'NG'].indexOf(p['判定']) < 0) throw new Error('判定が正しくありません');
    h_upsert({
      sheet: 'feedback',
      rows: [{
        日付: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'),
        menu_id: p['menu_id'] || '',
        時間帯: p['時間帯'] || '',
        判定: p['判定'],
        NG理由: p['理由'] || '',
      }],
    });
    return { 残しました: p['判定'] };
  } finally {
    lock.releaseLock();
  }
}
