// Сборка сайта: content/ -> dist/
// Запуск: npm run build
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import * as T from './templates.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const OUT = path.join(ROOT, 'dist');

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

async function processImage(scheme) {
  const rel = (scheme.image || '').replace(/^\/?images\//, '');
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
  const name = `img/${scheme.slug}-${hash(buf)}.webp`;
  await write(name, buf);
  return { src: `/${name}`, width: meta.width, height: meta.height, bytes: buf.length };
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
        s.img = await processImage(s);
        totalImg += s.img.bytes;
      } catch (e) {
        console.warn(`  нет картинки для ${s.slug}: ${e.message}`);
      }
    }));
  }
  const ready = schemes.filter((s) => s.img);

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
    })),
  };
  const indexBuf = Buffer.from(JSON.stringify(index));
  const indexName = `assets/search-${hash(indexBuf)}.json`;
  await write(indexName, indexBuf);

  const css = await fs.readFile(path.join(ROOT, 'src', 'assets', 'style.css'), 'utf8');
  const ctx = { settings, css, appSrc: `/${appName}`, indexSrc: `/${indexName}`, total: ready.length };

  for (const sec of visibleSections) sec.schemes = sec.schemes.filter((s) => s.img);

  await write('index.html', T.home(ctx, visibleSections));
  await write('all/index.html', T.all(ctx, ready));
  for (const sec of visibleSections) await write(`r/${sec.slug}/index.html`, T.section(ctx, sec));
  for (const s of ready) await write(`s/${s.slug}/index.html`, T.scheme(ctx, s));
  await write('404.html', T.notFound(ctx));
  await fs.copyFile(path.join(ROOT, 'src', 'assets', 'favicon.svg'), path.join(OUT, 'favicon.svg'));

  if (settings.site_url) {
    const urls = ['/', '/all/', ...visibleSections.map((s) => `/r/${s.slug}/`), ...ready.map((s) => s.url)];
    await write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${settings.site_url}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
    await write('robots.txt', `User-agent: *\nDisallow: /admin/\nSitemap: ${settings.site_url}/sitemap.xml\n`);
  } else {
    await write('robots.txt', 'User-agent: *\nDisallow: /admin/\n');
  }

  if (!process.argv.includes('--no-admin')) await buildAdmin(settings);

  console.log(`Готово за ${((Date.now() - t0) / 1000).toFixed(1)} с: схем ${ready.length}, разделов ${visibleSections.length}, картинки ${(totalImg / 1048576).toFixed(1)} МБ`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
