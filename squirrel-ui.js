/* Optional decoration for ごはん台帳. No API, storage, app state or meal mutations. */
(function () {
  'use strict';

  const ownScript = document.currentScript;
  const imageUrl = ownScript && ownScript.dataset.squirrelImage
    ? ownScript.dataset.squirrelImage
    : new URL('./assets/squirrel.png', ownScript && ownScript.src || document.baseURI).href;

  function mount() {
    const topbar = document.getElementById('topbar');
    const tabbar = document.getElementById('tabbar');
    if (!topbar || !tabbar || document.getElementById('gd-welcome')) return;

    const scene = document.createElement('section');
    scene.id = 'gd-welcome';
    scene.className = 'gd-welcome';
    scene.setAttribute('aria-label', 'りすのひとやすみ');
    // Static, owned markup only; never interpolate meal data into this fragment.
    scene.innerHTML = '<div class="gd-copy">'
      + '<p class="gd-eyebrow">ごはんと、きょうのこと。</p>'
      + '<h1 class="gd-heading">きょうも、<br><span>いただきます。</span></h1>'
      + '<p class="gd-tagline">すこしずつ、わが家のペースで。</p>'
      + '</div><div class="gd-stage">'
      + '<button class="gd-play" type="button" aria-label="リスと遊ぶ" aria-describedby="gd-message">'
      + '<span class="gd-squirrel-motion"><img class="gd-squirrel" alt="" width="204" height="182" draggable="false"></span>'
      + '<span class="gd-mark" aria-hidden="true"></span><span class="gd-mark" aria-hidden="true"></span>'
      + '<span class="gd-mark" aria-hidden="true"></span></button>'
      + '<p id="gd-message" class="gd-message" role="status">りすを、ちょん。</p></div>'
      + '<span class="gd-cloud" aria-hidden="true"></span><span class="gd-sprout" aria-hidden="true"></span>'
      + '<button class="gd-motion-toggle" type="button" aria-pressed="false">動きを止める</button>';

    const play = scene.querySelector('.gd-play');
    const stage = scene.querySelector('.gd-stage');
    const img = scene.querySelector('.gd-squirrel');
    const message = scene.querySelector('.gd-message');
    const toggle = scene.querySelector('.gd-motion-toggle');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let userPaused = false;
    let counter = 0;
    let hopTimer = 0;
    let frame = 0;
    let lastX = 0;
    let lastY = 0;
    const phrases = ['どんぐり、どうぞ。', 'ひとやすみ、だいじ。', 'きょうも、おつかれさま。', 'ごはん、たのしみ。'];

    img.addEventListener('error', function () {
      img.hidden = true;
      play.disabled = true;
      message.textContent = 'りすは、ちょっとおでかけ。';
    }, { once: true });
    img.src = imageUrl;

    function stopped() { return reduce.matches || userPaused || scene.hidden || document.hidden; }
    function cancelMotion() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      clearTimeout(hopTimer);
      play.classList.remove('is-hopping');
      img.style.removeProperty('--gd-lean');
      img.style.removeProperty('--gd-shift');
    }
    function updatePreference() {
      const off = userPaused || reduce.matches;
      scene.classList.toggle('gd-motion-off', off);
      toggle.disabled = reduce.matches;
      toggle.setAttribute('aria-pressed', String(off));
      toggle.textContent = reduce.matches ? '端末設定で動きオフ' : userPaused ? '動きをつける' : '動きを止める';
      if (off) cancelMotion();
    }
    function updateVisibility() {
      const active = tabbar.querySelector('.tab.active');
      scene.hidden = !active || active.dataset.tab !== 'today';
      if (scene.hidden) cancelMotion();
    }
    function move() {
      frame = 0;
      if (stopped()) return;
      const rect = stage.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, (lastX - rect.left - rect.width / 2) / (rect.width / 2)));
      const y = Math.max(-1, Math.min(1, (lastY - rect.top - rect.height / 2) / (rect.height / 2)));
      img.style.setProperty('--gd-lean', (x * 5 - y * 1.5) + 'deg');
      img.style.setProperty('--gd-shift', (x * 4) + 'px');
    }

    play.addEventListener('click', function () {
      message.textContent = phrases[counter++ % phrases.length];
      // The greeting still works when motion is disabled. No focus stealing.
      if (stopped()) return;
      clearTimeout(hopTimer);
      play.classList.remove('is-hopping');
      void play.offsetWidth;
      play.classList.add('is-hopping');
      hopTimer = window.setTimeout(function () { play.classList.remove('is-hopping'); }, 700);
    });
    stage.addEventListener('pointermove', function (event) {
      if (event.pointerType !== 'mouse' || stopped()) return;
      lastX = event.clientX;
      lastY = event.clientY;
      if (!frame) frame = requestAnimationFrame(move);
    }, { passive: true });
    stage.addEventListener('pointerleave', function () {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      img.style.removeProperty('--gd-lean');
      img.style.removeProperty('--gd-shift');
    }, { passive: true });
    toggle.addEventListener('click', function () { userPaused = !userPaused; updatePreference(); });
    if (reduce.addEventListener) reduce.addEventListener('change', updatePreference);
    else if (reduce.addListener) reduce.addListener(updatePreference);
    document.addEventListener('visibilitychange', function () { if (document.hidden) cancelMotion(); });
    window.addEventListener('pagehide', cancelMotion);

    topbar.insertAdjacentElement('afterend', scene);
    new MutationObserver(updateVisibility).observe(tabbar, { subtree: true, attributes: true, attributeFilter: ['class'] });
    updatePreference();
    updateVisibility();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}());
