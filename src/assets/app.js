/* Поиск и фильтры. Без внешних библиотек. */
(function () {
  'use strict';
  var body = document.body;
  var YM = Number(body.getAttribute('data-ym')) || 0;
  var page = body.getAttribute('data-page');

  // Отметка «новое»: держится NEW_DAYS дней с даты добавления (дата по Москве, ГГГГ-ММ-ДД)
  var NEW_DAYS = Number(body.getAttribute('data-new-days')) || 30;
  function isNew(d) {
    return !!d && Date.now() - Date.parse(d + 'T00:00:00+03:00') < NEW_DAYS * 864e5;
  }
  var badges = document.querySelectorAll('.badge-new[data-d]');
  for (var bi = 0; bi < badges.length; bi++) {
    if (!isNew(badges[bi].getAttribute('data-d'))) badges[bi].parentNode.removeChild(badges[bi]);
  }

  function norm(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-z0-9а-я]+/g, ' ').trim();
  }
  function words(s) { var n = norm(s); return n ? n.split(' ') : []; }
  // Грубое отсечение окончаний, чтобы «пневмония» находила «пневмонии»
  var ENDINGS = /(иями|ями|ами|иях|ием|ией|ого|его|ому|ему|ыми|ими|ая|яя|ое|ее|ые|ие|ый|ий|ой|ей|ом|ем|ам|ям|ах|ях|ов|ев|ию|ия|ии|ью|ю|я|а|е|и|ы|у|о|ь)$/;
  function stem(w) {
    if (w.length < 5) return w;
    var s = w.replace(ENDINGS, '');
    return s.length >= 4 ? s : w;
  }
  function tokenScore(tok, st, fields) {
    var best = 0;
    for (var f = 0; f < fields.length; f++) {
      var ws = fields[f][0], wt = fields[f][1];
      for (var i = 0; i < ws.length; i++) {
        var w = ws[i], sc = 0;
        if (w === tok) sc = wt * 1.2;
        else if (w.indexOf(tok) === 0) sc = wt;
        else if (st !== tok && w.indexOf(st) === 0) sc = wt * 0.7;
        // части составных слов: «гематурия» → «макрогематурии»
        else if (st.length >= 5 && w.indexOf(st) > 0) sc = wt * 0.5;
        if (sc > best) best = sc;
      }
    }
    return best;
  }
  // Возвращает {score, all}: all=true, если совпали все слова запроса
  function match(tokens, fields) {
    var total = 0, hits = 0;
    for (var i = 0; i < tokens.length; i++) {
      var sc = tokenScore(tokens[i][0], tokens[i][1], fields);
      if (sc) { total += sc; hits++; }
    }
    return { score: total, all: hits === tokens.length, any: hits > 0 };
  }
  function queryTokens(q) {
    return words(q).map(function (w) { return [w, stem(w)]; });
  }

  // Состояние фильтров в адресной строке — кнопка «назад» возвращает к тем же результатам
  function readState() {
    var p = new URLSearchParams(location.search);
    return { q: p.get('q') || '', t: p.get('t') || '', p: p.get('p') || '' };
  }
  function writeState(st) {
    var p = new URLSearchParams();
    if (st.q) p.set('q', st.q);
    if (st.t) p.set('t', st.t);
    if (st.p) p.set('p', st.p);
    var qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }

  function setupChips(state, onChange) {
    var groups = document.querySelectorAll('.chips');
    function sync() {
      for (var g = 0; g < groups.length; g++) {
        var key = groups[g].getAttribute('data-group');
        var btns = groups[g].querySelectorAll('button');
        for (var b = 0; b < btns.length; b++) {
          btns[b].setAttribute('aria-pressed', String(state[key] === btns[b].getAttribute('data-v')));
        }
      }
    }
    for (var g = 0; g < groups.length; g++) {
      groups[g].addEventListener('click', function (e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        var key = this.getAttribute('data-group'), v = btn.getAttribute('data-v');
        state[key] = state[key] === v ? '' : v;
        sync();
        onChange();
      });
    }
    sync();
    return sync;
  }

  function passFilters(state, types, patients) {
    if (state.t && types.indexOf(state.t) < 0) return false;
    if (state.p && patients.indexOf(state.p) < 0) return false;
    return true;
  }

  // Метрика: что ищут и сколько нашли (цель «search»)
  var goalTimer, lastGoal = '';
  function trackSearch(q, n) {
    if (!YM || !window.ym) return;
    clearTimeout(goalTimer);
    goalTimer = setTimeout(function () {
      if (q.length < 3 || q === lastGoal) return;
      lastGoal = q;
      window.ym(YM, 'reachGoal', 'search', { search_query: q, results: n, not_found: n === 0 ? q : undefined });
    }, 1500);
  }

  var PATIENT_SHORT = { adult: 'Взрослые', child: 'Дети', newborn: 'Новорождённые', preg: 'Беременные' };
  var TYPE_LABEL = function (y) {
    if (y.length === 2) return 'Диагностика и лечение';
    return { diag: 'Диагностика', treat: 'Лечение и тактика', prev: 'Профилактика и скрининг' }[y[0]] || '';
  };
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  // ---------- Главная: поиск по всем схемам ----------
  function initHome() {
    var input = document.getElementById('q');
    var clearBtn = document.querySelector('.clear');
    var results = document.getElementById('results');
    var browse = document.getElementById('browse');
    var countEl = results.querySelector('.count');
    var listEl = results.querySelector('.list');
    var moreBtn = results.querySelector('.more');
    var state = readState();
    var data = null, loading = null, shown = 0, current = [];
    var PAGE = 40;

    input.value = state.q;

    function load() {
      if (data) return Promise.resolve(data);
      if (loading) return loading;
      loading = fetch(body.getAttribute('data-index')).then(function (r) { return r.json(); }).then(function (json) {
        json.items.forEach(function (it) {
          it.sec = json.sections[it.s] || '';
          it.f = [[words(it.t), 10], [words(it.k), 8], [words(it.e), 4], [words(it.sec), 3]];
        });
        data = json;
        return data;
      });
      return loading;
    }

    function renderList(reset) {
      if (reset) { listEl.innerHTML = ''; shown = 0; }
      var html = '';
      var end = Math.min(current.length, shown + PAGE);
      for (var i = shown; i < end; i++) {
        var it = current[i];
        var meta = [it.sec, TYPE_LABEL(it.y)];
        if (it.p.length) meta.push(it.p.map(function (c) { return PATIENT_SHORT[c]; }).join(', '));
        var badge = isNew(it.d) ? ' <span class="badge-new">новое</span>' : '';
        html += '<li><a href="' + it.u + '"><span class="t">' + esc(it.t) + badge + '</span><span class="m">' + esc(meta.filter(Boolean).join(' · ')) + '</span></a></li>';
      }
      listEl.insertAdjacentHTML('beforeend', html);
      shown = end;
      moreBtn.hidden = shown >= current.length;
    }

    function update() {
      writeState(state);
      clearBtn.hidden = !state.q;
      var active = state.q || state.t || state.p;
      results.hidden = !active;
      browse.hidden = !!active;
      if (!active) return;
      load().then(function (d) {
        var items = d.items.filter(function (it) { return passFilters(state, it.y, it.p); });
        var note = '';
        if (state.q) {
          var toks = queryTokens(state.q);
          var scored = [], partial = [];
          items.forEach(function (it) {
            var m = match(toks, it.f);
            if (m.all) scored.push([m.score, it]);
            else if (m.any) partial.push([m.score, it]);
          });
          if (!scored.length && partial.length && toks.length > 1) {
            scored = partial;
            note = 'Точных совпадений нет. Похожие схемы: ';
          }
          scored.sort(function (a, b) { return b[0] - a[0] || a[1].t.localeCompare(b[1].t, 'ru'); });
          items = scored.map(function (x) { return x[1]; });
          trackSearch(state.q.trim(), items.length);
        }
        current = items;
        countEl.textContent = items.length
          ? (note || 'Найдено: ') + items.length
          : 'Ничего не найдено. Попробуйте другое слово или сокращение.';
        renderList(true);
      });
    }

    var t;
    input.addEventListener('input', function () {
      state.q = input.value;
      clearTimeout(t);
      t = setTimeout(update, 120);
    });
    input.addEventListener('focus', load, { once: true });
    input.form.addEventListener('submit', function (e) { e.preventDefault(); input.blur(); });
    clearBtn.addEventListener('click', function () { input.value = ''; state.q = ''; update(); input.focus(); });
    moreBtn.addEventListener('click', function () { renderList(false); });
    setupChips(state, update);
    if (location.hash === '#q') { input.focus(); }
    update();
    // Заранее подгружаем индекс, когда страница уже отрисована
    setTimeout(load, 1500);
  }

  // ---------- Раздел: фильтр по списку на странице ----------
  function initSection() {
    var input = document.querySelector('.local-q');
    var items = [].slice.call(document.querySelectorAll('main > .list > li'));
    var countEl = document.querySelector('main > .count');
    var empty = document.querySelector('.empty');
    var state = readState();
    items.forEach(function (li) {
      li._y = (li.getAttribute('data-y') || '').split(' ');
      li._p = (li.getAttribute('data-p') || '').split(' ');
      li._f = [[words(li.getAttribute('data-k')), 10]];
    });
    input.value = state.q;
    function update() {
      writeState(state);
      var toks = queryTokens(state.q), n = 0;
      items.forEach(function (li) {
        var ok = passFilters(state, li._y, li._p) && (!toks.length || match(toks, li._f).all);
        li.hidden = !ok;
        if (ok) n++;
      });
      var active = state.q || state.t || state.p;
      countEl.hidden = !active || !n;
      countEl.textContent = 'Найдено: ' + n;
      empty.hidden = n > 0;
      if (state.q) trackSearch(state.q.trim(), n);
    }
    input.addEventListener('input', function () { state.q = input.value; update(); });
    var sync = setupChips(state, update);
    document.querySelector('.reset').addEventListener('click', function () {
      state.q = state.t = state.p = '';
      input.value = '';
      sync();
      update();
    });
    update();
  }

  // ---------- Новости: фильтр по специальности и тематике ----------
  function initNews() {
    var sel = document.getElementById('news-s');
    if (!sel) return; // новостей пока нет
    var items = [].slice.call(document.querySelectorAll('.news-list > li'));
    var countEl = document.querySelector('main > .count');
    var empty = document.querySelector('.empty');
    var p = new URLSearchParams(location.search);
    var state = { s: p.get('s') || '', t: p.get('t') || '' };
    sel.value = state.s;
    if (sel.value !== state.s) state.s = '';
    function update() {
      var n = 0;
      items.forEach(function (li) {
        var ok = (!state.s || (' ' + li.getAttribute('data-s') + ' ').indexOf(' ' + state.s + ' ') >= 0) &&
          (!state.t || li.getAttribute('data-t') === state.t);
        li.hidden = !ok;
        if (ok) n++;
      });
      countEl.hidden = !(state.s || state.t) || !n;
      countEl.textContent = 'Найдено: ' + n;
      empty.hidden = n > 0;
      var q = new URLSearchParams();
      if (state.s) q.set('s', state.s);
      if (state.t) q.set('t', state.t);
      var qs = q.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    }
    sel.addEventListener('change', function () { state.s = sel.value; update(); });
    var sync = setupChips(state, update);
    document.querySelector('.reset').addEventListener('click', function () {
      state.s = state.t = '';
      sel.value = '';
      sync();
      update();
    });
    update();
  }

  if (page === 'home') initHome();
  else if (page === 'section') initSection();
  else if (page === 'news') initNews();
})();
