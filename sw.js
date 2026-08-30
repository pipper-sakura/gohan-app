/* 画面のファイルだけキャッシュする。データはキャッシュしない（app.js側で前回分を保持している） */
const PREFIX = 'gohan-';
const CACHE = PREFIX + 'v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.json',
               'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // 同じドメインに別のアプリを置くことがあるので、このアプリの分だけ消す
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // GASへのPOSTなど、同じオリジン以外とGET以外は素通し
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // ブラウザのキャッシュを見に行くと、直したはずの画面が古いままになる。
  // 毎回サーバーに確認して、つながらないときだけキャッシュを使う。
  e.respondWith(
    fetch(new Request(req.url, { cache: 'no-cache' }))
      .then((res) => {
        // 404などを保存すると、正常なキャッシュを壊してしまう
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => {
        if (r) return r;
        // 画面を開く要求のときだけ index.html を代わりに返す。
        // CSSやJavaScriptの代わりにHTMLを返すと、かえって壊れる。
        if (req.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      }))
  );
});
