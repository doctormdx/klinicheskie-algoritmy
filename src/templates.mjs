// HTML-шаблоны страниц
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PATIENT_SHORT = {
  'Взрослые': 'Взрослые',
  'Дети и подростки': 'Дети',
  'Новорождённые и младенцы': 'Новорождённые',
  'Беременные': 'Беременные',
};

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
export const schemesCount = (n) => `${n} ${plural(n, 'схема', 'схемы', 'схем')}`;

const ICON_SEARCH = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15zM16 16l5 5"/></svg>';
const ICON_CHEVRON = '<svg class="chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>';

function metrika(id) {
  if (!/^\d+$/.test(String(id || ''))) return '';
  return `<script>(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();for(var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r){return;}}k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");ym(${id},"init",{clickmap:true,trackLinks:true,accurateTrackBounce:true,webvisor:true});</script><noscript><div><img src="https://mc.yandex.ru/watch/${id}" style="position:absolute;left:-9999px" alt=""></div></noscript>`;
}

function layout(ctx, { title, description, path, page, body, searchLink = true }) {
  const s = ctx.settings;
  const fullTitle = title ? `${title} — ${s.site_title}` : s.site_title;
  const canonical = s.site_url ? `<link rel="canonical" href="${esc(s.site_url + path)}">` : '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description || s.site_description)}">
${canonical}
<meta name="theme-color" content="#125b7c" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1419" media="(prefers-color-scheme: dark)">
<meta property="og:title" content="${esc(title || s.site_title)}">
<meta property="og:description" content="${esc(description || s.site_description)}">
<meta property="og:type" content="website">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${ctx.css}</style>
<script defer src="${ctx.appSrc}"></script>
</head>
<body data-page="${page}" data-index="${ctx.indexSrc}"${/^\d+$/.test(String(s.metrika_id || '')) ? ` data-ym="${s.metrika_id}"` : ''}>
<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="/">${esc(s.site_title)}</a>
    ${searchLink ? `<a class="top-search" href="/#q" aria-label="Поиск по схемам">${ICON_SEARCH}</a>` : ''}
  </div>
</header>
<main class="wrap">
${body}
</main>
<footer class="foot">
  <div class="wrap">${esc(s.footer_text || '')}</div>
</footer>
${metrika(s.metrika_id)}
</body>
</html>
`;
}

// Чипы-фильтры (одинаковые на главной и в разделах)
const filters = () => `
<div class="filters">
  <div class="chips" role="group" aria-label="Тип схемы" data-group="t">
    <button type="button" data-v="diag" aria-pressed="false">Диагностика</button>
    <button type="button" data-v="treat" aria-pressed="false">Лечение</button>
    <button type="button" data-v="prev" aria-pressed="false">Профилактика</button>
  </div>
  <div class="chips" role="group" aria-label="Пациенты" data-group="p">
    <button type="button" data-v="adult" aria-pressed="false">Взрослые</button>
    <button type="button" data-v="child" aria-pressed="false">Дети</button>
    <button type="button" data-v="newborn" aria-pressed="false">Новорождённые</button>
    <button type="button" data-v="preg" aria-pressed="false">Беременные</button>
  </div>
</div>`;

function metaLine(s, withSection) {
  const parts = [];
  if (withSection) parts.push(s.section.name);
  if (s.type) parts.push(s.type);
  if (s.patients?.length) parts.push(s.patients.map((p) => PATIENT_SHORT[p] || p).join(', '));
  return parts.join(' · ');
}

function row(s, withSection = false) {
  const k = [s.title, s.keywords, s.title_en].filter(Boolean).join(' ');
  return `<li data-y="${s.typeCodes.join(' ')}" data-p="${s.patientCodes.join(' ')}" data-k="${esc(k)}"><a href="${s.url}"><span class="t">${esc(s.title)}</span><span class="m">${esc(metaLine(s, withSection))}</span></a></li>`;
}

export function home(ctx, sections) {
  const body = `
<section class="hero">
  <h1 class="vh">${esc(ctx.settings.site_title)}</h1>
  <p class="lead">${esc(schemesCount(ctx.total))} на русском языке</p>
  <form class="search" role="search" action="/" method="get">
    <span class="search-ico">${ICON_SEARCH}</span>
    <input id="q" name="q" type="search" placeholder="Болезнь, симптом, сокращение" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Поиск по схемам">
    <button type="button" class="clear" aria-label="Очистить" hidden>×</button>
  </form>
  ${filters()}
</section>
<section id="results" hidden aria-live="polite">
  <p class="count"></p>
  <ul class="list"></ul>
  <button type="button" class="more" hidden>Показать ещё</button>
</section>
<section id="browse">
  <h2>Разделы</h2>
  <ul class="nav-list">
    ${sections.map((s) => `<li><a href="/r/${s.slug}/"><span class="t">${esc(s.name)}</span><span class="n">${s.schemes.length}</span>${ICON_CHEVRON}</a></li>`).join('\n    ')}
  </ul>
  <p class="all-link"><a href="/all/">Все схемы по алфавиту</a></p>
</section>`;
  return layout(ctx, { title: '', path: '/', page: 'home', body, searchLink: false });
}

export function section(ctx, sec) {
  const body = `
<nav class="crumbs" aria-label="Навигация"><a href="/">Главная</a></nav>
<h1>${esc(sec.name)}</h1>
<p class="lead">${esc(schemesCount(sec.schemes.length))}</p>
<div class="local-search">
  <input type="search" class="local-q" placeholder="Найти в разделе" autocomplete="off" enterkeyhint="search" aria-label="Найти в разделе">
</div>
${filters()}
<p class="count" hidden></p>
<ul class="list">
  ${sec.schemes.map((s) => row(s)).join('\n  ')}
</ul>
<p class="empty" hidden>Ничего не найдено. <button type="button" class="reset">Сбросить фильтры</button></p>`;
  return layout(ctx, {
    title: sec.name,
    description: `${sec.name}: ${schemesCount(sec.schemes.length)} — клинические алгоритмы диагностики и лечения.`,
    path: `/r/${sec.slug}/`,
    page: 'section',
    body,
  });
}

export function scheme(ctx, s) {
  const sameSection = s.section.schemes;
  const i = sameSection.indexOf(s);
  const related = sameSection.filter((x) => x !== s)
    .slice(Math.max(0, i - 4), Math.max(0, i - 4) + 8);
  const tags = [];
  if (s.type) tags.push(`<span>${esc(s.type)}</span>`);
  for (const p of s.patients || []) tags.push(`<span>${esc(p)}</span>`);
  const body = `
<nav class="crumbs" aria-label="Навигация"><a href="/">Главная</a><span aria-hidden="true">›</span><a href="/r/${s.section.slug}/">${esc(s.section.name)}</a></nav>
<h1 class="scheme-title">${esc(s.title)}</h1>
<p class="tags">${tags.join('')}</p>
<figure class="scheme">
  <a href="${s.img.src}" class="zoom" aria-label="Открыть схему в полном размере">
    <img src="${s.img.src}" width="${s.img.width}" height="${s.img.height}" alt="${esc(s.title)}" fetchpriority="high" decoding="async">
  </a>
  <figcaption>Нажмите на схему, чтобы открыть её в полном размере</figcaption>
</figure>
${s.keywords ? `<p class="kw">Сокращения и синонимы: ${esc(s.keywords)}</p>` : ''}
${s.extra.length ? `<p class="also">Также в разделах: ${s.extra.map((x) => `<a href="/r/${x.slug}/">${esc(x.name)}</a>`).join(', ')}</p>` : ''}
${related.length ? `<section class="related">
  <h2>Ещё в разделе «${esc(s.section.name)}»</h2>
  <ul class="list">
    ${related.map((x) => row(x)).join('\n    ')}
  </ul>
  <p class="all-link"><a href="/r/${s.section.slug}/">Все схемы раздела (${sameSection.length})</a></p>
</section>` : ''}`;
  return layout(ctx, {
    title: s.title,
    description: `${s.title}. ${s.section.name}. Клинический алгоритм на русском языке${s.keywords ? ` (${s.keywords})` : ''}.`,
    path: s.url,
    page: 'scheme',
    body,
  });
}

export function all(ctx, schemes) {
  const groups = new Map();
  for (const s of schemes) {
    const letter = s.title[0].toUpperCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(s);
  }
  const letters = [...groups.keys()];
  const body = `
<nav class="crumbs" aria-label="Навигация"><a href="/">Главная</a></nav>
<h1>Все схемы</h1>
<p class="lead">${esc(schemesCount(schemes.length))} по алфавиту</p>
<nav class="letters" aria-label="Буквы">${letters.map((l, i) => `<a href="#l${i}">${esc(l)}</a>`).join('')}</nav>
${letters.map((l, i) => `<h2 id="l${i}" class="letter">${esc(l)}</h2>
<ul class="list">
  ${groups.get(l).map((s) => row(s, true)).join('\n  ')}
</ul>`).join('\n')}`;
  return layout(ctx, { title: 'Все схемы по алфавиту', path: '/all/', page: 'all', body });
}

export function notFound(ctx) {
  const body = `
<h1>Страница не найдена</h1>
<p class="lead">Возможно, схема была переименована или удалена.</p>
<p><a class="btn" href="/">Перейти к поиску</a></p>`;
  return layout(ctx, { title: 'Страница не найдена', path: '/404.html', page: 'notfound', body });
}
