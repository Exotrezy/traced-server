// Appearance is local to this browser. Automatic follows system changes.
(() => {
  const media = matchMedia('(prefers-color-scheme: light)');
  const button = document.getElementById('theme-btn');
  const select = document.getElementById('appearance');
  let preference = 'auto';
  try { const saved = localStorage.getItem('tracedAppearance'); if (['auto','light','dark'].includes(saved)) preference = saved; } catch {}
  function paint() {
    const theme = preference === 'auto' ? (media.matches ? 'light' : 'dark') : preference;
    document.documentElement.dataset.theme = theme;
    const next = theme === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-label', 'Switch to ' + next + ' mode');
    button.title = 'Switch to ' + next + ' mode';
    button.innerHTML = theme === 'dark'
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14a8.7 8.7 0 0 1-10.5-10.5A8.7 8.7 0 1 0 20.5 14Z"/></svg>';
    select.value = preference;
  }
  function save(value) { preference = value; try { localStorage.setItem('tracedAppearance',value); } catch {} paint(); }
  button.addEventListener('click', () => save(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  select.addEventListener('change', () => save(select.value));
  media.addEventListener('change',paint);
  paint();
})();
