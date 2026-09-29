// Сбор новостей DynaMed → черновики в content/news/
// Запуск (GitHub Actions, «Сбор новостей»): node tools/news/collect.mjs
//
// Что делает:
//  1. входит в DynaMed и читает ленту алертов;
//  2. пропускает уже обработанные (список в data/news-seen.json) и слишком старые;
//  3. для каждого нового алерта берёт подробности со страницы темы и отдаёт модели:
//     перевод-пересказ, специальность, тематика, пост для Telegram;
//  4. сохраняет новость черновиком (или сразу опубликованной, если NEWS_AUTO_PUBLISH=true);
//  5. записывает список созданных файлов в tools/news/.last-run.json — его читает review.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { openSession } from './dynamed.mjs';
import { prepareNews } from './ai.mjs';
import { ROOT, CONTENT, readJson, loadSections, loadTopics, env } from './lib.mjs';

const SEEN = path.join(ROOT, 'data', 'news-seen.json');
const LAST_RUN = path.join(ROOT, 'tools', 'news', '.last-run.json');
const MAX_PER_RUN = Number(env('NEWS_MAX_PER_RUN', 10));
const MAX_AGE_DAYS = Number(env('NEWS_MAX_AGE_DAYS', 3));
const AUTO_PUBLISH = env('NEWS_AUTO_PUBLISH', 'false') === 'true';
const DRY_RUN = process.argv.includes('--dry-run'); // только показать, что нового, без модели и записи

const moscowDate = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

async function main() {
  const login = env('DYNAMED_LOGIN');
  const password = env('DYNAMED_PASSWORD');
  if (!login || !password) throw new Error('не заданы секреты DYNAMED_LOGIN и DYNAMED_PASSWORD');

  const sections = await loadSections();
  const topics = await loadTopics();
  const seen = await readJson(SEEN, { ids: {} });
  const now = Date.now();

  const dm = await openSession({ login, password, debugDir: path.join(ROOT, 'debug') });
  const created = [];
  let failed = 0;
  try {
    const all = await dm.alerts();
    const fresh = all.filter((a) => !seen.ids[a.id] && now - Date.parse(a.date) < MAX_AGE_DAYS * 864e5);
    // Старые непросмотренные алерты помечаем, чтобы не возвращаться к ним
    for (const a of all) if (!seen.ids[a.id] && !fresh.includes(a)) seen.ids[a.id] = moscowDate(a.date);
    console.log(`Алертов в ленте: ${all.length}, новых: ${fresh.length}, обработаем: ${Math.min(fresh.length, MAX_PER_RUN)}`);

    for (const alert of fresh.slice(0, MAX_PER_RUN).reverse()) { // от старых к новым
      console.log(`• ${alert.type}: ${alert.text.slice(0, 100)}…`);
      if (DRY_RUN) continue;
      try {
        const info = await dm.details(alert);
        const n = await prepareNews(alert, info, sections, topics);
        const date = moscowDate(alert.date);
        const file = `${date}-dm-${alert.id}.json`;
        const doc = {
          status: AUTO_PUBLISH ? 'published' : 'draft',
          title: n.title.trim(),
          date,
          section: n.section,
          extra_sections: n.extra_sections,
          topic: n.topic,
          summary: n.summary.trim(),
          body: n.body.trim(),
          source_url: n.source_url,
          source_name: n.source_name.trim(),
          image: '',
          telegram: n.telegram.trim(),
          origin_url: info.url,
        };
        await fs.writeFile(path.join(CONTENT, 'news', file), `${JSON.stringify(doc, null, 2)}\n`);
        seen.ids[alert.id] = date;
        created.push({ file: `content/news/${file}`, ...doc });
        console.log(`  → ${doc.section} · ${doc.topic}: ${doc.title}`);
      } catch (e) {
        failed++;
        console.warn(`  ошибка: ${e.message}`); // не помечаем: попробуем в следующий раз
      }
    }
  } finally {
    await dm.close();
  }

  if (DRY_RUN) return;
  // Список обработанных храним 180 дней
  for (const [id, d] of Object.entries(seen.ids)) if (now - Date.parse(d) > 180 * 864e5) delete seen.ids[id];
  await fs.mkdir(path.dirname(SEEN), { recursive: true });
  await fs.writeFile(SEEN, `${JSON.stringify(seen, null, 1)}\n`);
  await fs.writeFile(LAST_RUN, JSON.stringify({ auto_publish: AUTO_PUBLISH, created, failed }));
  console.log(`Готово: новостей ${created.length}${failed ? `, с ошибкой ${failed}` : ''}`);
  if (failed && !created.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
