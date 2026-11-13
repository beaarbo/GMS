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
    button.textContent = open ? 'Close menu' : 'Menu';
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
