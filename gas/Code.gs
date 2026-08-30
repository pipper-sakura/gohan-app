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
const VOICE_FOLDER_PROP = 'VOICE_FOLDER_ID';

function doGet() {
  // 疎通確認だけ。データは一切返さない。
  return json_({ ok: true, message: 'gohan-app api' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    const secret = PROP.getProperty('FAMILY_SECRET');
    if (!secret) {
      return json_({ ok: false, error: 'FAMILY_SECRET がスクリプトプロパティに設定されていません' });
    }
    if (req.secret !== secret) {
      return json_({ ok: false, error: '合言葉が違います' });
    }

    const handler = HANDLERS[req.action];
    if (!handler) return json_({ ok: false, error: '不明なaction: ' + req.action });

    return json_({ ok: true, data: handler(req.payload || {}) });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

const HANDLERS = {
  load: h_load,
  upsert: h_upsert,
  remove: h_remove,
  uploadImage: h_uploadImage,
  getImage: h_getImage,
  applyPlan: h_applyPlan,
  buildShopping: h_buildShopping,
};

/* ------------------------------------------------------------------ */
/* 読み書きの基本                                                       */
/* ------------------------------------------------------------------ */

/** payload: {sheets:[名前...]} 省略時は全シート */
function h_load(p) {
  const names = (p.sheets && p.sheets.length) ? p.sheets : Object.keys(SHEETS);
  const out = {};
  names.forEach(function (n) { out[n] = readSheet_(n); });
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

    const saved = [];
    (p.rows || []).forEach(function (row) {
      if (keyCol === 'id' && !row.id) row.id = Utilities.getUuid().slice(0, 8);
      if (hasTimestamp) row['更新日時'] = new Date();

      const line = header.map(function (h) {
        return row[h] === undefined ? '' : row[h];
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

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('シートがありません: ' + name);
  return sh;
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
