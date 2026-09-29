// Вызов функции news-bot в Яндекс Облаке из GitHub Actions.
//   node tools/news/call.mjs review  — отправить свежие черновики на проверку в Telegram
//   node tools/news/call.mjs notify  — разослать опубликованные новости (после выкладки сайта)
import path from 'node:path';
import { ROOT, readJson, loadSettings, env } from './lib.mjs';

async function main() {
  const action = process.argv[2];
  const settings = await loadSettings();
  const api = env('NEWS_API_URL', settings.news_api_url);
  const secret = env('NEWS_API_SECRET');
  if (!api || !secret) {
    console.log('Функция уведомлений не настроена (нет адреса в настройках сайта или секрета NEWS_API_SECRET) — пропускаю.');
    return;
  }
  let payload = {};
  if (action === 'review') {
    const last = await readJson(path.join(ROOT, 'tools', 'news', '.last-run.json'), { created: [] });
    if (!last.created.length) return console.log('Новых черновиков нет.');
    if (last.auto_publish) return console.log('Автопубликация: проверка не нужна.');
    payload = { items: last.created };
  } else if (action !== 'notify') {
    throw new Error('ожидается review или notify');
  }
  const res = await fetch(`${api}${api.includes('?') ? '&' : '?'}a=${action}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ secret, ...payload }),
    signal: AbortSignal.timeout(280000),
  });
  const text = await res.text();
  console.log(`${action}: HTTP ${res.status} ${text.slice(0, 500)}`);
  if (!res.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
