/* MeridianDataHub — the pages behind a share link (/a/<address>, /p/<address>; js/cards.js sharePage) send people on to
 * the page they link to. A script, not a <meta http-equiv="refresh">: Facebook's crawler follows a meta refresh and would
 * then show the home page's card instead of this link's. A file of the site's own, so the Content-Security-Policy needs no
 * hash for it; the target is the page's own #go link, written (escaped) by the build. */
(function () {
  var a = document.getElementById('go');
  if (a && a.getAttribute('href')) location.replace(a.getAttribute('href'));
})();
