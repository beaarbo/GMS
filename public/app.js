// Progressive enhancement only: every feature also works through plain forms.

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
