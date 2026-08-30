/**
 * Ai.gs — メニュー名から、材料とレシピの下書きをAIに書いてもらう
 *
 * 自由入力のままだと「豚ロース」「豚ロース肉」「豚ろーす」が別物になり、
 * 買い物リストも在庫の判定も崩れる。
 * そこで材料は必ず食材マスタ（foods）の中から選ばせ、
 * 足りないものだけ「新しい食材」として提案させる。
 *
 * 人が直した結果は menus と foods にそのまま残るので、
 * 次からはその表記が候補として出る。
 *
 * ─── 使う前の準備 ───
 * GASエディタ左下の「プロジェクトの設定」→「スクリプト プロパティ」に
 *   ANTHROPIC_API_KEY = console.anthropic.com で発行したキー
 * を入れる。キーはコードにもリポジトリにも書かない。
 *
 * 料金は従量課金（Claude Proとは別会計）。1回の下書きで数円程度。
 */

// Opus 4.8。Opus 5より安く、この用途には十分。
// 4.8 は thinking を省くと「考えない」になるので、adaptive を明示する。
const AI_MODEL = 'claude-opus-4-8';
const AI_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/** payload: {name, slot} → レシピの下書き */
function h_draftMenu(p) {
  const name = String(p.name || '').trim();
  if (!name) throw new Error('メニュー名が空です');

  const foods = readSheet_('foods');
  const foodNames = foods.map(function (f) { return f['食材名']; });

  // 家族の誰かが「×」にしている食材は使わせない
  const banned = {};
  readSheet_('prefs').forEach(function (r) {
    if (r['評価'] === '×') banned[r['食材名']] = true;
  });
  const bannedList = Object.keys(banned);

  // 実際に使っている器具
  const tools = ['オーブン', 'レコルト自動調理ポットLarge', 'フライパン', '鍋',
                 'トースター', '魚焼きグリル', '電子レンジ', '炊飯器'];

  const system = [
    'あなたは家庭料理の献立を整理する係です。',
    '必ずJSONだけを返してください。前置き、説明、コードフェンスは書かないでください。',
    '「材料」は、渡された食材リストの中の表記をそのまま使ってください。',
    'リストに無い食材が必要なときだけ「新しい食材」に入れ、「材料」にも同じ名前で入れてください。',
    '日持ちの日数は目安として答え、断定はしないでください。',
  ].join('\n');

  const user = [
    'つくるもの：' + name,
    p.slot ? '食べる時間帯の希望：' + p.slot : '',
    '',
    '【この家の決まり】',
    '・大人2人分で書く。',
    '・「昼」は週末にオーブンでまとめて作り、1食ずつ耐熱ガラス容器に入れて冷蔵か冷凍する。',
    '　魚は冷凍のままオーブンで焼けるものだけ「昼」にできる。それ以外は「夜」にする。',
    '・「夜」は仕事のあとに30〜40分で作れるもの。',
    '・使ってはいけない食材：' + (bannedList.length ? bannedList.join('、') : 'なし'),
    '・使える器具：' + tools.join('、'),
    '',
    '【使える食材リスト（この表記をそのまま使う）】',
    foodNames.join('、'),
    '',
    '【返すJSONの形】',
    JSON.stringify({
      メニュー名: '文字列',
      区分: '主菜 か 副菜 か 汁物',
      時間帯: '昼 か 夜 か 両方',
      材料: ['食材リストの表記', '…'],
      新しい食材: [{ 食材名: '', 栄養素分類: '炭水化物 か タンパク質 か ビタミン・ミネラル か その他', 標準の調達先: '八百屋 か ライフ か 近所のスーパー か コープ' }],
      調理器具: '文字列',
      オーブン温度: '数値。オーブンを使わないなら空文字',
      調理時間: '数値（分）',
      冷凍可: 'はい か いいえ',
      解凍要否: '要 か 不要',
      日持ち冷蔵: '数値（日）',
      日持ちパーシャル: '数値（日）',
      日持ち冷凍: '数値（日）。冷凍できないなら0',
      手順メモ: '2人分の分量を入れた作り方。3〜5文で。',
    }, null, 0),
  ].filter(Boolean).join('\n');

  const out = callClaude_(system, user, { maxTokens: 3000, effort: 'low' });
  const draft = parseJsonLoosely_(out.text);
  if (!draft) throw new Error('AIの返事を読み取れませんでした：' + String(out.text).slice(0, 200));

  // 食材リストに無いものが「材料」に混ざっていないか確かめる
  const known = {};
  foodNames.forEach(function (n) { known[n] = true; });
  const proposed = {};
  (draft['新しい食材'] || []).forEach(function (f) { if (f && f['食材名']) proposed[f['食材名']] = true; });

  draft['材料'] = (draft['材料'] || []).filter(Boolean);
  draft['不明な材料'] = draft['材料'].filter(function (m) { return !known[m] && !proposed[m]; });

  draft['使ったトークン'] = out.usage || {};
  return draft;
}

/**
 * Claude を呼ぶ。ここだけが外部に通信する。
 * 送り先は api.anthropic.com のみ。キーはスクリプトプロパティから読む。
 */
function callClaude_(system, user, opt) {
  const key = PROP.getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY がスクリプトプロパティに設定されていません');
  const o = opt || {};

  const res = UrlFetchApp.fetch(AI_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: AI_MODEL,
      max_tokens: o.maxTokens || 3000,
      thinking: { type: 'adaptive' },
      output_config: { effort: o.effort || 'low' },
      system: system,
      messages: [{ role: 'user', content: o.content || user }],
    }),
  });

  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code !== 200) {
    throw new Error('AIが応答しませんでした（' + code + '）: ' + body.slice(0, 300));
  }
  const out = JSON.parse(body);
  if (out.stop_reason === 'refusal') throw new Error('AIがこの内容には答えられませんでした');

  return {
    text: (out.content || [])
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join(''),
    usage: out.usage || {},
  };
}

/* ------------------------------------------------------------------ */
/* 1週間の献立をAIに組んでもらう                                        */
/* ------------------------------------------------------------------ */

/**
 * payload: {from, to}
 *
 * 1ヶ月をまとめて頼むと、GASの通信の上限（60秒）に届いてしまう。
 * 画面側から週ごとに呼ぶ。
 *
 * 苦手食材、最近の重複、栄養の組み合わせ、在庫の使い切り、食費の残りを
 * まとめて渡して考えてもらう。ここがルールだけでは届かないところ。
 */
function h_planWeekAI(p) {
  const r = checkRange_(p.from, p.to);

  const menus = readSheet_('menus');
  const members = readSheet_('members');
  const prefs = readSheet_('prefs');
  const stock = readSheet_('stock');
  const plans = readSheet_('plan');
  const expenses = readSheet_('expenses');
  const config = {};
  readSheet_('config').forEach(function (c) { config[c['キー']] = c['値']; });

  /* 家族の苦手 */
  const nameById = {};
  members.forEach(function (m) { nameById[m['id']] = m['名前']; });
  const dislikes = {};
  prefs.forEach(function (x) {
    if (x['評価'] !== '×' && x['評価'] !== '△') return;
    const who = nameById[x['member_id']] || x['member_id'];
    (dislikes[who] = dislikes[who] || []).push(x['評価'] + x['食材名']);
  });
  const dislikeText = Object.keys(dislikes).length
    ? Object.keys(dislikes).map(function (w) { return w + '：' + dislikes[w].join('、'); }).join(' ／ ')
    : 'とくになし';

  /* 在庫（使い切りたい順） */
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const haveText = stock.filter(function (s) {
    return Number(s['残数']) > 0 && s['種別'] !== '市販BF' && s['種別'] !== 'ごはん';
  }).sort(function (a, b) {
    return String(a['保存期限'] || '9999').localeCompare(String(b['保存期限'] || '9999'));
  }).slice(0, 40).map(function (s) {
    return s['名称'] + (s['保存期限'] ? '(' + s['保存期限'] + 'まで)' : '');
  }).join('、') || 'なし';

  /* 最近作ったもの（かぶりを避けるため）
   *
   * 前は直近60件を日付順に渡していたが、夜は1日3品あるので
   * 60件では2週間ぶんしか届いておらず、「4週間分」という見出しが嘘になっていた。
   * 主菜ごとに「最後に作った日」だけを渡すほうが、短くて漏れがない。 */
  const menuName = {};
  menus.forEach(function (m) { menuName[m['id']] = m['メニュー名']; });
  const isMain = {};
  menus.forEach(function (m) { if (m['区分'] === '主菜') isMain[m['id']] = true; });

  const start = String(r.from).slice(0, 10);
  const minGap = minGapDays_();
  const lastMade = {};
  plans.forEach(function (x) {
    const d = String(x['日付']).slice(0, 10);
    if (d >= start || !isMain[x['menu_id']]) return;
    if (!lastMade[x['menu_id']] || d > lastMade[x['menu_id']]) lastMade[x['menu_id']] = d;
  });
  const recent = Object.keys(lastMade).sort(function (a, b) {
    return lastMade[b].localeCompare(lastMade[a]);
  }).map(function (id) {
    return menuName[id] + '：' + lastMade[id] + '（' + daysBetween_(lastMade[id], start) + '日前）';
  }).join(' / ') || 'なし';

  /* まだ一度も作っていない主菜。ここから選ぶとかぶらない */
  const neverMade = menus.filter(function (m) {
    return m['区分'] === '主菜' && !lastMade[m['id']];
  }).map(function (m) { return m['メニュー名']; }).join('、') || 'なし';

  /* 食費 */
  const month = today.slice(0, 7);
  const spent = expenses.filter(function (e) { return String(e['日付']).slice(0, 7) === month; })
    .reduce(function (n, e) { return n + (Number(e['金額']) || 0); }, 0);
  const budget = Number(config['月予算']) || 60000;

  /* 前にNGにした組み合わせ */
  const menuNameById = {};
  menus.forEach(function (m) { menuNameById[m['id']] = m['メニュー名']; });
  const ngText = readSheet_('feedback').filter(function (f) { return f['判定'] === 'NG'; })
    .map(function (f) {
      return (menuNameById[f['menu_id']] || f['menu_id']) + 'の' + (f['時間帯'] || '')
        + (f['NG理由'] ? '（' + f['NG理由'] + '）' : '');
    }).join('、') || 'なし';

  /* 選べるメニュー */
  const list = menus.map(function (m) {
    return [m['id'], m['メニュー名'], m['区分'], m['時間帯'] || '両方',
            m['調理器具'] || '', m['解凍要否'] || '', m['調理時間'] || '',
            splitList_(m['材料']).join('・')].join(' | ');
  }).join('\n');

  const system = [
    'あなたは家庭の献立を組む係です。',
    '必ずJSONだけを返してください。前置きやコードフェンスは書かないでください。',
    'menu_id は渡された一覧の id をそのまま使ってください。新しい料理を作らないでください。',
  ].join('\n');

  const user = [
    '【期間】' + r.from + ' 〜 ' + r.to,
    '',
    '【埋める枠】',
    '・昼：月〜金だけ。1日1品（主菜）。土日の昼は作らない。',
    '・夜：毎日。主菜1・副菜1・汁物1の3品。ただし鍋やクリームシチューの日は主菜1品だけでよい。',
    '・朝：今回は埋めない。',
    '',
    '【この家の決まり】',
    '・昼は週末にオーブンでまとめて作り、1食ずつ耐熱ガラス容器で冷蔵か冷凍する。',
    '　だから昼に置けるのは「調理器具にオーブンを含み、解凍要否が不要」のメニューだけ。',
    '・夜は仕事のあとに30〜40分で作れるもの。',
    '・木曜は隔週で鍋。鍋にした週は金曜も同じ鍋（2日目）にする。',
    '・同じ日の昼と夜で、同じ食材が重ならないようにする。',
    '・同じ主菜は ' + minGap + ' 日以上あける。これは必ず守ること。',
    '　この期間の中でも、同じ主菜を二度出さない。',
    '　まだ作っていない主菜があるなら、そちらを先に使う。',
    '・主菜・副菜・汁物で、肉/魚/豆と野菜がかたよらないようにする。',
    '',
    '【家族の苦手（×は使わない。△は控えめに）】',
    dislikeText,
    '',
    '【いま家にあるもの（期限が近い順。できるだけ使い切る）】',
    haveText,
    '',
    '【今月の食費】' + budget + '円のうち ' + spent + '円まで使っている。'
      + (spent > budget * 0.7 ? '残りが少ないので、家にあるものを優先して使う。' : ''),
    '',
    '【前にNGにした組み合わせ（出さない）】',
    ngText,
    '',
    '【主菜を最後に作った日（' + minGap + '日たっていないものは出さない）】',
    recent,
    '',
    '【まだ一度も作っていない主菜（優先して使う）】',
    neverMade,
    '',
    '【選べるメニュー】id | 名前 | 区分 | 時間帯 | 器具 | 解凍 | 分 | 材料',
    list,
    '',
    '【返すJSON】',
    '{"予定":[{"日付":"YYYY-MM-DD","食事区分":"昼または夜","menu_id":"id"}],"考えたこと":"2〜3文"}',
  ].join('\n');

  const out = callClaude_(system, user, { maxTokens: 6000, effort: 'medium' });
  const parsed = parseJsonLoosely_(out.text);
  if (!parsed || !parsed['予定']) {
    throw new Error('AIの返事を読み取れませんでした：' + String(out.text).slice(0, 200));
  }

  /* 受け取った内容を確かめてから入れる */
  const known = {};
  menus.forEach(function (m) { known[m['id']] = true; });
  const rows = [];
  const dropped = [];
  parsed['予定'].forEach(function (x) {
    const date = String(x['日付'] || '').slice(0, 10);
    const slot = String(x['食事区分'] || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < r.from || date > r.to) { dropped.push(x); return; }
    if (['朝', '昼', '夜'].indexOf(slot) < 0) { dropped.push(x); return; }
    if (!known[x['menu_id']]) { dropped.push(x); return; }
    rows.push({ 日付: date, 食事区分: slot, member_id: '', menu_id: x['menu_id'], 状態: '予定' });
  });

  if (!rows.length) throw new Error('使えるメニューが返ってきませんでした');

  replacePlanRange_(r.from, r.to, rows);

  /* お願いしただけでは守られないことがあるので、出てきた結果を数えて直す */
  const fixed = h_fixRepeats({ from: r.from, to: r.to });

  return {
    入れた件数: rows.length,
    はじいた件数: dropped.length,
    かぶりを直した件数: fixed['直した件数'],
    考えたこと: parsed['考えたこと'] || '',
    使ったトークン: out.usage,
  };
}

/** AIがコードフェンスや前置きを付けてしまっても読み取れるようにする */
function parseJsonLoosely_(text) {
  const t = String(text || '').trim();
  const tries = [t];

  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1]);

  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) tries.push(t.slice(first, last + 1));

  for (let i = 0; i < tries.length; i++) {
    try { return JSON.parse(tries[i]); } catch (e) { /* 次を試す */ }
  }
  return null;
}


/* ------------------------------------------------------------------ */
/* レシートを読む                                                       */
/* ------------------------------------------------------------------ */

/**
 * payload: {dataBase64, mimeType}
 *
 * 撮ったレシートから、店・日付・合計・品目を取り出す。
 * 読み間違いはあるので、画面で人が確かめてから保存する。
 * 食材の名前は、台帳にある表記に寄せてもらう（表記ゆれを増やさないため）。
 */
function h_readReceipt(p) {
  if (!p.dataBase64) throw new Error('画像がありません');

  const foodNames = readSheet_('foods').map(function (f) { return f['食材名']; });

  const system = [
    'あなたはレシートを読み取る係です。',
    '必ずJSONだけを返してください。前置きやコードフェンスは書かないでください。',
    '読み取れない項目は空にしてください。推測で埋めないでください。',
  ].join('\n');

  const ask = [
    'このレシートから、次のJSONを作ってください。',
    '',
    '【食材の名前】',
    'できるだけ次の表記に寄せてください。当てはまらないものはレシートのままで構いません。',
    foodNames.join('、'),
    '',
    '【返すJSON】',
    JSON.stringify({
      店: 'コープこうべ／ライフ／近所のスーパー／八百屋 のどれか。分からなければレシートの店名',
      日付: 'YYYY-MM-DD。読めなければ空',
      合計: '数値。税込の合計',
      品目: [{ 名前: '', 金額: '数値', 食材: '上の表記に当てはまるならその名前。無ければ空' }],
    }, null, 0),
  ].join('\n');

  const out = callClaude_(system, null, {
    maxTokens: 3000,
    effort: 'low',
    content: [
      { type: 'image', source: { type: 'base64', media_type: p.mimeType || 'image/jpeg', data: p.dataBase64 } },
      { type: 'text', text: ask },
    ],
  });

  const r = parseJsonLoosely_(out.text);
  if (!r) throw new Error('レシートを読み取れませんでした：' + String(out.text).slice(0, 200));

  r['品目'] = (r['品目'] || []).filter(function (x) { return x && x['名前']; });
  r['使ったトークン'] = out.usage;
  return r;
}
