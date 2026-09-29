// Сборка сайта: content/ -> dist/
// Запуск: npm run build
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { marked } from 'marked';
import * as T from './templates.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const OUT = path.join(ROOT, 'dist');

// «Новые схемы»
export const NEW_DAYS = 30;   // сколько дней после добавления схема отмечена «новое»
const NEW_ON_HOME = 5;        // сколько последних схем показывать на главной

const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
const write = async (rel, data) => {
  const p = path.join(OUT, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data);
};

const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
export const slugify = (s) =>
  [...s.toLowerCase()].map((c) => TR[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Типы и группы пациентов: значения из админки -> короткие коды для фильтров
export const TYPES = {
  'Диагностика': ['diag'],
  'Лечение и тактика': ['treat'],
  'Диагностика и лечение': ['diag', 'treat'],
  'Профилактика и скрининг': ['prev'],
};
export const PATIENTS = {
  'Взрослые': 'adult',
  'Дети и подростки': 'child',
  'Новорождённые и младенцы': 'newborn',
  'Беременные': 'preg',
};

// Дата добавления схемы = время коммита, в котором появился её файл
// (при сохранении новой схемы в админке это время сохранения).
// Схемы из самого первого коммита — исходный каталог — новыми не считаются.
function addedDates() {
  const git = (...args) => execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const dates = new Map();
  try {
    if (git('rev-parse', '--is-shallow-repository') === 'true') {
      console.warn('  история git неполная — «Новые схемы» не определены');
      return dates;
    }
    const roots = new Set(git('rev-list', '--max-parents=0', 'HEAD').split('\n'));
    const log = git('log', '--diff-filter=A', '--name-only', '--format=@%H %cI', '--', 'content/schemes');
    let commit = '', date = '';
    for (const line of log.split('\n')) {
      if (line.startsWith('@')) {
        [commit, date] = line.slice(1).split(' ');
        continue;
      }
      if (!line.endsWith('.json')) continue;
      const slug = slugify(path.basename(line, '.json'));
      // лог идёт от новых коммитов к старым: берём самое позднее добавление
      if (!dates.has(slug)) dates.set(slug, roots.has(commit) ? null : date);
    }
  } catch {
    console.warn('  git недоступен — «Новые схемы» не определены');
  }
  return dates;
}

const moscowDate = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

async function listJson(dir) {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

// Шрифты админки лежат на jsDelivr, который в РФ открывается нестабильно:
// при сборке скачиваем их и подменяем ссылки на локальные.
async function buildAdmin(settings) {
  const cmsDir = path.join(ROOT, 'node_modules', '@sveltia', 'cms', 'dist');
  let js = await fs.readFile(path.join(cmsDir, 'sveltia-cms.js'), 'utf8');
  const urls = [...new Set(js.match(/https:\/\/cdn\.jsdelivr\.net\/fontsource\/fonts\/[^)\s'"`]+\.woff2/g) || [])];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const name = `${hash(Buffer.from(url))}.woff2`;
      await write(`admin/fonts/${name}`, buf);
      js = js.split(url).join(`/admin/fonts/${name}`);
    } catch {
      console.warn(`  шрифт админки не скачан, останется внешняя ссылка: ${url}`);
    }
  }
  // Переводы интерфейса админки (в т.ч. русский) тоже берём из пакета, а не с unpkg.com
  const localesRe = /`\$\{\w+\}@\$\{\w+\}\/locales`/;
  if (localesRe.test(js)) {
    js = js.replace(localesRe, '`/admin/locales`');
    await fs.cp(path.join(cmsDir, '..', 'locales'), path.join(OUT, 'admin', 'locales'), { recursive: true });
  } else {
    console.warn('  не удалось подменить адрес переводов админки');
  }
  await write('admin/sveltia-cms.js', js);
  await fs.cp(path.join(cmsDir, 'chunks'), path.join(OUT, 'admin', 'chunks'), { recursive: true });
  let config = await fs.readFile(path.join(ROOT, 'admin', 'config.yml'), 'utf8');
  // Репозиторий подставляется автоматически при сборке на GitHub
  if (process.env.GITHUB_REPOSITORY) {
    config = config.replace(/^(\s*repo:).*$/m, `$1 ${process.env.GITHUB_REPOSITORY}`);
  }
  config = settings.site_url
    ? config.replace(/^site_url:.*$/m, `site_url: ${settings.site_url}`)
    : config.replace(/^site_url:.*\n/m, '');
  await write('admin/config.yml', config);
  await fs.copyFile(path.join(ROOT, 'admin', 'index.html'), path.join(OUT, 'admin', 'index.html'));
}

async function processImage(image, prefix) {
  const rel = (image || '').replace(/^\/?images\//, '');
  const src = path.join(CONTENT, 'images', rel);
  let buf = await fs.readFile(src);
  let img = sharp(buf);
  let meta = await img.metadata();
  // Всё, что не WebP или слишком большое, пережимаем в WebP
  if (meta.format !== 'webp' || meta.width > 2400) {
    buf = await img.resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).webp({ quality: 82 }).toBuffer();
    meta = await sharp(buf).metadata();
  }
  const name = `img/${prefix}-${hash(buf)}.webp`;
  await write(name, buf);
  return { src: `/${name}`, width: meta.width, height: meta.height, bytes: buf.length };
}

// ---------- Новости ----------

// Те же правила, что в поиске на сайте: нижний регистр, ё→е, грубое отсечение окончаний
const ENDINGS = /(иями|ями|ами|иях|ием|ией|ого|его|ому|ему|ыми|ими|ая|яя|ое|ее|ые|ие|ый|ий|ой|ей|ом|ем|ам|ям|ах|ях|ов|ев|ию|ия|ии|ью|ю|я|а|е|и|ы|у|о|ь)$/;
const stem = (w) => {
  if (w.length < 5) return w;
  const s = w.replace(ENDINGS, '');
  return s.length >= 4 ? s : w;
};
const terms = (text) => new Set(String(text || '').toLowerCase().replace(/ё/g, 'е')
  .replace(/[^a-z0-9а-я]+/g, ' ').trim().split(' ').filter((w) => w.length >= 3).map(stem));

// «Схемы по теме»: схемы из специальностей новости, у которых в названии или ключевых словах
// есть слова из новости. Редкие слова (ХОБЛ, пиелонефрит) весят больше частых (диагностика, лечение).
function relatedSchemes(news, allSchemes) {
  if (!relatedSchemes.idf) {
    const df = new Map();
    for (const s of allSchemes) for (const t of s.terms) df.set(t, (df.get(t) || 0) + 1);
    relatedSchemes.idf = (t) => Math.log(allSchemes.length / (df.get(t) || allSchemes.length));
  }
  const idf = relatedSchemes.idf;
  const text = terms(`${news.title} ${news.summary} ${(news.body || '').replace(/[#*_>`[\]()!]/g, ' ')}`);
  const pool = new Set(news.specs.flatMap((sec) => sec.schemes));
  return [...pool]
    .map((s) => [[...s.terms].reduce((sum, t) => sum + (text.has(t) ? idf(t) : 0), 0), s])
    .filter(([score]) => score >= 2.5)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 4)
    .map(([, s]) => s);
}

// Дата новости ГГГГ-ММ-ДД (из админки приходит именно так; на всякий случай разбираем и другие форматы)
function newsDate(v) {
  const m = String(v || '').match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const t = Date.parse(v);
  return Number.isNaN(t) ? '' : moscowDate(t);
}

async function loadNews(byName, sections, allSchemes) {
  const topics = [];
  for (const f of await listJson(path.join(CONTENT, 'topics'))) {
    const t = await readJson(path.join(CONTENT, 'topics', f));
    if (t.name) topics.push({ name: t.name.trim(), order: Number(t.order) || 999, slug: slugify(t.name) });
  }
  const topicByName = new Map(topics.map((t) => [t.name, t]));

  const news = [];
  for (const f of await listJson(path.join(CONTENT, 'news'))) {
    const n = await readJson(path.join(CONTENT, 'news', f));
    const slug = slugify(path.basename(f, '.json'));
    if (n.status === 'draft') continue; // черновик: ждёт проверки, на сайте не показываем
    if (!n.title || !n.section || !n.topic) {
      console.warn(`  пропущена новость ${f}: нет заголовка, специальности или тематики`);
      continue;
    }
    const specOf = (name) => {
      let sec = byName.get(name.trim());
      if (!sec) {
        sec = { name: name.trim(), order: 999, slug: slugify(name), schemes: [] };
        sections.push(sec);
        byName.set(sec.name, sec);
      }
      return sec;
    };
    const section = specOf(n.section);
    const specs = [section, ...(n.extra_sections || []).map(specOf).filter((x) => x !== section)];
    let topic = topicByName.get(n.topic.trim());
    if (!topic) {
      topic = { name: n.topic.trim(), order: 999, slug: slugify(n.topic) };
      topics.push(topic);
      topicByName.set(topic.name, topic);
    }
    const item = {
      slug,
      url: `/news/${slug}/`,
      title: n.title.trim(),
      date: newsDate(n.date),
      section,
      specs,
      topic,
      summary: (n.summary || '').trim(),
      body: n.body || '',
      source_url: (n.source_url || '').trim(),
      source_name: (n.source_name || '').trim(),
      image: n.image || '',
      telegram: (n.telegram || '').trim(),
    };

    // Текст: Markdown → HTML, картинки из текста сжимаем так же, как схемы
    let html = marked.parse(item.body);
    const imgs = [...html.matchAll(/<img src="\/images\/([^"]+)"/g)].map((m) => m[1]);
    for (const [i, rel] of imgs.entries()) {
      try {
        const img = await processImage(decodeURI(rel), `news-${slug}-${i + 1}`);
        html = html.replace(`<img src="/images/${rel}"`,
          `<img src="${img.src}" width="${img.width}" height="${img.height}" loading="lazy" decoding="async"`);
      } catch (e) {
        console.warn(`  новость ${slug}: нет картинки ${rel}`);
      }
    }
    item.html = html;
    if (item.image) {
      try {
        item.img = await processImage(item.image, `news-${slug}`);
      } catch {
        console.warn(`  новость ${slug}: нет картинки ${item.image}`);
      }
    }
    news.push(item);
  }

  news.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'ru'));
  for (const sec of sections) sec.news = [];
  for (const n of news) {
    for (const sec of n.specs) sec.news.push(n);
    n.related = relatedSchemes(n, allSchemes);
  }
  const usedTopics = topics.filter((t) => news.some((n) => n.topic === t))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru'));
  const usedSpecs = sections.filter((s) => s.news.length)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru'));
  return { news, usedTopics, usedSpecs };
}

async function main() {
  const t0 = Date.now();
  await fs.rm(OUT, { recursive: true, force: true });
  const settings = await readJson(path.join(CONTENT, 'settings.json'));
  settings.site_url = (settings.site_url || '').replace(/\/+$/, '');

  // Разделы
  const sections = [];
  for (const f of await listJson(path.join(CONTENT, 'sections'))) {
    const s = await readJson(path.join(CONTENT, 'sections', f));
    if (!s.name) continue;
    sections.push({ name: s.name.trim(), order: Number(s.order) || 999, slug: slugify(s.name), schemes: [] });
  }
  const byName = new Map(sections.map((s) => [s.name, s]));

  // Схемы
  const added = addedDates();
  const schemes = [];
  for (const f of await listJson(path.join(CONTENT, 'schemes'))) {
    const s = await readJson(path.join(CONTENT, 'schemes', f));
    const slug = slugify(path.basename(f, '.json'));
    if (!s.title || !s.image || !s.section) {
      console.warn(`  пропущена ${f}: нет названия, раздела или картинки`);
      continue;
    }
    let section = byName.get(s.section.trim());
    if (!section) {
      section = { name: s.section.trim(), order: 999, slug: slugify(s.section), schemes: [] };
      sections.push(section);
      byName.set(section.name, section);
    }
    const extra = (s.extra_sections || []).map((n) => byName.get(n.trim())).filter((x) => x && x !== section);
    const addedAt = added.get(slug) || null;
    schemes.push({
      ...s,
      slug,
      url: `/s/${slug}/`,
      title: s.title.trim(),
      section,
      extra,
      typeCodes: TYPES[s.type] || [],
      patientCodes: (s.patients || []).map((p) => PATIENTS[p]).filter(Boolean),
      keywords: (s.keywords || '').trim(),
      addedAt,
      added: addedAt ? moscowDate(addedAt) : '',
    });
  }
  const collator = new Intl.Collator('ru');
  schemes.sort((a, b) => collator.compare(a.title, b.title));
  for (const s of schemes) {
    s.section.schemes.push(s);
    for (const x of s.extra) x.schemes.push(s);
  }
  const visibleSections = sections.filter((s) => s.schemes.length)
    .sort((a, b) => a.order - b.order || collator.compare(a.name, b.name));

  // Картинки (параллельно, по 8)
  let totalImg = 0;
  for (let i = 0; i < schemes.length; i += 8) {
    await Promise.all(schemes.slice(i, i + 8).map(async (s) => {
      try {
        s.img = await processImage(s.image, s.slug);
        totalImg += s.img.bytes;
      } catch (e) {
        console.warn(`  нет картинки для ${s.slug}: ${e.message}`);
      }
    }));
  }
  const ready = schemes.filter((s) => s.img);

  // Новые схемы: всё, что добавлено после исходного каталога, — сначала самые свежие
  const now = Date.now();
  for (const s of ready) s.isNew = !!s.addedAt && now - Date.parse(s.addedAt) < NEW_DAYS * 864e5;
  const recent = ready.filter((s) => s.addedAt)
    .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt) || collator.compare(a.title, b.title));

  // Новости (связаны со схемами через специальности = разделы)
  for (const sec of visibleSections) sec.schemes = sec.schemes.filter((s) => s.img);
  for (const s of ready) s.terms = terms(`${s.title} ${s.keywords}`);
  const { news, usedTopics, usedSpecs } = await loadNews(byName, sections, ready);
  const pageSections = new Set(visibleSections);

  // Скрипт и поисковый индекс с хэшем в имени (долгое кэширование)
  const appJs = await fs.readFile(path.join(ROOT, 'src', 'assets', 'app.js'));
  const appName = `assets/app-${hash(appJs)}.js`;
  await write(appName, appJs);
  const index = {
    sections: visibleSections.map((s) => s.name),
    items: ready.map((s) => ({
      u: s.url,
      t: s.title,
      s: visibleSections.indexOf(s.section),
      y: s.typeCodes,
      p: s.patientCodes,
      k: s.keywords,
      e: s.title_en || '',
      ...(s.added ? { d: s.added } : {}),
    })),
  };
  const indexBuf = Buffer.from(JSON.stringify(index));
  const indexName = `assets/search-${hash(indexBuf)}.json`;
  await write(indexName, indexBuf);

  const css = await fs.readFile(path.join(ROOT, 'src', 'assets', 'style.css'), 'utf8');
  const ctx = {
    settings, css, appSrc: `/${appName}`, indexSrc: `/${indexName}`, total: ready.length, newDays: NEW_DAYS,
    hasNews: news.length > 0 || !!(settings.telegram_bot || settings.telegram_channel_url || settings.news_api_url),
    allSpecs: sections.slice().sort((a, b) => a.order - b.order || collator.compare(a.name, b.name)),
    hasPage: (sec) => pageSections.has(sec), // у раздела есть своя страница со схемами
  };

  await write('index.html', T.home(ctx, visibleSections, recent.slice(0, NEW_ON_HOME), recent.length));
  await write('news/index.html', T.newsList(ctx, news, usedSpecs, usedTopics));
  for (const n of news) await write(`news/${n.slug}/index.html`, T.newsItem(ctx, n));
  await write('new/index.html', T.newSchemes(ctx, recent));
  await write('all/index.html', T.all(ctx, ready));
  for (const sec of visibleSections) await write(`r/${sec.slug}/index.html`, T.section(ctx, sec));
  for (const s of ready) await write(`s/${s.slug}/index.html`, T.scheme(ctx, s));
  await write('404.html', T.notFound(ctx));

  // Для бота и пуш-уведомлений: список специальностей и свежие новости.
  // Бот берёт отсюда, что разослать подписчикам после публикации.
  await write('specs.json', JSON.stringify(ctx.allSpecs.map((s) => ({ slug: s.slug, name: s.name }))));
  await write('news.json', JSON.stringify(news.slice(0, 50).map((n) => ({
    slug: n.slug,
    url: n.url,
    title: n.title,
    date: n.date,
    summary: n.summary,
    telegram: n.telegram,
    specs: n.specs.map((x) => x.slug),
    spec_names: n.specs.map((x) => x.name),
    topic: n.topic.name,
    source_name: n.source_name,
  }))));
  const sw = await fs.readFile(path.join(ROOT, 'src', 'assets', 'sw.js'));
  await write('sw.js', sw);
  await fs.copyFile(path.join(ROOT, 'src', 'assets', 'favicon.svg'), path.join(OUT, 'favicon.svg'));

  if (settings.site_url) {
    const urls = ['/', ...(recent.length ? ['/new/'] : []), ...(news.length ? ['/news/', ...news.map((n) => n.url)] : []),
      '/all/', ...visibleSections.map((s) => `/r/${s.slug}/`), ...ready.map((s) => s.url)];
    await write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${settings.site_url}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
    await write('robots.txt', `User-agent: *\nDisallow: /admin/\nSitemap: ${settings.site_url}/sitemap.xml\n`);
  } else {
    await write('robots.txt', 'User-agent: *\nDisallow: /admin/\n');
  }

  if (!process.argv.includes('--no-admin')) await buildAdmin(settings);

  console.log(`Готово за ${((Date.now() - t0) / 1000).toFixed(1)} с: схем ${ready.length} (новых ${recent.length}), новостей ${news.length}, разделов ${visibleSections.length}, картинки ${(totalImg / 1048576).toFixed(1)} МБ`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
