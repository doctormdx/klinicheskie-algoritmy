// DynaMed: вход под учётной записью и чтение ленты алертов.
// Лента берётся из того же API, что и страница https://www.dynamed.com/alerts,
// подробности — со страницы темы, куда ведёт ссылка «View in …».
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { sha } from './lib.mjs';

const BASE = 'https://www.dynamed.com';
const ALERTS_API = `${BASE}/api/home/v1/alerts?limit=50&ppcDataset=true&nejmDataset=true`;

const TYPE_RU = {
  'Evidence': 'Исследование',
  'Guideline Summary': 'Клиническая рекомендация',
  'Drug/Device Alert': 'Лекарство или медицинское изделие',
};

export async function openSession({ login, password, debugDir }) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const debug = async (name) => {
    if (!debugDir) return;
    await fs.mkdir(debugDir, { recursive: true });
    await page.screenshot({ path: path.join(debugDir, `${name}.png`), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(debugDir, `${name}.txt`), `${page.url()}\n\n${await page.innerText('body').catch(() => '')}`).catch(() => {});
  };
  const loggedIn = async () => (await context.request.get(ALERTS_API)).ok();

  try {
    await page.goto(`${BASE}/auth0-login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Форма входа EBSCO: иногда логин и пароль на одном экране, иногда пароль на следующем
    const user = page.locator('input[type=email], input[name=username], input[name=email], input#username, input[autocomplete=username]').first();
    await user.waitFor({ state: 'visible', timeout: 45000 });
    await user.fill(login);
    const pass = page.locator('input[type=password]').first();
    if (!(await pass.isVisible().catch(() => false))) {
      await page.locator('button[type=submit], input[type=submit], button:has-text("Continue"), button:has-text("Next")').first().click();
      await pass.waitFor({ state: 'visible', timeout: 30000 });
    }
    await pass.fill(password);
    await Promise.all([
      page.waitForURL((u) => u.hostname.endsWith('dynamed.com') && !u.pathname.startsWith('/auth0'), { timeout: 90000 }),
      page.locator('button[type=submit], input[type=submit], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")').first().click(),
    ]);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    if (!(await loggedIn())) throw new Error('после входа лента алертов недоступна');
  } catch (e) {
    await debug('login-failed');
    await browser.close();
    throw new Error(`Не удалось войти в DynaMed: ${e.message}. Снимок экрана — в артефактах запуска на GitHub.`);
  }

  // Список алертов: всё новое + «потенциально меняющие практику» + NEJM, без повторов.
  // Один и тот же алерт DynaMed показывает в нескольких темах — склеиваем по тексту.
  async function alerts() {
    const res = await context.request.get(ALERTS_API);
    if (!res.ok()) throw new Error(`лента алертов: HTTP ${res.status()}`);
    const j = await res.json();
    const lists = ['unfiltered', 'ppc', 'nejm'].flatMap((k) => j.all?.[k] || []);
    const byText = new Map();
    for (const a of lists) {
      const text = String(a.text || '').trim();
      if (!text) continue;
      const id = sha(text);
      const cur = byText.get(id);
      if (cur) {
        for (const t of a.topics || []) if (!cur.topics.some((x) => x.linkId === t.linkId)) cur.topics.push(t);
        cur.ppc ||= a.priority === 'ppc';
        cur.nejm ||= !!a.nejmAdvantage;
        continue;
      }
      byText.set(id, {
        id,
        text,
        type: a.type,
        type_ru: TYPE_RU[a.type] || a.type,
        ppc: a.priority === 'ppc',
        nejm: !!a.nejmAdvantage,
        date: new Date(Number(a.timestamp)).toISOString(),
        topics: [...(a.topics || [])],
      });
    }
    return [...byText.values()].sort((a, b) => b.date.localeCompare(a.date));
  }

  // Подробности алерта: блок на странице темы (дизайн исследования, цифры, ссылка на статью)
  async function details(alert) {
    const t = alert.topics[0];
    if (!t?.slug) return { url: '', text: '', links: [] };
    const url = `${BASE}${t.slug}#${t.linkId}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const el = page.locator(`[id="${t.linkId}"]`).first();
      await el.waitFor({ state: 'attached', timeout: 45000 });
      const data = await el.evaluate((node) => ({
        text: node.innerText,
        links: [...node.querySelectorAll('a[href]')].map((a) => a.href)
          .filter((h) => /^https?:/.test(h) && !/dynamed\.com/.test(h)),
      }));
      return { url, text: data.text.slice(0, 9000), links: [...new Set(data.links)].slice(0, 5) };
    } catch (e) {
      console.warn(`  подробности не получены (${alert.text.slice(0, 60)}…): ${e.message.split('\n')[0]}`);
      return { url, text: '', links: [] };
    }
  }

  return { alerts, details, close: () => browser.close() };
}
