// Runs before the page draws, so a chosen theme doesn't flash. "light" or
// "dark" from the theme button (public/app.js); otherwise the device decides.
(function applyTheme() {
  try {
    const theme = window.localStorage.getItem('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch (error) {
    // Storage blocked (private browsing): the device's setting applies.
  }
}());
