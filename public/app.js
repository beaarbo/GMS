// Progressive enhancement only: every feature also works through plain forms.

// Phones: fold the menu behind a Menu button. CSS only folds it once this runs,
// so without JavaScript the full menu shows as before.
(function phoneMenu() {
  const button = document.querySelector('.nav-toggle');
  const nav = document.getElementById('main-nav');
  if (!button || !nav) return;
  document.documentElement.classList.add('has-menu-toggle');
  button.hidden = false;
  const set = (open) => {
    button.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('open', open);
    // Only the label changes, so the unread notifications badge beside it stays.
    (button.querySelector('.nav-toggle-label') || button).textContent = open ? 'Close menu' : 'Menu';
  };
  button.addEventListener('click', () => set(button.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.classList.contains('open')) {
      set(false);
      button.focus();
    }
  });
}());

// Themes: Auto (follow the device), Dark and Light, picked on My account and
// remembered for public/theme.js to apply before the next page draws.
function setTheme(next) {
  if (next === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  try {
    if (next === 'auto') window.localStorage.removeItem('theme');
    else window.localStorage.setItem('theme', next);
  } catch (error) {
    // Storage blocked: the choice lasts for this page only.
  }
}

// My account's theme choice applies and saves as soon as it's picked. Without
// JavaScript its Save button posts the form instead.
(function accountTheme() {
  const form = document.querySelector('[data-theme-form]');
  if (!form) return;
  const save = form.querySelector('[data-theme-save]');
  if (save) save.hidden = true;
  form.addEventListener('change', (event) => {
    const next = event.target.value;
    setTheme(next);
    document.documentElement.dataset.accountTheme = next;
    fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: form.elements._csrf.value, theme: next, ajax: '1' }),
    }).then((response) => {
      // Saving failed (for example an expired form): post it the usual way.
      if (!response.ok) form.submit();
    }).catch(() => form.submit());
  });
}());

// The sticky top bar's real height, so jumps to a row (#reg-12) stop below it.
// The bar grows when its menu wraps, so this follows resizes. CSS has a fallback.
(function trackTopbarHeight() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const update = () => document.documentElement.style.setProperty('--topbar-height', `${bar.offsetHeight}px`);
  update();
  if (window.ResizeObserver) new ResizeObserver(update).observe(bar);
  else window.addEventListener('resize', update);
}());

// Court screens: listen for changes and swap in the new content without a
// reload. Without JavaScript the page reloads itself instead. A slow check every
// minute covers any change signal that was missed while reconnecting.
(function liveCourtScreen() {
  const url = document.body && document.body.dataset.liveEvents;
  if (!url || !window.EventSource || !window.fetch) return;
  const status = document.getElementById('screen-status');
  const show = (text, state) => {
    if (!status) return;
    status.hidden = false;
    status.textContent = text;
    status.dataset.state = state;
  };

  let refreshing = false;
  let again = false;
  async function refresh() {
    if (refreshing) {
      again = true;
      return;
    }
    refreshing = true;
    try {
      const response = await fetch(window.location.href, { credentials: 'same-origin', cache: 'no-store' });
      // Logged out or the court is gone: a full load shows the right page.
      if (!response.ok || response.redirected) {
        window.location.reload();
        return;
      }
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      // Someone is typing a score or choosing how a bout was won: try again shortly,
      // rather than wipe what they've entered.
      const changed = (field) => (field.tagName === 'SELECT'
        ? [...field.options].some((option) => option.selected !== option.defaultSelected)
        : field.value !== field.defaultValue);
      const busy = [...document.querySelectorAll('[data-live-part] input, [data-live-part] select, [data-live-part] textarea')]
        .some((field) => field.type !== 'hidden' && (field === document.activeElement || changed(field)));
      if (busy) {
        setTimeout(refresh, 3000);
        return;
      }
      document.querySelectorAll('[data-live-part]').forEach((part) => {
        const fresh = page.querySelector(`[data-live-part="${part.dataset.livePart}"]`);
        if (fresh) part.innerHTML = fresh.innerHTML;
      });
    } catch (error) {
      show('Reconnecting…', 'down');
    } finally {
      refreshing = false;
      if (again) {
        again = false;
        refresh();
      }
    }
  }

  const events = new EventSource(url);
  let wasDown = false;
  events.addEventListener('open', () => {
    show('Live', 'up');
    // Catch up on anything that changed while the connection was down.
    if (wasDown) refresh();
    wasDown = false;
  });
  events.addEventListener('change', refresh);
  events.addEventListener('error', () => {
    wasDown = true;
    show('Reconnecting…', 'down');
  });
  setInterval(refresh, 60000);
}());
document.addEventListener('submit', (event) => {
  const submitter = event.submitter;
  const message = (submitter && submitter.dataset.confirm) || event.target.dataset.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});

// Enter in a rejection reason must not trigger the form's first button, "Approve ticked".
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('.note-input')) event.preventDefault();
});

document.addEventListener('change', (event) => {
  if (event.target.matches('[data-check-all]')) {
    document.querySelectorAll('input[name="ids"]').forEach((box) => {
      box.checked = event.target.checked;
    });
  }
  // Ticking a fighter moves focus to their weight class, which is required.
  if (event.target.matches('input[name="fighter_ids"]')) {
    const weight = document.querySelector(`select[name="weight_class_${event.target.value}"]`);
    if (weight) {
      weight.required = event.target.checked;
      if (event.target.checked) weight.focus();
    }
  }
});

// Competition photos: show the chosen pictures before they're uploaded, and
// flag any the server would refuse (too large, or more than there's room for).
(function () {
  const MAX_BYTES = 5 * 1024 * 1024;
  let urls = [];
  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!input.matches('[data-photo-preview]')) return;
    const grid = document.getElementById(input.dataset.photoPreview);
    if (!grid) return;
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls = [];
    grid.replaceChildren();
    const files = [...input.files];
    const room = Number(input.dataset.room);
    files.forEach((file, i) => {
      const tile = document.createElement('figure');
      tile.className = 'photo-tile';
      const img = document.createElement('img');
      const url = URL.createObjectURL(file);
      urls.push(url);
      img.src = url;
      img.alt = `Preview of ${file.name}`;
      const caption = document.createElement('figcaption');
      caption.className = 'hint';
      const problem = file.size > MAX_BYTES ? 'Too large: over 5 MB' : i >= room ? 'No room for this one' : '';
      caption.textContent = problem ? `${file.name} · ${problem}` : file.name;
      if (problem) tile.classList.add('photo-problem');
      tile.append(img, caption);
      grid.append(tile);
    });
    grid.hidden = files.length === 0;
  });
}());

// Poomsae draw wheel. The server makes the random pick and records it; the wheel
// only shows it, spinning to each poomsae drawn. Without JavaScript (or fetch)
// the form posts normally and the page shows the result.
(function () {
  const SPIN_MS = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 400 : 3200;
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function drawWheel(canvas, names, rotation) {
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const r = size / 2 - 6;
    const seg = (Math.PI * 2) / names.length;
    // Fill colours made for white text, in both themes; the two greens never touch.
    const colours = ['--chung-fill', '--ok-fill', '--hong-fill', '--ok-fill-hover'].map(token);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(size / 2, size / 2);
    names.forEach((name, i) => {
      const start = rotation + i * seg;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, start, start + seg);
      ctx.closePath();
      // Neighbours never share a colour, nor do the first and last.
      ctx.fillStyle = colours[(i % colours.length === 0 && i === names.length - 1) ? 1 : i % colours.length];
      ctx.fill();
      ctx.strokeStyle = token('--surface');
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.save();
      ctx.rotate(start + seg / 2);
      ctx.fillStyle = token('--on-photo');
      ctx.font = `600 ${Math.max(10, Math.min(16, 220 / names.length))}px ${token('--font')}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, r - 10, 0, r - 30);
      ctx.restore();
    });
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, Math.PI * 2);
    ctx.fillStyle = token('--surface');
    ctx.fill();
    ctx.restore();
    // The pointer, at the top.
    ctx.beginPath();
    ctx.moveTo(size / 2 - 12, 0);
    ctx.lineTo(size / 2 + 12, 0);
    ctx.lineTo(size / 2, 26);
    ctx.closePath();
    ctx.fillStyle = token('--ink');
    ctx.fill();
  }

  // Turns from the current angle to land the chosen slice under the pointer, after a few full turns.
  function spinTo(canvas, names, from, index) {
    const seg = (Math.PI * 2) / names.length;
    let target = -Math.PI / 2 - (index + 0.5) * seg;
    while (target < from + Math.PI * 8) target += Math.PI * 2;
    const started = performance.now();
    return new Promise((resolve) => {
      const frame = (now) => {
        const t = Math.min(1, (now - started) / SPIN_MS);
        const eased = 1 - (1 - t) ** 3;
        drawWheel(canvas, names, from + (target - from) * eased);
        if (t < 1) requestAnimationFrame(frame);
        else resolve(target % (Math.PI * 2));
      };
      requestAnimationFrame(frame);
    });
  }

  function wheelDialog(title, names) {
    const dialog = document.createElement('dialog');
    dialog.className = 'wheel-dialog';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const canvas = document.createElement('canvas');
    canvas.width = 340;
    canvas.height = 340;
    canvas.className = 'wheel-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `A wheel of ${names.length} poomsae: ${names.join(', ')}`);
    const status = document.createElement('p');
    status.className = 'wheel-status';
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Spinning…';
    const picked = document.createElement('ol');
    picked.className = 'wheel-picked';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'btn';
    done.textContent = 'Done';
    done.disabled = true;
    dialog.append(heading, canvas, status, picked, done);
    drawWheel(canvas, names, -Math.PI / 2);
    return { dialog, canvas, status, picked, done };
  }

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (event.defaultPrevented || !form.matches('[data-poomsae-wheel]') || !window.fetch || !window.HTMLDialogElement) return;
    let names;
    try { names = JSON.parse(form.dataset.list); } catch (error) { return; }
    event.preventDefault();
    const ui = wheelDialog(form.dataset.title, names);
    document.body.append(ui.dialog);
    ui.dialog.showModal();
    let result;
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
      });
      result = await response.json();
    } catch (error) {
      result = { ok: false, error: 'The draw could not be made. Check the connection and try again.' };
    }
    const finish = () => {
      const target = new URL(result.back || window.location.href, window.location.href);
      if (target.pathname + target.search === window.location.pathname + window.location.search) {
        window.location.hash = target.hash;
        window.location.reload();
      } else window.location.assign(target.href);
    };
    ui.done.addEventListener('click', finish);
    ui.dialog.addEventListener('close', finish);
    if (!result.ok) {
      ui.status.textContent = result.error || 'The draw could not be made.';
      ui.done.disabled = false;
      return;
    }
    const wheel = result.list && result.list.length >= 2 ? result.list : names;
    let angle = -Math.PI / 2;
    for (const [i, name] of result.names.entries()) {
      ui.status.textContent = `Spinning for poomsae ${i + 1} of ${result.names.length}…`;
      angle = await spinTo(ui.canvas, wheel, angle, Math.max(0, wheel.indexOf(name)));
      const item = document.createElement('li');
      item.textContent = name;
      ui.picked.append(item);
    }
    ui.status.textContent = `Drawn: ${result.names.join(' and ')}.`;
    ui.done.disabled = false;
    ui.done.focus();
  });
}());

// "More" menus (<details class="menu">): one open at a time, closed by a click
// elsewhere or Escape. Without JavaScript they still open and close on click.
(function () {
  const closeAll = (except) => document.querySelectorAll('details.menu[open]').forEach((menu) => { if (menu !== except) menu.open = false; });
  document.addEventListener('click', (event) => closeAll(event.target.closest('details.menu')));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAll(null); });
}());

// Opening a link to a section inside a folded card (<details class="fold">) unfolds it.
(() => {
  const unfold = () => {
    const target = window.location.hash && document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    const fold = target && target.closest('details.fold');
    if (fold) fold.open = true;
  };
  unfold();
  window.addEventListener('hashchange', unfold);
})();

// Coaches and admins: keeps the unread notifications count current while a page
// stays open, through the /notifications/events stream. A rise is announced.
(function liveNotificationCount() {
  const link = document.querySelector('#main-nav a[href="/notifications"]');
  if (!link) return;
  const toggle = document.querySelector('.nav-toggle');
  const status = document.createElement('span');
  status.className = 'visually-hidden';
  status.setAttribute('role', 'status');
  document.body.append(status);
  let shown = Number((link.querySelector('.nav-count') || { firstChild: { textContent: '0' } }).firstChild.textContent) || 0;

  const badge = (count, words) => {
    const span = document.createElement('span');
    span.className = 'nav-count';
    span.textContent = count > 99 ? '99+' : String(count);
    const hidden = document.createElement('span');
    hidden.className = 'visually-hidden';
    hidden.textContent = words;
    span.append(hidden);
    return span;
  };
  const place = (element, count, words) => {
    if (!element) return;
    const old = element.querySelector('.nav-count');
    if (old) old.remove();
    if (count > 0) element.append(badge(count, words));
  };
  const show = (unread) => {
    if (!Number.isInteger(unread) || unread === shown) return;
    place(link, unread, ' unread');
    place(toggle, unread, ' unread notifications');
    if (unread > shown) status.textContent = `${unread} unread notification${unread === 1 ? '' : 's'}`;
    shown = unread;
  };

  // Live: the server sends the count as soon as a notice is added or read.
  if (window.EventSource) {
    const events = new EventSource('/notifications/events');
    events.addEventListener('unread', (event) => show(Number(event.data)));
    return;
  }

  // Without event streams, check once a minute while the tab is visible.
  const check = async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const response = await fetch('/notifications/count', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!response.ok || !(response.headers.get('content-type') || '').includes('json')) return;
      show((await response.json()).unread);
    } catch (error) {
      // Offline or logged out: try again next time.
    }
  };
  setInterval(check, 60000);
  document.addEventListener('visibilitychange', check);
})();

// Weigh-in "Scan card": reads an athlete card's QR code with a phone camera or a
// laptop/USB webcam and opens that athlete's weigh-in row. Uses the browser's
// BarcodeDetector where it has one, else jsQR (loaded only when needed). Without
// a camera the button stays hidden.
(function scanCard() {
  const button = document.querySelector('[data-scan-card]');
  if (!button || !window.HTMLDialogElement || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  const competitionId = button.dataset.scanCard;
  const CAMERA_KEY = 'gms-scan-camera';
  button.hidden = false;

  const remembered = () => { try { return localStorage.getItem(CAMERA_KEY) || ''; } catch (error) { return ''; } };
  const remember = (id) => { try { localStorage.setItem(CAMERA_KEY, id); } catch (error) { /* private window */ } };

  let jsQRLoaded = null;
  const loadJsQR = () => jsQRLoaded || (jsQRLoaded = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/jsQR.js';
    script.onload = () => resolve(window.jsQR);
    script.onerror = () => { jsQRLoaded = null; reject(new Error('jsQR')); };
    document.head.append(script);
  }));

  // A reader that takes a video frame and returns the QR text, or null.
  const makeReader = async () => {
    if (window.BarcodeDetector) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          return async (video) => ((await detector.detect(video))[0] || {}).rawValue || null;
        }
      } catch (error) { /* fall back to jsQR */ }
    }
    const jsQR = await loadJsQR();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let turn = 0;
    // Alternates the whole frame with its middle at full detail: a webcam's card
    // QR is small in the picture, and shrinking the whole frame blurs it away.
    return async (video) => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      const side = Math.min(w, h);
      turn += 1;
      const [sx, sy, sw, sh] = turn % 2 ? [0, 0, w, h] : [(w - side) / 2, (h - side) / 2, side, side];
      const scale = Math.min(1, 960 / Math.max(sw, sh));
      canvas.width = Math.round(sw * scale);
      canvas.height = Math.round(sh * scale);
      context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const found = jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
      return found ? found.data : null;
    };
  };

  // Only athlete cards: /admin/competitions/<id>/athletes/<fighter>, from any host.
  const readCard = (text) => {
    let url;
    try { url = new URL(text); } catch (error) { return null; }
    const match = url.pathname.match(/^\/admin\/competitions\/(\d+)\/athletes\/(\d+)\/?$/);
    return match ? { competitionId: match[1], fighterId: match[2] } : null;
  };

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  button.addEventListener('click', async () => {
    const dialog = element('dialog', 'scan-dialog');
    const heading = element('h2', '', 'Scan an athlete card');
    const video = element('video', 'scan-video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    const status = element('p', 'scan-status', 'Starting the camera…');
    status.setAttribute('aria-live', 'polite');
    const pickerRow = element('p', 'scan-camera');
    pickerRow.hidden = true;
    const picker = element('select');
    picker.id = 'scan-camera';
    const pickerLabel = element('label', '', 'Camera');
    pickerLabel.htmlFor = picker.id;
    pickerRow.append(pickerLabel, picker);
    const close = element('button', 'btn secondary', 'Close');
    close.type = 'button';
    dialog.append(heading, video, status, pickerRow, close);
    document.body.append(dialog);
    dialog.showModal();

    let stream = null;
    let running = true;
    const stopStream = () => {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      stream = null;
    };
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { running = false; stopStream(); dialog.remove(); });

    // Starts the chosen camera, or else the back camera on a phone. A large
    // picture is asked for, since a card held up to a webcam is small in it.
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const anyCamera = { facingMode: { ideal: 'environment' }, ...size };
    const start = async (deviceId) => {
      stopStream();
      let next;
      try {
        next = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId }, ...size } : anyCamera, audio: false });
      } catch (error) {
        // A remembered camera that's since been unplugged: use any camera.
        if (!deviceId || !['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(error.name)) throw error;
        next = await navigator.mediaDevices.getUserMedia({ video: anyCamera, audio: false });
      }
      if (!running) {
        next.getTracks().forEach((track) => track.stop());
        return '';
      }
      stream = next;
      const settings = stream.getVideoTracks()[0].getSettings();
      // A webcam faces the official, so it's shown like a mirror; a phone's back camera isn't.
      video.classList.toggle('scan-mirror', settings.facingMode !== 'environment');
      video.srcObject = stream;
      await video.play();
      return settings.deviceId || '';
    };

    let current;
    try {
      current = await start(remembered());
    } catch (error) {
      video.hidden = true;
      status.textContent = error && error.name === 'NotAllowedError'
        ? 'The camera is blocked. Allow it for this site in the browser, or search by name instead.'
        : 'No camera could be started. Check it isn’t in use by another app, or search by name instead.';
      return;
    }
    if (!running) return;

    // Camera names are only given once the camera is allowed, so list them now.
    try {
      const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      if (cameras.length > 1) {
        cameras.forEach((camera, i) => {
          const option = element('option', '', camera.label || `Camera ${i + 1}`);
          option.value = camera.deviceId;
          option.selected = camera.deviceId === current;
          picker.append(option);
        });
        pickerRow.hidden = false;
        picker.addEventListener('change', async () => {
          status.textContent = 'Switching camera…';
          try {
            await start(picker.value);
            remember(picker.value);
            status.textContent = 'Hold the card’s QR code in front of the camera.';
          } catch (error) {
            status.textContent = 'That camera could not be started. Try another one.';
          }
        });
      }
    } catch (error) { /* no camera list: keep the one that started */ }

    let read;
    try {
      read = await makeReader();
    } catch (error) {
      status.textContent = 'The scanner could not load. Check the connection, or search by name instead.';
      return;
    }
    status.textContent = 'Hold the card’s QR code in front of the camera.';

    let lastWrong = '';
    const tick = async () => {
      if (!running) return;
      let text = null;
      if (stream && video.readyState >= 2 && video.videoWidth) {
        try { text = await read(video); } catch (error) { text = null; }
      }
      const card = text && readCard(text);
      if (card && card.competitionId === competitionId) {
        status.textContent = 'Found. Opening their weigh-in…';
        running = false;
        stopStream();
        window.location.assign(`/admin/competitions/${competitionId}/weigh-in/athlete/${card.fighterId}`);
        return;
      }
      if (text && text !== lastWrong) {
        lastWrong = text;
        status.textContent = card ? 'This card is for a different competition.' : 'That QR code isn’t an athlete card.';
      }
      setTimeout(tick, 120);
    };
    tick();
  });
})();
