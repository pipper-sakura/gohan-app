/**
 * Code.gs — Web APIの入口
 *
 * ・ブラウザからは POST だけを使う（Content-Type を text/plain にして
 *   プリフライトを起こさないため）。
 * ・合言葉はスクリプトプロパティ FAMILY_SECRET に入れる。コードにも
 *   リポジトリにも書かない。
 *   GASエディタ左下の「プロジェクトの設定」→「スクリプト プロパティ」から追加する。
 * ・意見箱の画像はドライブのフォルダに入れ、公開はしない。表示は必ずこのAPIを通す。
 */

const PROP = PropertiesService.getScriptProperties();

/** その呼び出しの権限。'full' はふつうの家族、'light' は食費を見せない人。 */
let CURRENT_ROLE = 'full';

/** 食費に関わるシート。light には返さないし、書き換えもさせない。 */
const MONEY_SHEETS = ['expenses'];
const VOICE_FOLDER_PROP = 'VOICE_FOLDER_ID';

function doGet() {
  // 疎通確認だけ。データは一切返さない。
  // どの処理が使える状態かも返すので、ファイルの貼り忘れがすぐ分かる。
  const missing = [];
  Object.keys(HANDLER_NAMES).forEach(function (a) {
    const n = HANDLER_NAMES[a];
    const fn = (typeof globalThis !== 'undefined' ? globalThis : this)[n];
    if (typeof fn !== 'function') missing.push(n);
  });
  return json_({
    ok: true,
    message: 'gohan-app api',
    足りない関数: missing,
    シート数: Object.keys(SHEETS).length,
  });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    const secret = PROP.getProperty('FAMILY_SECRET');
    if (!secret) {
      return json_({ ok: false, error: 'FAMILY_SECRET がスクリプトプロパティに設定されていません' });
    }

    // のりちゃん用の合言葉を別に用意すると、その端末には食費を返さない。
    // 画面で隠すだけだと、端末に届いたデータは見えてしまうため。
    const lightSecret = PROP.getProperty('LIGHT_SECRET');
    let role = null;
    if (req.secret === secret) role = 'full';
    else if (lightSecret && req.secret === lightSecret) role = 'light';
    if (!role) return json_({ ok: false, error: '合言葉が違います' });

    CURRENT_ROLE = role;

    const handler = findHandler_(req.action);
    return json_({ ok: true, data: handler(req.payload || {}) });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * action の名前と、それを処理する関数の名前の対応。
 *
 * 関数そのものではなく「名前」で持つ。
 * 関数そのものを書くと、その関数があるファイルが古いだけで
 * この行の評価に失敗し、プロジェクト全体が動かなくなるため。
 * 名前で持てば、足りない関数のときだけ、どれが足りないかを返せる。
 */
const HANDLER_NAMES = {
  ping: 'h_ping',
  load: 'h_load',
  upsert: 'h_upsert',
  remove: 'h_remove',
  replaceSlot: 'h_replaceSlot',
  consume: 'h_consume',
  cookLunches: 'h_cookLunches',
  cookRice: 'h_cookRice',
  swapMeal: 'h_swapMeal',
  markMeal: 'h_markMeal',
  feedback: 'h_feedback',
  draftMenu: 'h_draftMenu',
  readReceipt: 'h_readReceipt',
  planWeekAI: 'h_planWeekAI',
  addFoods: 'h_addFoods',
  arriveOrder: 'h_arriveOrder',
  uploadImage: 'h_uploadImage',
  getImage: 'h_getImage',
  applyPlan: 'h_applyPlan',
  buildShopping: 'h_buildShopping',
  suggestWeek: 'h_suggestWeek',
  clearWeek: 'h_clearWeek',
};

/**
 * 疎通確認。どの処理が使える状態かも返すので、ファイルの貼り忘れがすぐ分かる。
 * POSTで呼ぶ（GETは別ドメインに転送されて、ブラウザから読めないことがある）。
 */
function h_ping() {
  const missing = [];
  Object.keys(HANDLER_NAMES).forEach(function (a) {
    const n = HANDLER_NAMES[a];
    const fn = (typeof globalThis !== 'undefined' ? globalThis : this)[n];
    if (typeof fn !== 'function') missing.push(n);
  });
  return {
    足りない関数: missing,
    シート数: Object.keys(SHEETS).length,
    権限: CURRENT_ROLE,
    APIキー: PROP.getProperty('ANTHROPIC_API_KEY') ? 'あり' : 'なし',
  };
}

/** action から実際の関数を取り出す。無ければ、どれが足りないかを言う。 */
function findHandler_(action) {
  const name = HANDLER_NAMES[action];
  if (!name) throw new Error('不明なaction: ' + action);
  const fn = (typeof globalThis !== 'undefined' ? globalThis : this)[name];
  if (typeof fn !== 'function') {
    throw new Error(name + ' が見つかりません。GASのファイルが古いか、貼り忘れている可能性があります');
  }
  return fn;
}

/* ------------------------------------------------------------------ */
/* 読み書きの基本                                                       */
/* ------------------------------------------------------------------ */

/** payload: {sheets:[名前...]} 省略時は全シート */
function h_load(p) {
  const names = (p.sheets && p.sheets.length) ? p.sheets : Object.keys(SHEETS);
  const out = {};
  names.forEach(function (n) {
    if (CURRENT_ROLE === 'light' && MONEY_SHEETS.indexOf(n) >= 0) { out[n] = []; return; }
    let rows = readSheet_(n);
    // 月予算も家計の話なので、light には渡さない
    if (CURRENT_ROLE === 'light' && n === 'config') {
      rows = rows.filter(function (r) { return String(r['キー']).indexOf('予算') < 0; });
    }
    out[n] = rows;
  });
  out['_権限'] = CURRENT_ROLE;
  return out;
}

/**
 * payload: {sheet, rows:[{...}]}
 *
 * 1列目をキーとして、同じキーの行があれば更新、無ければ追加する。
 * キーが 'id' のシートは、値が無ければ採番する。
 * （config の「キー」や foods の「食材名」のように id を持たないシートでも、
 *   同じ行が二重に増えないようにするため）
 */
function h_upsert(p) {
  if (CURRENT_ROLE === 'light' && MONEY_SHEETS.indexOf(p.sheet) >= 0) {
    throw new Error('この端末では食費を変えられません');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(p.sheet);
    const header = headerOf_(sh);
    const keyCol = header[0];
    const hasTimestamp = header.indexOf('更新日時') >= 0;

    const values = sh.getDataRange().getValues();
    const rowAt = {};
    for (let r = 1; r < values.length; r++) {
      const k = String(values[r][0]);
      if (k !== '') rowAt[k] = r + 1;
    }

    if ((p.rows || []).length > 500) throw new Error('一度に保存できるのは500行までです');

    const saved = [];
    (p.rows || []).forEach(function (row) {
      if (keyCol === 'id' && !row.id) row.id = Utilities.getUuid().slice(0, 8);
      if (hasTimestamp) row['更新日時'] = new Date();
      checkNumbers_(p.sheet, row);

      const line = header.map(function (h) {
        return row[h] === undefined ? '' : safeCell_(row[h]);
      });

      const key = String(row[keyCol]);
      const at = rowAt[key];
      if (at) {
        sh.getRange(at, 1, 1, header.length).setValues([line]);
      } else {
        sh.appendRow(line);
        rowAt[key] = sh.getLastRow(); // 同じ呼び出しの中で二重に増えないように
      }
      saved.push(row);
    });
    return saved;
  } finally {
    lock.releaseLock();
  }
}

/** payload: {sheet, ids:[...]} */
function h_remove(p) {
  if (CURRENT_ROLE === 'light' && MONEY_SHEETS.indexOf(p.sheet) >= 0) {
    throw new Error('この端末では食費を変えられません');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(p.sheet);
    const values = sh.getDataRange().getValues();
    const targets = {};
    (p.ids || []).forEach(function (id) { targets[String(id)] = true; });

    // 下から消さないと行番号がずれる
    for (let r = values.length - 1; r >= 1; r--) {
      if (targets[String(values[r][0])]) sh.deleteRow(r + 1);
    }
    return { removed: (p.ids || []).length };
  } finally {
    lock.releaseLock();
  }
}

/**
 * シートの中身を、いまの一覧でまるごと置き換える。
 *
 * 「消してから入れる」と、途中で失敗したときに元のデータが戻らない。
 * 1回の setValues で全部を書き切るので、失敗すれば元のまま、
 * 成功すれば新しい内容、のどちらかになる。
 */
function writeSheetRows_(name, rows) {
  const sh = sheet_(name);
  const header = headerOf_(sh);
  const last = sh.getLastRow();

  const values = rows.map(function (r) {
    return header.map(function (h) { return r[h] === undefined ? '' : safeCell_(r[h]); });
  });

  // 余った行は空で上書きする。消す操作を分けないための埋め合わせ。
  const total = Math.max(values.length, Math.max(0, last - 1));
  const blank = header.map(function () { return ''; });
  while (values.length < total) values.push(blank.slice());

  if (total > 0) sh.getRange(2, 1, total, header.length).setValues(values);
  SpreadsheetApp.flush();
  return rows.length;
}

function newId_() { return Utilities.getUuid().slice(0, 8); }

/* ------------------------------------------------------------------ */
/* まとまった操作（途中で失敗しても壊れないように、1回の書き込みにまとめる） */
/* ------------------------------------------------------------------ */

/**
 * payload: {date, slot, menu_ids:[...]}
 * その日のその食事を、渡された内容にそっくり入れ替える。
 * 「外してから入れる」を2回の通信に分けると、途中で失敗して空になるため。
 */
function h_replaceSlot(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const date = String(p.date || '').slice(0, 10);
    const slot = String(p.slot || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日付が正しくありません: ' + date);
    if (['朝', '昼', '夜'].indexOf(slot) < 0) throw new Error('食事区分が正しくありません: ' + slot);

    const all = readSheet_('plan');
    const keep = all.filter(function (r) {
      return !(String(r['日付']).slice(0, 10) === date && r['食事区分'] === slot);
    });
    const add = (p.menu_ids || []).map(function (mid) {
      return {
        id: newId_(), 日付: date, 食事区分: slot, member_id: p.member_id || '',
        menu_id: mid, 状態: '予定', 更新日時: new Date(),
      };
    });
    writeSheetRows_('plan', keep.concat(add));
    return { 入れた件数: add.length };
  } finally {
    lock.releaseLock();
  }
}

/**
 * payload: {stockId, n}
 * 在庫を n 個消費する。端末で計算した残数を送らせない。
 * 2人が同時に1個ずつ食べても、両方ぶん減る。
 */
function h_consume(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const n = Number(p.n || 1);
    if (!(n > 0)) throw new Error('個数が正しくありません');

    const rows = readSheet_('stock');
    let target = null;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i]['id']) === String(p.stockId)) { target = rows[i]; break; }
    }
    if (!target) throw new Error('その在庫が見つかりません');

    const now = Number(target['残数']) || 0;
    if (now < n) throw new Error('残りが足りません（残り' + now + '）');

    target['残数'] = now - n;
    target['更新日時'] = new Date();
    writeSheetRows_('stock', rows);

    // ごはんが少なくなったら、その場で「お米を炊く」の依頼を出す
    let rice = null;
    if (target['種別'] === 'ごはん') rice = ensureRiceTask_();

    return { 残数: target['残数'], ごはん: rice };
  } finally {
    lock.releaseLock();
  }
}

/**
 * payload: {rows:[{食材名, 栄養素分類, 標準の調達先}]}
 * 食材マスタに足す。すでにある名前は上書きしない。
 */
function h_addFoods(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const known = {};
    readSheet_('foods').forEach(function (f) { known[f['食材名']] = true; });
    const add = (p.rows || []).filter(function (r) {
      return r && r['食材名'] && !known[r['食材名']];
    });
    if (add.length) h_upsert({ sheet: 'foods', rows: add });
    return { 足した件数: add.length };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* 意見箱の画像                                                         */
/* ------------------------------------------------------------------ */

/** payload: {name, mimeType, dataBase64} → {fileId} */
function h_uploadImage(p) {
  const folder = voiceFolder_();
  const blob = Utilities.newBlob(
    Utilities.base64Decode(p.dataBase64),
    p.mimeType || 'image/jpeg',
    p.name || ('voice-' + Date.now() + '.jpg')
  );
  const file = folder.createFile(blob);
  // 共有はしない。表示は必ず getImage を通す。
  return { fileId: file.getId() };
}

/** payload: {fileId} → {mimeType, dataBase64} */
function h_getImage(p) {
  const file = DriveApp.getFileById(p.fileId);
  if (file.getParents().next().getId() !== voiceFolder_().getId()) {
    throw new Error('このフォルダの画像ではありません');
  }
  const blob = file.getBlob();
  return { mimeType: blob.getContentType(), dataBase64: Utilities.base64Encode(blob.getBytes()) };
}

function voiceFolder_() {
  const id = PROP.getProperty(VOICE_FOLDER_PROP);
  if (id) return DriveApp.getFolderById(id);
  const folder = DriveApp.createFolder('ごはん台帳_意見箱の画像');
  PROP.setProperty(VOICE_FOLDER_PROP, folder.getId());
  return folder;
}

/* ------------------------------------------------------------------ */
/* 献立を確定したときの処理（Domain.gs 側の関数を呼ぶだけ）              */
/* ------------------------------------------------------------------ */

/** payload: {from, to} その期間の献立から、在庫の「予定あり／自由」を付け直す */
function h_applyPlan(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return reserveStockForPlan(p.from, p.to);
  } finally {
    lock.releaseLock();
  }
}

/** payload: {from, to} その週の買い物リストを作り直す */
function h_buildShopping(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return buildShoppingList(p.from, p.to);
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* 共通                                                                */
/* ------------------------------------------------------------------ */

/**
 * 名前を渡してシートを取る。
 * SHEETS に載っていない名前は受け付けない。
 * 同じスプレッドシートにある別のシートを、名前指定で読み書きされないため。
 */
function sheet_(name) {
  if (!Object.prototype.hasOwnProperty.call(SHEETS, String(name))) {
    throw new Error('扱えないシートです: ' + name);
  }
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('シートがありません: ' + name);
  return sh;
}

/**
 * 保存する値をととのえる。
 *
 * ・先頭が = + - @ の文字列は、そのまま入れるとスプレッドシートが数式として計算してしまう。
 *   先頭に ' を付けて文字列として持たせる（' は表示されず、読み出しにも出てこない）。
 * ・文字数が長すぎるものは切る。
 */
function safeCell_(v) {
  if (typeof v !== 'string') return v;
  let t = v;
  if (t.length > 5000) t = t.slice(0, 5000);
  if (/^[=+\-@]/.test(t)) return "'" + t;
  return t;
}

/** 数として持つ列の下限・上限 */
function checkNumbers_(sheetName, row) {
  if (sheetName === 'stock' && row['残数'] !== undefined && row['残数'] !== '') {
    const n = Number(row['残数']);
    if (isNaN(n) || n < 0) throw new Error('残数は0以上の数にしてください: ' + row['残数']);
  }
  if (sheetName === 'baby_log' && row['ミルクml'] !== undefined && row['ミルクml'] !== '') {
    const n = Number(row['ミルクml']);
    if (isNaN(n) || n < 0) throw new Error('ミルクmlは0以上の数にしてください');
  }
  if (sheetName === 'orders' && row['数量'] !== undefined && row['数量'] !== '') {
    const n = Number(row['数量']);
    if (isNaN(n) || n < 0) throw new Error('数量は0以上の数にしてください');
  }
}

function headerOf_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

/** シート1枚を [{列名: 値}, ...] にして返す */
function readSheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const header = values[0];
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const o = {};
    let empty = true;
    for (let c = 0; c < header.length; c++) {
      let v = values[r][c];
      if (v instanceof Date) v = Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
      o[header[c]] = v;
      if (v !== '' && v !== null) empty = false;
    }
    if (!empty) rows.push(o);
  }
  return rows;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
