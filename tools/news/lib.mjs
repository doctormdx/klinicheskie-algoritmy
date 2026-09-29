// Общие функции для сбора новостей
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const CONTENT = path.join(ROOT, 'content');

// Та же транслитерация, что в src/build.mjs: из неё получаются адреса страниц
const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
export const slugify = (s) =>
  [...s.toLowerCase()].map((c) => TR[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const readJson = async (p, fallback) => {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && e.code === 'ENOENT') return fallback;
    throw e;
  }
};

export const sha = (s, n = 12) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);

async function names(dir) {
  const out = [];
  for (const f of (await fs.readdir(path.join(CONTENT, dir))).filter((x) => x.endsWith('.json'))) {
    const j = await readJson(path.join(CONTENT, dir, f));
    if (j.name) out.push({ name: j.name.trim(), order: Number(j.order) || 999 });
  }
  return out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru')).map((x) => x.name);
}

// Специальности (= разделы сайта) и тематики новостей — те, что заведены в админке
export const loadSections = () => names('sections');
export const loadTopics = () => names('topics');
export const loadSettings = () => readJson(path.join(CONTENT, 'settings.json'));

export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

export const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};
