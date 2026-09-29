// Функция news-bot (Яндекс Облако, Cloud Functions, Node.js 22)
//
// Одна функция делает всё, для чего сайту нужен сервер:
//   ?a=tg          — вебхук Telegram-бота: подписка врачей на специальности, кнопки модерации;
//   ?a=review      — (из GitHub Actions) прислать администратору черновики с кнопками;
//   ?a=notify      — (из GitHub Actions после выкладки) разослать опубликованные новости:
//                    пост в канал, сообщения подписчикам бота, пуш-уведомления в браузер;
//   ?a=vapid, push-sub, push-get, push-unsub — подписка на пуш-уведомления с сайта;
//   ?a=setup       — (из GitHub Actions) подключить вебхук и меню бота.
//
// Данные (подписки, ключи, что уже разослано) лежат в закрытом бакете Object Storage.
'use strict';

const crypto = require('node:crypto');
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const webpush = require('web-push');

const E = process.env;
const SITE = String(E.SITE_URL || '').replace(/\/+$/, '');
const API_SECRET = E.API_SECRET || '';
const HOOK_SECRET = crypto.createHash('sha256').update(`tg:${API_SECRET}`).digest('hex').slice(0, 48);
const REPO = E.GITHUB_REPO || '';
const FRESH_DAYS = 3; // новости старше этого не рассылаем

// ---------- Хранилище ----------
const s3 = new S3Client({
  region: 'ru-central1',
  endpoint: 'https://storage.yandexcloud.net',
  credentials: { accessKeyId: E.S3_KEY_ID || '', secretAccessKey: E.S3_SECRET || '' },
});
const Bucket = E.DATA_BUCKET;

async function getJson(Key, fallback = null) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket, Key }));
    return JSON.parse(await r.Body.transformToString());
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return fallback;
    throw e;
  }
}
const putJson = (Key, obj) => s3.send(new PutObjectCommand({ Bucket, Key, Body: JSON.stringify(obj), ContentType: 'application/json' }));
const del = (Key) => s3.send(new DeleteObjectCommand({ Bucket, Key })).catch(() => {});
async function listKeys(Prefix) {
  const keys = [];
  let ContinuationToken;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
    for (const o of r.Contents || []) keys.push(o.Key);
    ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}
async function loadAll(prefix) {
  const keys = await listKeys(prefix);
  const out = [];
  for (let i = 0; i < keys.length; i += 25) {
    const part = await Promise.all(keys.slice(i, i + 25).map(async (k) => ({ key: k, ...(await getJson(k, {})) })));
    out.push(...part);
  }
  return out;
}

// ---------- Сайт ----------
let specsCache = { at: 0, list: [] };
async function specs() {
  if (Date.now() - specsCache.at < 10 * 60e3 && specsCache.list.length) return specsCache.list;
  const r = await fetch(`${SITE}/specs.json?t=${Date.now()}`);
  if (!r.ok) throw new Error(`specs.json: HTTP ${r.status}`);
  specsCache = { at: Date.now(), list: await r.json() };
  return specsCache.list;
}

// ---------- Telegram ----------
async function tg(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${E.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) {
    const err = new Error(`Telegram ${method}: ${j.description || r.status}`);
    err.code = j.error_code;
    throw err;
  }
  return j.result;
}
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const hashtag = (s) => `#${String(s).replace(/[^0-9A-Za-zА-Яа-яЁё]+/g, '_').replace(/^_+|_+$/g, '')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

function newsPost(n) {
  const tags = [...(n.spec_names || []), n.topic].filter(Boolean).map(hashtag).join(' ');
  return `<b>${esc(n.title)}</b>\n\n${esc(n.telegram || n.summary)}\n\n${tags}\n<a href="${SITE}${n.url}">Подробнее на сайте</a>`;
}

// Клавиатура выбора специальностей
function specsKeyboard(list, selected) {
  const rows = list.map((s, i) => [{ text: `${selected.includes(s.slug) ? '✅' : '▫️'} ${s.name}`, callback_data: `t:${i}` }]);
  rows.push([{ text: 'Отметить все', callback_data: 'all' }, { text: 'Снять все', callback_data: 'none' }]);
  rows.push([{ text: 'Готово', callback_data: 'done' }]);
  return { inline_keyboard: rows };
}
const subKey = (chatId) => `subs/tg/${chatId}.json`;

async function showSettings(chatId, intro) {
  const list = await specs();
  const sub = await getJson(subKey(chatId), { specs: [] });
  await tg('sendMessage', {
    chat_id: chatId,
    text: `${intro ? `${intro}\n\n` : ''}Отметьте специальности — пришлю новости по ним, как только они выйдут на сайте.`,
    reply_markup: specsKeyboard(list, sub.specs || []),
  });
}

function summaryText(list, selected) {
  const names = list.filter((s) => selected.includes(s.slug)).map((s) => s.name);
  return names.length
    ? `Подписка оформлена: ${names.join(', ')}.\n\nИзменить — /settings, отписаться от всего — /stop.`
    : 'Вы не подписаны ни на одну специальность. Выбрать — /settings.';
}

async function isAdmin(chatId) {
  const a = await getJson('state/admin.json', {});
  return a.chat_id && String(a.chat_id) === String(chatId);
}

async function onMessage(msg) {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'private') return;
  const text = String(msg.text || '').trim();
  if (text.startsWith('/admin')) {
    if (text.split(/\s+/)[1] === API_SECRET) {
      await putJson('state/admin.json', { chat_id: chatId });
      return tg('sendMessage', { chat_id: chatId, text: 'Готово: сюда будут приходить черновики новостей на проверку.' });
    }
    return tg('sendMessage', { chat_id: chatId, text: 'Неверный код.' });
  }
  if (text.startsWith('/stop')) {
    await del(subKey(chatId));
    return tg('sendMessage', { chat_id: chatId, text: 'Вы отписались от всех новостей. Вернуться — /start.' });
  }
  if (text.startsWith('/start')) {
    return showSettings(chatId, 'Здравствуйте! Это бот новостей для врачей с сайта клинических алгоритмов.');
  }
  if (text.startsWith('/settings')) return showSettings(chatId);
  return tg('sendMessage', {
    chat_id: chatId,
    text: `Команды:\n/settings — выбрать специальности\n/stop — отписаться\n\nВсе новости: ${SITE}/news/`,
  });
}

async function onCallback(cb) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const data = cb.data || '';
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});

  // Модерация: только из чата администратора
  if (/^[pr]:/.test(data)) {
    if (!(await isAdmin(chatId))) return answer('Нет доступа');
    const file = `content/news/${data.slice(2)}.json`;
    try {
      const result = data[0] === 'p' ? await publishDraft(file) : await rejectDraft(file);
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await tg('sendMessage', { chat_id: chatId, reply_to_message_id: msgId, text: result });
      return answer();
    } catch (e) {
      return answer(`Ошибка: ${e.message}`.slice(0, 190));
    }
  }

  // Подписка на специальности
  const list = await specs();
  const key = subKey(chatId);
  const sub = await getJson(key, { specs: [] });
  let selected = (sub.specs || []).filter((s) => list.some((x) => x.slug === s));
  if (data === 'done') {
    await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: summaryText(list, selected) });
    return answer();
  }
  if (data === 'all') selected = list.map((s) => s.slug);
  else if (data === 'none') selected = [];
  else if (data.startsWith('t:')) {
    const s = list[Number(data.slice(2))];
    if (s) selected = selected.includes(s.slug) ? selected.filter((x) => x !== s.slug) : [...selected, s.slug];
  }
  if (selected.length) {
    await putJson(key, { specs: selected, name: cb.from?.first_name || '', updated: new Date().toISOString(), created: sub.created || new Date().toISOString() });
  } else {
    await del(key);
  }
  await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: specsKeyboard(list, selected) }).catch(() => {});
  return answer();
}

// ---------- GitHub: публикация и отклонение черновиков ----------
async function gh(method, path, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${E.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'news-bot',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}

async function publishDraft(file) {
  const f = await gh('GET', `contents/${file}?ref=main`);
  if (!f) return 'Черновик уже удалён.';
  const doc = JSON.parse(Buffer.from(f.content, 'base64').toString('utf8'));
  if (doc.status !== 'draft') return 'Эта новость уже опубликована.';
  doc.status = 'published';
  doc.date = today();
  await gh('PUT', `contents/${file}`, {
    message: `Опубликовано из Telegram: ${doc.title}`.slice(0, 200),
    content: Buffer.from(`${JSON.stringify(doc, null, 2)}\n`).toString('base64'),
    sha: f.sha,
    branch: 'main',
  });
  return '✅ Опубликовано. Через 1–2 минуты новость будет на сайте и уйдёт в канал и подписчикам.';
}

async function rejectDraft(file) {
  const f = await gh('GET', `contents/${file}?ref=main`);
  if (!f) return 'Черновик уже удалён.';
  const doc = JSON.parse(Buffer.from(f.content, 'base64').toString('utf8'));
  if (doc.status !== 'draft') return 'Новость уже опубликована — удалить её можно в админке сайта.';
  await gh('DELETE', `contents/${file}`, { message: `Отклонено в Telegram: ${doc.title}`.slice(0, 200), sha: f.sha, branch: 'main' });
  return '❌ Отклонено, черновик удалён.';
}

// ---------- Черновики на проверку ----------
async function review(items) {
  const admin = await getJson('state/admin.json', {});
  if (!admin.chat_id) throw Object.assign(new Error('Администратор не назначен: напишите боту /admin <код NEWS_API_SECRET>'), { status: 409 });
  let sent = 0;
  for (const it of items || []) {
    const name = String(it.file || '').replace(/^content\/news\//, '').replace(/\.json$/, '');
    if (!/^[\w-]{1,60}$/.test(name)) continue;
    const specsLine = [it.section, ...(it.extra_sections || [])].join(', ');
    const text = `📝 <b>Черновик на проверку</b>\n\n<b>${esc(it.title)}</b>\n<i>${esc(specsLine)} · ${esc(it.topic)}</i>\n\n${esc(it.telegram || it.summary)}\n\n`
      + `Источник: ${it.source_url ? `<a href="${esc(it.source_url)}">${esc(it.source_name || 'ссылка')}</a>` : esc(it.source_name || '—')}`
      + `${it.origin_url ? ` · <a href="${esc(it.origin_url)}">оригинал</a>` : ''}`;
    await tg('sendMessage', {
      chat_id: admin.chat_id,
      text: text.slice(0, 4000),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Опубликовать', callback_data: `p:${name}` }, { text: '❌ Отклонить', callback_data: `r:${name}` }],
          [{ text: '✏️ Исправить в админке', url: `${SITE}/admin/#/collections/news/entries/${name}` }],
        ],
      },
    });
    sent++;
    await sleep(100);
  }
  return { sent };
}

// ---------- Рассылка ----------
async function vapid() {
  let v = await getJson('state/vapid.json');
  if (!v) {
    v = webpush.generateVAPIDKeys();
    await putJson('state/vapid.json', v);
  }
  return v;
}

async function notify() {
  const r = await fetch(`${SITE}/news.json?t=${Date.now()}`);
  if (!r.ok) throw new Error(`news.json: HTTP ${r.status}`);
  const news = await r.json();
  const state = await getJson('state/notified.json');
  if (!state) {
    // Первый запуск: всё, что уже на сайте, считаем разосланным
    await putJson('state/notified.json', { slugs: news.map((n) => n.slug) });
    return { initialized: true, skipped: news.length };
  }
  const minDate = new Date(Date.now() - FRESH_DAYS * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  const todo = news.filter((n) => !state.slugs.includes(n.slug)).reverse(); // от старых к новым
  if (!todo.length) return { sent: 0 };

  const tgSubs = await loadAll('subs/tg/');
  const webSubs = await loadAll('subs/web/');
  const keys = await vapid();
  webpush.setVapidDetails(SITE || 'https://example.com', keys.publicKey, keys.privateKey);
  const stats = { news: 0, channel: 0, bot: 0, push: 0, removed: 0 };
  const deadline = Date.now() + 250e3;

  for (const n of todo) {
    if (Date.now() > deadline) break; // остальное — при следующей выкладке
    state.slugs.push(n.slug);
    if (n.date < minDate) continue;
    const text = newsPost(n);
    const match = (s) => (s.specs || []).some((x) => n.specs.includes(x));

    if (E.CHANNEL_ID) {
      try {
        await tg('sendMessage', { chat_id: E.CHANNEL_ID, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        stats.channel++;
      } catch (e) {
        console.error(e.message);
      }
    }
    for (const s of tgSubs.filter(match)) {
      const chatId = s.key.replace(/^subs\/tg\/|\.json$/g, '');
      try {
        await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        stats.bot++;
      } catch (e) {
        if (e.code === 403 || e.code === 400) { await del(s.key); stats.removed++; } // бот заблокирован или чат удалён
        else if (e.code === 429) await sleep(3000);
      }
      await sleep(40); // лимит Telegram — не больше ~30 сообщений в секунду
    }
    const payload = JSON.stringify({ title: n.title, body: n.summary, url: n.url, tag: n.slug });
    await Promise.all(webSubs.filter(match).map(async (s) => {
      try {
        await webpush.sendNotification(s.sub, payload, { TTL: 3 * 86400 });
        stats.push++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { await del(s.key); stats.removed++; }
      }
    }));
    stats.news++;
    state.slugs = state.slugs.slice(-500);
    await putJson('state/notified.json', state);
  }
  await putJson('state/notified.json', state);
  return stats;
}

// ---------- Пуш-подписки с сайта ----------
const webKey = (endpoint) => `subs/web/${crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 40)}.json`;

async function pushSub({ sub, specs: chosen }) {
  if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys?.p256dh || !sub.keys?.auth) throw Object.assign(new Error('bad subscription'), { status: 400 });
  const list = await specs();
  const valid = (Array.isArray(chosen) ? chosen : []).filter((s) => list.some((x) => x.slug === s));
  if (!valid.length) throw Object.assign(new Error('no specialties'), { status: 400 });
  await putJson(webKey(sub.endpoint), { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, specs: valid, updated: new Date().toISOString() });
  return { ok: true, specs: valid };
}

// ---------- Точка входа ----------
function reply(status, obj) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': SITE || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(obj),
  };
}

module.exports.handler = async function handler(event) {
  const method = event.httpMethod || 'POST';
  if (method === 'OPTIONS') return reply(204, {});
  const q = event.queryStringParameters || {};
  const a = q.a || '';
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  let body = {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return reply(400, { error: 'bad json' });
  }
  const needSecret = () => {
    if (!API_SECRET || body.secret !== API_SECRET) throw Object.assign(new Error('forbidden'), { status: 403 });
  };

  try {
    switch (a) {
      case 'tg': {
        if (headers['x-telegram-bot-api-secret-token'] !== HOOK_SECRET) return reply(403, { error: 'forbidden' });
        try {
          if (body.message) await onMessage(body.message);
          else if (body.callback_query) await onCallback(body.callback_query);
        } catch (e) {
          console.error('tg:', e.message); // Telegram не должен повторять запрос из-за нашей ошибки
        }
        return reply(200, { ok: true });
      }
      case 'vapid':
        return reply(200, { key: (await vapid()).publicKey });
      case 'push-sub':
        return reply(200, await pushSub(body));
      case 'push-get':
        return reply(200, { specs: (await getJson(webKey(body.endpoint), {})).specs || [] });
      case 'push-unsub':
        await del(webKey(body.endpoint));
        return reply(200, { ok: true });
      case 'review':
        needSecret();
        return reply(200, await review(body.items));
      case 'notify':
        needSecret();
        return reply(200, await notify());
      case 'setup': {
        needSecret();
        const url = `${body.url}${String(body.url).includes('?') ? '&' : '?'}a=tg`;
        await tg('setWebhook', { url, secret_token: HOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
        await tg('setMyCommands', {
          commands: [
            { command: 'settings', description: 'Выбрать специальности' },
            { command: 'stop', description: 'Отписаться от всех новостей' },
          ],
        });
        await tg('setMyDescription', { description: 'Новости медицины по вашим специальностям: клинические рекомендации, исследования, регистрации лекарств. Нажмите «Старт» и выберите специальности.' }).catch(() => {});
        return reply(200, { ok: true, webhook: url });
      }
      default:
        return reply(404, { error: 'unknown action' });
    }
  } catch (e) {
    if (!e.status) console.error(a, e);
    return reply(e.status || 500, { error: e.message });
  }
};
