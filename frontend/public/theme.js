/*
 * Puts the chosen theme on the page before the stylesheet paints anything, so a light theme does not
 * open on a flash of the dark one.
 *
 * A file rather than an inline script because the Content-Security-Policy allows scripts from this
 * origin and nothing else. It mirrors `resolveTheme` in src/lib/theme.ts, and theme.spec.ts runs this
 * very file against it, so the two cannot come to disagree about what a stored choice means.
 */
;(function () {
  const themes = ['osmium', 'osmium-light', 'midnight', 'graphite', 'paper']
  let choice = null
  try {
    choice = window.localStorage.getItem('osmium.theme')
  } catch {
    choice = null
  }
  if (themes.indexOf(choice) === -1) {
    const dark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
    choice = dark ? 'osmium' : 'osmium-light'
  }
  document.documentElement.setAttribute('data-theme', choice)
})()
