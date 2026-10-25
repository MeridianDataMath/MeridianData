/* MeridianDataHub — the pages behind a share link (/a/<address>, /p/<address>; js/cards.js sharePage) send people on to
 * the page they link to. A script, not a <meta http-equiv="refresh">: Facebook's crawler follows a meta refresh and would
 * then show the home page's card instead of this link's. A file of the site's own, so the Content-Security-Policy needs no
 * hash for it; the target is the page's own #go link, written (escaped) by the build. */
(function () {
  var a = document.getElementById('go'); var to = a && a.getAttribute('href');
  if (!to) return;
  // a slip's link can carry its sharer's referral code (?r=): the slip page puts it on that slip's Meridian buttons
  var r = /[?&]r=([A-Za-z0-9]{4,32})(?:&|$)/.exec(location.search);
  if (r && /^\/#\/predict\/p\/0x[0-9a-f]{64}$/i.test(to)) to += '?r=' + r[1];
  location.replace(to);
})();
