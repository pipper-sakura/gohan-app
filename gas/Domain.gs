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
  const plans = readSheet_('plan').filter(function (p) {
    return inRange_(p['日付'], from, to) && p['状態'] !== '変更';
  });
  const menus = indexBy_(readSheet_('menus'), 'id');
  const foods = indexBy_(readSheet_('foods'), '食材名');

  // 献立で使う予定のメニュー名と食材を集める
  const plannedMenuNames = {};
  const plannedFoods = {};
  plans.forEach(function (p) {
    const m = menus[p['menu_id']];
    if (!m) return;
    plannedMenuNames[m['メニュー名']] = p['id'];
    splitList_(m['材料']).forEach(function (f) {
      if (!plannedFoods[f]) plannedFoods[f] = p['id'];
    });
  });

  const stock = readSheet_('stock');
  const updates = [];

  stock.forEach(function (s) {
    const before = s['用途'];
    const beforePlan = s['plan_id'];

    if (s['種別'] === '作り置き' && plannedMenuNames[s['名称']]) {
      s['用途'] = '予定あり';
      s['plan_id'] = plannedMenuNames[s['名称']];
    } else if (plannedFoods[s['名称']] && isMainIngredient_(s['名称'], foods)) {
      s['用途'] = '予定あり';
      s['plan_id'] = plannedFoods[s['名称']];
    } else if (plannedFoods[s['名称']]) {
      s['用途'] = '自由（献立でも使用）';
      s['plan_id'] = '';
    } else {
      s['用途'] = '自由';
      s['plan_id'] = '';
    }

    if (s['用途'] !== before || s['plan_id'] !== beforePlan) updates.push(s);
  });

  if (updates.length) h_upsert({ sheet: 'stock', rows: updates });
  return { updated: updates.length };
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
 * 週末にまとめて作った平日昼の分に、保存場所を割り当てる。
 * 月・火はパーシャル室（3〜4日が上限）、水〜金は冷凍。
 * 冷凍にしたものは、食べる前日の夜に冷蔵庫へ移す必要がある。
 */
function assignLunchStorage(cookedOn, lunchPlanIds) {
  const PARTIAL_DAYS = 2; // 月・火の2食分まではパーシャル
  const menus = indexBy_(readSheet_('menus'), 'id');
  const plans = indexBy_(readSheet_('plan'), 'id');
  const rows = [];

  lunchPlanIds.forEach(function (planId, i) {
    const p = plans[planId];
    if (!p) return;
    const m = menus[p['menu_id']] || {};
    const place = i < PARTIAL_DAYS ? 'パーシャル' : '冷凍';

    rows.push({
      名称: m['メニュー名'] || '',
      種別: '作り置き',
      作った日: cookedOn,
      残数: 1,
      保存場所: place,
      期限: p['日付'],
      用途: '予定あり',
      plan_id: planId,
      調理要否: '要調理', // 温め直しが要る
      取り置き先: p['member_id'] || '',
    });
  });

  return h_upsert({ sheet: 'stock', rows: rows });
}

/**
 * 明日の昼の分で、冷凍から冷蔵へ移すべきものを返す。
 * トップ画面の「今日やること」に出す。
 */
function thawTonight(today) {
  const tomorrow = addDays_(today, 1);
  return readSheet_('stock').filter(function (s) {
    return s['保存場所'] === '冷凍'
      && s['種別'] === '作り置き'
      && String(s['期限']).slice(0, 10) === tomorrow;
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

  const inStock = {};
  readSheet_('stock').forEach(function (s) {
    if (Number(s['残数']) > 0) inStock[s['名称']] = true;
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

  // 買い物リストは毎回作り直す（買った済みのチェックは週をまたがない）
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
