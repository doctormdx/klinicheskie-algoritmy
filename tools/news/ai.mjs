// Перевод-пересказ алерта на русский и разметка: специальность, тематика, пост для Telegram.
// Поддерживаются два вида API:
//   LLM_PROVIDER=anthropic (по умолчанию) — Claude API;
//   LLM_PROVIDER=openai — любой OpenAI-совместимый API: YandexGPT (Yandex AI Studio), OpenRouter и др.
import { env } from './lib.mjs';

const PROVIDER = env('LLM_PROVIDER', 'anthropic');
const API_KEY = env('LLM_API_KEY');
const MODEL = env('LLM_MODEL', PROVIDER === 'anthropic' ? 'claude-sonnet-5-5' : '');
const BASE_URL = env('LLM_BASE_URL', PROVIDER === 'anthropic' ? 'https://api.anthropic.com' : 'https://llm.api.cloud.yandex.net/v1');

function schema(sections, topics) {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Заголовок новости на русском, до 110 знаков, суть без кликбейта' },
      summary: { type: 'string', description: 'Анонс: 1–2 предложения, главное для врача' },
      body: { type: 'string', description: 'Текст новости в Markdown, 120–300 слов: что нового, ключевые данные (дизайн, число пациентов, результаты с цифрами, уровень доказательности), что это значит для практики. Без заголовка первого уровня' },
      telegram: { type: 'string', description: 'Пост для Telegram: 2–4 коротких абзаца простым текстом, до 700 знаков, без хэштегов, ссылок и заголовка' },
      section: { type: 'string', enum: sections, description: 'Основная специальность' },
      extra_sections: { type: 'array', items: { type: 'string', enum: sections }, maxItems: 2, description: 'Другие специальности, для которых новость важна (0–2)' },
      topic: { type: 'string', enum: topics, description: 'Тематика новости' },
      source_name: { type: 'string', description: 'Первоисточник: журнал или ведомство, как в ссылке (например, J Am Coll Cardiol, FDA, EMA, AUA)' },
      source_url: { type: 'string', description: 'Ссылка на первоисточник (DOI, сайт журнала или регулятора) из предоставленных ссылок; пустая строка, если нет' },
    },
    required: ['title', 'summary', 'body', 'telegram', 'section', 'extra_sections', 'topic', 'source_name', 'source_url'],
  };
}

function prompt(alert, info, sections, topics) {
  return `Ты — медицинский редактор русскоязычного новостного сайта для врачей. Подготовь новость по материалу ниже.

Правила:
- Пиши на русском языке, профессионально, для практикующих врачей. Точно передай факты: препараты (МНН, торговое название в скобках при первом упоминании), дозы, популяции, цифры, сроки, названия организаций.
- Это не дословный перевод, а пересказ своими словами: излагай суть и данные, не копируй формулировки источника.
- Используй принятую в России терминологию и сокращения (ИМпST, ЧКВ, ДГПЖ, СНМП, ПСА, МРТ, FDA, EMA, AUA — как принято).
- Не добавляй факты, которых нет в материале. Если данных мало — пиши короче.
- Регистрации FDA/EMA упоминай как зарубежные: в России препарат может быть не зарегистрирован.
- Специальность выбирай только из списка; если прямого соответствия нет (например, онкология), выбери ближайшую по органу или системе.
- Тематика: рекомендации профессиональных сообществ — «Клинические рекомендации»; исследования — «Исследования»; одобрения и новые показания — «Лекарства и регистрации»; предупреждения о безопасности, отзывы — «Безопасность лекарств и отзывы». Выбирай только из списка.

Специальности: ${sections.join('; ')}
Тематики: ${topics.join('; ')}

Материал (DynaMed, тип: ${alert.type}${alert.ppc ? ', отмечено как потенциально меняющее практику' : ''}, дата: ${alert.date.slice(0, 10)}):
Тема: ${alert.topics.map((t) => t.title).join('; ')}
Кратко: ${alert.text}

Подробности:
${info.text || '(нет)'}

Ссылки на первоисточник: ${info.links.join(' ') || '(нет)'}`;
}

async function callAnthropic(text, sch) {
  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      tools: [{ name: 'save_news', description: 'Сохранить подготовленную новость', input_schema: sch }],
      tool_choice: { type: 'tool', name: 'save_news' },
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const block = j.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('Claude API: нет ответа в нужном формате');
  return block.input;
}

let jsonMode = true; // не все OpenAI-совместимые API понимают response_format — тогда без него
async function callOpenAI(text, sch) {
  const auth = BASE_URL.includes('api.cloud.yandex.net') ? `Api-Key ${API_KEY}` : `Bearer ${API_KEY}`;
  const send = () => fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 3000,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: `Отвечай только JSON-объектом по этой схеме: ${JSON.stringify(sch)}` },
        { role: 'user', content: text },
      ],
    }),
  });
  let res = await send();
  if (res.status === 400 && jsonMode) {
    jsonMode = false;
    res = await send();
  }
  if (!res.ok) throw new Error(`LLM API: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const raw = j.choices?.[0]?.message?.content || '';
  return JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
}

// Проверка ответа: всё из списков, обязательные поля есть
function validate(out, sections, topics) {
  const problems = [];
  for (const k of ['title', 'summary', 'body', 'telegram']) if (!String(out[k] || '').trim()) problems.push(`пустое поле ${k}`);
  if (!sections.includes(out.section)) problems.push(`неизвестная специальность «${out.section}»`);
  if (!topics.includes(out.topic)) problems.push(`неизвестная тематика «${out.topic}»`);
  out.extra_sections = (out.extra_sections || []).filter((s) => sections.includes(s) && s !== out.section).slice(0, 2);
  out.source_url = /^https?:\/\//.test(out.source_url || '') ? out.source_url.replace(/^http:\/\/(dx\.)?doi\.org/, 'https://doi.org') : '';
  return problems;
}

export async function prepareNews(alert, info, sections, topics) {
  if (!API_KEY) throw new Error('не задан секрет LLM_API_KEY');
  if (!MODEL) throw new Error('не задана переменная LLM_MODEL');
  const sch = schema(sections, topics);
  let text = prompt(alert, info, sections, topics);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = PROVIDER === 'anthropic' ? await callAnthropic(text, sch) : await callOpenAI(text, sch);
    const problems = validate(out, sections, topics);
    if (!problems.length) return out;
    if (attempt === 2) throw new Error(`ответ модели не прошёл проверку: ${problems.join('; ')}`);
    text += `\n\nПредыдущий ответ отклонён: ${problems.join('; ')}. Исправь.`;
  }
}
