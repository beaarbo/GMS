// Runs before the page draws, so a chosen theme doesn't flash. "light" or
// "dark" from the theme button (public/app.js); otherwise the device decides.
// A logged-in page names the account's choice (data-account-theme), which wins
// and is copied to this device for pages seen logged out.
(function applyTheme() {
  try {
    const account = document.documentElement.dataset.accountTheme;
    if (account === 'auto') window.localStorage.removeItem('theme');
    else if (account) window.localStorage.setItem('theme', account);
    const theme = window.localStorage.getItem('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch (error) {
    // Storage blocked (private browsing): the device's setting applies.
  }
}());
