// CanvasTTY sprite-character player. Data comes from frames.js (window.SPRITE), written by build_sprite.py:
//   { cols, perSheet, sheets:[{file, rows}], cell:[w,h], clips:{name:[[frameIndex, seconds], ...]},
//     deck:[...], labels:{...}, loops:{action:times}, follow:{action:[otherAction, probability]} }
// Clips "X:in" / "X:out" (from to-X / from-X frames) are played around action X automatically.
// "all" mode deals every deck action once per round in random order; the gear menu loops a single action.
(() => {
  const S = window.SPRITE;
  const el = document.querySelector('.sprite');
  if (!S || !el) return;
  let dragging = null;
  const sendDrag = (phase, event) => parent.postMessage({
    source: 'canvastty-plugin', type: 'mascot-drag', phase,
    x: event.screenX, y: event.screenY, pointerId: event.pointerId
  }, '*');
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = event.pointerId;
    el.setPointerCapture(event.pointerId);
    sendDrag('start', event);
  });
  el.addEventListener('pointermove', (event) => {
    if (dragging === event.pointerId) sendDrag('move', event);
  });
  const endDrag = (event) => {
    if (dragging !== event.pointerId) return;
    dragging = null;
    sendDrag('end', event);
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('lostpointercapture', endDrag);
  el.style.aspectRatio = `${S.cell[0]} / ${S.cell[1]}`;
  // fit inside the window at any size without distortion
  el.style.height = `min(100vh, calc(100vw * ${S.cell[1]} / ${S.cell[0]}))`;
  // Frames live in several sheets (one huge sheet is not drawn) and are painted on a canvas from images
  // decoded up front: swapping a CSS background between sheets showed an empty frame (flicker) while decoding.
  // The canvas keeps the cell's own size and gets a 1:1 copy; the browser scales the element once.
  // Sizing the bitmap to the window resampled twice (CanvasTTY zoom is invisible here) - blurry.
  const [cw, ch] = S.cell;
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  canvas.style.cssText = 'width:100%;height:100%;display:block';
  el.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const sheets = S.sheets.map((s) => { const img = new Image(); img.src = s.file; return img; });
  const ready = Promise.all(sheets.map((img) => img.decode().catch(() => {})));
  const show = (i) => {
    const s = Math.floor(i / S.perSheet), local = i % S.perSheet, img = sheets[s];
    if (!img.complete || !img.naturalWidth) return;               // not decoded yet: keep the previous frame
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, (local % S.cols) * cw, Math.floor(local / S.cols) * ch, cw, ch, 0, 0, cw, ch);
  };

  // Finish the current clip before exiting so a menu click cannot splice incompatible poses.
  // The latest selection is read at boundaries; transitions never queue stale selections.
  const sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));
  const has = (name) => (S.clips[name] || []).length > 0;
  const chance = (p) => Math.random() < p;
  const play = async (name, times = 1) => {
    const clip = S.clips[name] || [];
    for (let t = 0; t < times; t++) for (const [i, d] of clip) { show(i); await sleep(d); }
  };
  // standing -> to-X -> X -> from-X -> standing
  const perform = async (name) => {
    await play(`${name}:in`);
    let cycles = 0;
    do {
      await play(name);
      cycles++;
    } while (mode === name || (mode === 'all' && cycles < ((S.loops || {})[name] || 1)));
    await play(`${name}:out`);
    const follow = (S.follow || {})[name];
    if (mode === 'all' && follow && has(follow[0]) && chance(follow[1])) await perform(follow[0]);
  };

  const shuffle = (list) => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  const deal = (last) => {
    const deck = shuffle((S.deck || []).filter(has));
    for (let i = 1; i < deck.length; i++) {            // separate identical neighbours
      if (deck[i] === deck[i - 1]) {
        const k = deck.findIndex((n, j) => j > i && n !== deck[i]);
        if (k > 0) [deck[i], deck[k]] = [deck[k], deck[i]];
      }
    }
    if (deck[0] === last && deck.length > 1) deck.push(deck.shift());
    return deck;
  };

  // gear menu: "all", "idle" and every deck action that has frames
  const previewAction = new URLSearchParams(window.location.search).get('action');
  let mode = (previewAction === 'idle' && has('idle')) || ((S.deck || []).includes(previewAction) && has(previewAction))
    ? previewAction : 'all';
  document.documentElement.dataset.buildId = S.buildId || '';
  const picker = document.getElementById('picker');
  const toggle = document.getElementById('picker-toggle');
  const menu = document.getElementById('picker-menu');
  if (picker && toggle && menu) {
    const defaultLabels = {
      en: { all: 'All actions', idle: 'Idle' },
      ru: { all: 'Всё подряд', idle: 'Ожидание' }
    };
    let locale = navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
    const names = ['all', ...(has('idle') ? ['idle'] : []), ...new Set((S.deck || []).filter(has))];
    const close = () => { picker.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); };
    const options = new Map();
    for (const name of names) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'picker-option';
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', String(name === mode));
      option.addEventListener('click', () => {
        mode = name;
        for (const [key, item] of options) item.setAttribute('aria-checked', String(key === name));
        close();
        toggle.focus();
      });
      options.set(name, option);
      menu.appendChild(option);
    }
    const renderLabels = () => {
      const labels = Object.assign({}, defaultLabels[locale], S.labels || {});
      for (const [name, option] of options) option.textContent = labels[name] || name;
      document.documentElement.lang = locale;
      toggle.setAttribute('aria-label', locale === 'ru' ? 'Выбрать анимацию' : 'Choose animation');
      menu.setAttribute('aria-label', locale === 'ru' ? 'Анимации' : 'Animations');
    };
    renderLabels();
    window.addEventListener('message', (event) => {
      if (event.source !== parent || event.data?.source !== 'canvastty-host' || event.data?.type !== 'context') return;
      const hostLocale = event.data.value?.appearance?.locale;
      if (hostLocale !== 'ru' && hostLocale !== 'en') return;
      locale = hostLocale;
      renderLabels();
    });
    toggle.addEventListener('click', () => {
      const open = picker.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('button')?.focus();
    });
    document.addEventListener('pointerdown', (event) => { if (!picker.contains(event.target)) close(); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && picker.classList.contains('open')) { close(); toggle.focus(); }
    });
    menu.addEventListener('keydown', (event) => {
      const items = [...options.values()];
      const current = items.indexOf(document.activeElement);
      let next = current;
      if (event.key === 'ArrowDown') next = (current + 1) % items.length;
      else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else return;
      event.preventDefault();
      items[next]?.focus();
    });
  }

  const step = async (last) => {
    if (mode === 'idle') { await play('idle'); return last; }
    if (mode !== 'all') {
      const action = mode;
      await perform(action);
      await play('idle');
      return action;
    }
    const deck = deal(last);
    if (!deck.length) { if (has('idle')) await play('idle'); else await sleep(1); return last; }
    for (const action of deck) {
      await play('idle', chance(0.6) ? 1 : 2);
      if (mode !== 'all') break;
      await perform(action);
      last = action;
      if (mode !== 'all') break;
    }
    return last;
  };

  (async () => {
    await ready;                                                 // start only when every sheet is decoded
    let last = '';
    for (;;) last = await step(last);
  })();
})();
