(function () {
  var root = document.documentElement;
  var motion = root.classList.contains('motion');
  var MU = window.MU || {};
  function each(selector, fn) { Array.prototype.forEach.call(document.querySelectorAll(selector), fn); }
  function store(kind, key, value) {
    try {
      var s = kind === 'session' ? sessionStorage : localStorage;
      if (value === undefined) return s.getItem(key);
      if (value === null) s.removeItem(key); else s.setItem(key, value);
    } catch (e) {}
    return null;
  }

  // ---- Nav state ----
  var nav = document.querySelector('.nav');
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      if (nav) nav.classList.toggle('scrolled', (window.scrollY || 0) > 8);
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---- Popover menus: one open at a time, closed by a click outside or Escape ----
  var pops = Array.prototype.slice.call(document.querySelectorAll('details.pop'));
  pops.forEach(function (pop) {
    pop.addEventListener('toggle', function () {
      if (pop.open) pops.forEach(function (other) { if (other !== pop) other.open = false; });
    });
  });
  document.addEventListener('click', function (event) {
    pops.forEach(function (pop) { if (pop.open && !pop.contains(event.target)) pop.open = false; });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    pops.forEach(function (pop) {
      if (!pop.open) return;
      pop.open = false;
      pop.querySelector('summary').focus();
    });
  });

  // A language picked by hand wins over the browser's language from then on.
  each('[data-lang]', function (link) {
    link.addEventListener('click', function () { store('local', 'mu:lang', link.getAttribute('data-lang')); });
  });

  // ---- GitHub stars: the number from the last build, refreshed at most once an hour ----
  function formatStars(n) {
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
  function showStars(n, animate) {
    each('[data-star-count]', function (el) {
      var text = formatStars(n);
      if (el.textContent === text) return;
      el.textContent = text;
      if (animate && motion) {
        el.classList.remove('bump');
        void el.offsetWidth;
        el.classList.add('bump');
      }
    });
  }
  var cached = null;
  try { cached = JSON.parse(store('local', 'mu:stars') || 'null'); } catch (e) {}
  if (cached && typeof cached.n === 'number') showStars(cached.n, false);
  if (window.fetch && (!cached || Date.now() - cached.at > 3600 * 1000)) {
    fetch('https://api.github.com/repos/qybaihe/mu')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (repo) {
        if (!repo || typeof repo.stargazers_count !== 'number') return;
        store('local', 'mu:stars', JSON.stringify({ n: repo.stargazers_count, at: Date.now() }));
        showStars(repo.stargazers_count, true);
      })
      .catch(function () {});
  }

  // ---- Copy buttons ----
  each('[data-copy]', function (button) {
    var label = button.textContent;
    button.addEventListener('click', function () {
      var text = button.getAttribute('data-copy');
      var done = function () {
        button.textContent = MU.copied || label;
        button.classList.add('done');
        setTimeout(function () { button.textContent = label; button.classList.remove('done'); }, 1600);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, function () {});
      } else {
        var area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        document.body.removeChild(area);
      }
    });
  });

  // ---- Hero: split the headline into characters, type the kicker and the command ----
  var h1 = document.querySelector('[data-split]');
  if (h1 && motion) {
    var n = 0;
    var label = h1.textContent;
    (function split(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 3) {
          var frag = document.createDocumentFragment();
          // Latin and Hangul words rise as one piece, so a line never breaks inside a word.
          (child.textContent.match(/[A-Za-z0-9'’.,-]+|[\uAC00-\uD7A3]+|\s+|[\s\S]/g) || []).forEach(function (part) {
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
            var s = document.createElement('span');
            s.className = 'ch';
            s.style.setProperty('--i', n++);
            s.textContent = part;
            frag.appendChild(s);
          });
          node.replaceChild(frag, child);
        } else if (child.nodeType === 1) {
          split(child);
        }
      });
    })(h1);
    h1.setAttribute('aria-label', label);
  }
  function type(el, delay, speed) {
    var text = el.getAttribute('data-type');
    if (!motion) return;
    el.textContent = '';
    var caret = document.createElement('span');
    caret.className = 'caret';
    caret.setAttribute('aria-hidden', 'true');
    el.appendChild(caret);
    var i = 0;
    setTimeout(function tick() {
      caret.insertAdjacentText('beforebegin', text.charAt(i++));
      if (i < text.length) setTimeout(tick, speed + Math.random() * speed * 0.6);
      else if (!el.closest('.cmd')) setTimeout(function () { caret.remove(); }, 1600);
    }, delay);
  }
  each('[data-type]', function (el) {
    var delay = Number(el.getAttribute('data-type-delay') || 200);
    type(el, delay, el.closest('.cmd') ? 55 : 32);
  });

  // ---- Install tabs, with a sliding underline ----
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var ink = document.querySelector('.tab-ink');
  function placeInk(tab) {
    if (!ink || !tab) return;
    ink.style.width = tab.offsetWidth + 'px';
    ink.style.transform = 'translateX(' + tab.offsetLeft + 'px)';
  }
  function selectTab(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    placeInk(tab);
    if (focus) tab.focus();
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { selectTab(tab); });
    tab.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        selectTab(tabs[(i + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true);
      }
    });
  });
  if (tabs.length) {
    placeInk(tabs[0]);
    window.addEventListener('resize', function () { placeInk(document.querySelector('.tab[aria-selected="true"]')); });
  }

  // Put this visitor's platform first among the downloads.
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  var ua = navigator.userAgent;
  var os = /Win/i.test(platform) ? 'win' : /Linux/i.test(platform) && !/Android/i.test(ua) ? 'linux' : /Mac/i.test(platform) ? 'mac' : '';
  var downloads = document.querySelector('.downloads');
  if (os && downloads) {
    var firstOs = downloads.querySelector('[data-os="' + os + '"]');
    if (firstOs) {
      each('.downloads .btn', function (b) { b.classList.remove('primary'); });
      firstOs.classList.add('primary');
      downloads.insertBefore(firstOs, downloads.firstChild);
    }
  }

  // Point the download buttons at the newest desktop release (tags v*, published as pre-releases).
  if (window.fetch && document.querySelector('[data-asset]')) {
    fetch('https://api.github.com/repos/qybaihe/mu/releases?per_page=10')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        var release = (list || []).filter(function (r) { return !r.draft && /^v\d/.test(r.tag_name); })[0];
        if (!release) return;
        each('[data-asset]', function (a) {
          var suffix = '-' + a.getAttribute('data-asset');
          var asset = (release.assets || []).filter(function (x) { return x.name.slice(-suffix.length) === suffix; })[0];
          if (asset) a.href = asset.browser_download_url;
        });
        each('[data-version]', function (el) { el.textContent = release.tag_name; });
      })
      .catch(function () {});
  }

  // ---- Terminal replay: frames recorded from a real mu session ----
  var data = null;
  var dataEl = document.getElementById('replay-data');
  if (dataEl) { try { data = JSON.parse(dataEl.textContent); } catch (e) {} }
  var SEG_ORDER = ['start', 'fail', 'edit', 'done'];
  function Player(figure) {
    this.pre = figure.querySelector('.term-body');
    this.caption = figure.querySelector('figcaption');
    this.steps = figure.querySelectorAll('.steps i');
    this.timer = null;
    this.seg = null;
    this.onFrame = null;
    var self = this;
    var replay = figure.querySelector('.replay');
    if (replay) replay.addEventListener('click', function () { if (self.seg) self.play(self.seg, true); });
  }
  Player.prototype.render = function (i) {
    var rows = data.frames[i][1];
    var html = new Array(rows.length);
    for (var r = 0; r < rows.length; r++) html[r] = data.table[rows[r]];
    this.pre.innerHTML = html.join('\n');
    if (this.onFrame) this.onFrame(i);
  };
  Player.prototype.play = function (seg, again) {
    if (!data || !data.segments[seg]) return;
    if (this.seg === seg && !again) return;
    this.seg = seg;
    clearTimeout(this.timer);
    var range = data.segments[seg];
    var self = this;
    var at = SEG_ORDER.indexOf(seg);
    Array.prototype.forEach.call(this.steps, function (s, k) { s.classList.toggle('on', k <= at); });
    if (!motion) { this.render(range[1]); return; }
    var i = range[0];
    this.render(i);
    function next() {
      if (i >= range[1]) return;
      var gap = (data.frames[i + 1][0] - data.frames[i][0]) * 1000;
      i++;
      self.timer = setTimeout(function () { self.render(i); next(); }, Math.max(16, Math.min(gap, 1400)));
    }
    this.timer = setTimeout(next, 450);
  };
  Player.prototype.setCaption = function (text) {
    if (this.caption && text) this.caption.textContent = text;
  };

  // The spinner in "Working" turns, as it does in the terminal.
  if (motion && data) {
    var SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    var phase = 0;
    setInterval(function () {
      phase = (phase + 1) % SPIN.length;
      var spins = document.querySelectorAll('.term-body .sp');
      for (var k = 0; k < spins.length; k++) spins[k].textContent = SPIN[phase];
    }, 80);
  }

  // ---- Story: the stage follows the chapter in the middle of the screen ----
  var frames = {};
  each('.stage .frame', function (f) { frames[f.getAttribute('data-frame')] = f; });
  var stagePlayer = frames.term && data ? new Player(frames.term) : null;
  var verdict = document.querySelector('.verdict');
  if (stagePlayer && verdict) {
    stagePlayer.onFrame = function (i) { verdict.classList.toggle('lit', stagePlayer.seg === 'start' && i >= data.marks.verdict); };
  }
  var chapters = Array.prototype.slice.call(document.querySelectorAll('.chapter'));

  // Narrow screens: each chapter gets its own copy of its picture, and terminal copies replay their own part.
  chapters.forEach(function (chapter) {
    var slot = chapter.querySelector('.inline-frame');
    var source = frames[chapter.getAttribute('data-frame')];
    if (!slot || !source) return;
    var copy = source.cloneNode(true);
    copy.classList.add('is-active');
    slot.appendChild(copy);
    if (chapter.getAttribute('data-seg') && data) {
      var player = new Player(copy);
      player.setCaption(chapter.getAttribute('data-caption'));
      player.render(data.segments[chapter.getAttribute('data-seg')][1]);
      chapter._player = player;
    }
  });

  function activate(chapter) {
    chapters.forEach(function (c) { c.classList.toggle('is-current', c === chapter); });
    var name = chapter.getAttribute('data-frame');
    Object.keys(frames).forEach(function (key) { frames[key].classList.toggle('is-active', key === name); });
    var seg = chapter.getAttribute('data-seg');
    if (seg && stagePlayer) {
      stagePlayer.setCaption(chapter.getAttribute('data-caption'));
      stagePlayer.play(seg);
    }
  }
  if (chapters.length) {
    chapters[0].classList.add('is-current');
    if (frames[chapters[0].getAttribute('data-frame')]) frames[chapters[0].getAttribute('data-frame')].classList.add('is-active');
    if (stagePlayer) {
      stagePlayer.setCaption(chapters[0].getAttribute('data-caption'));
      stagePlayer.render(data.segments.start[motion ? 0 : 1]);
    }
  }
  var wide = window.matchMedia ? window.matchMedia('(min-width: 981px)') : { matches: true };

  // ---- Table of contents on reading pages: mark the section being read ----
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"], .docs-toc a[href^="#"]'));
  var tocTargets = tocLinks.map(function (a) { return document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))); });
  function markToc() {
    var current = -1;
    var line = 120;
    tocTargets.forEach(function (el, k) { if (el && el.getBoundingClientRect().top <= line) current = k; });
    tocLinks.forEach(function (a, k) { a.classList.toggle('on', k === current); });
  }
  if (tocLinks.length) {
    window.addEventListener('scroll', function () { requestAnimationFrame(markToc); }, { passive: true });
    markToc();
  }
  // The docs sidebar and an in-page table of contents fold away on narrow screens.
  each('details.toc, details.docs-nav', function (toc) {
    var tocWide = window.matchMedia ? window.matchMedia('(min-width: 981px)') : { matches: true };
    var syncToc = function () { toc.open = tocWide.matches; };
    syncToc();
    if (tocWide.addEventListener) tocWide.addEventListener('change', syncToc);
    Array.prototype.forEach.call(toc.querySelectorAll('a'), function (a) { a.addEventListener('click', function () { if (!tocWide.matches) toc.open = false; }); });
  });

  // ---- Decision points: filter by group, search, and jump to one ----
  var dpCards = Array.prototype.slice.call(document.querySelectorAll('.dp'));
  var dpFilters = Array.prototype.slice.call(document.querySelectorAll('.dp-filter'));
  var dpSearch = document.querySelector('[data-dp-search]');
  var dpGroup = 'all';
  function dpApply() {
    var q = dpSearch ? dpSearch.value.trim().toLowerCase() : '';
    var shown = 0;
    dpCards.forEach(function (card) {
      var on = (dpGroup === 'all' || card.getAttribute('data-group') === dpGroup) && (!q || card.getAttribute('data-text').indexOf(q) !== -1);
      card.hidden = !on;
      if (on) shown++;
    });
    each('.dp-group', function (g) { g.hidden = !g.querySelector('.dp:not([hidden])'); });
    var empty = document.querySelector('.dp-empty');
    if (empty) empty.hidden = shown > 0;
  }
  dpFilters.forEach(function (button) {
    button.addEventListener('click', function () {
      dpGroup = button.getAttribute('data-filter');
      dpFilters.forEach(function (b) { b.setAttribute('aria-pressed', b === button ? 'true' : 'false'); });
      dpApply();
    });
  });
  if (dpSearch) dpSearch.addEventListener('input', dpApply);
  function dpFlash(id) {
    var card = document.getElementById(id);
    if (!card || !card.classList.contains('dp')) return;
    if (card.hidden) {
      dpGroup = 'all';
      if (dpSearch) dpSearch.value = '';
      dpFilters.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-filter') === 'all' ? 'true' : 'false'); });
      dpApply();
    }
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
    setTimeout(function () { card.classList.remove('flash'); }, 1800);
  }
  if (dpCards.length) {
    window.addEventListener('hashchange', function () { dpFlash(decodeURIComponent(location.hash.slice(1))); });
    if (location.hash) dpFlash(decodeURIComponent(location.hash.slice(1)));
  }

  // ---- Videos on reading pages play while they are on screen, only with motion allowed ----
  var videos = Array.prototype.slice.call(document.querySelectorAll('video[data-autoplay]'));
  if (!motion) videos.forEach(function (v) { v.controls = true; });

  if ('IntersectionObserver' in window) {
    var storyObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        if (wide.matches) activate(entry.target);
        else if (entry.target._player) entry.target._player.play(entry.target.getAttribute('data-seg'));
      });
    }, { rootMargin: '-40% 0px -45% 0px' });
    chapters.forEach(function (c) { storyObserver.observe(c); });

    if (motion) {
      var videoObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var v = entry.target;
          if (entry.isIntersecting) { var p = v.play(); if (p && p.catch) p.catch(function () { v.controls = true; }); }
          else v.pause();
        });
      }, { threshold: 0.35 });
      videos.forEach(function (v) { videoObserver.observe(v); });
    }

    // ---- Reveal on scroll ----
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    each('[data-reveal]', function (el) { revealObserver.observe(el); });
  } else {
    each('[data-reveal]', function (el) { el.classList.add('in'); });
    videos.forEach(function (v) { v.controls = true; });
  }

  // ---- Appearance: auto follows the system; the choice is remembered in this browser only ----
  var themeButtons = document.querySelectorAll('[data-theme-set]');
  function currentMode() { return root.getAttribute('data-theme') || 'auto'; }
  function paint() {
    Array.prototype.forEach.call(themeButtons, function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-theme-set') === currentMode() ? 'true' : 'false'); });
  }
  Array.prototype.forEach.call(themeButtons, function (b) {
    b.addEventListener('click', function () {
      var mode = b.getAttribute('data-theme-set');
      if (mode === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
      store('local', 'mu:theme', mode === 'auto' ? null : mode);
      paint();
    });
  });
  paint();
})();
