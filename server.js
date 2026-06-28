/**
 * ПОКЕРОК HQ — ИИ-чат с командой
 * Express + Anthropic API. Ключ только на сервере (env), клиенту не отдаётся.
 * Плоская структура: index.html лежит рядом с server.js (удобно для деплоя).
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { AGENTS } = require('./agents');
const store = require('./tasks');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.MODEL || 'claude-haiku-4-5-20251001';
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';

app.use(express.json({ limit: '12mb' }));

// папка загрузок (на постоянном диске, если есть volume)
const UPLOADS = path.join(store.DIR, 'uploads');
try { if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true }); } catch (e) {}
app.use('/uploads', express.static(UPLOADS));

// index.html ищем рядом (плоско) или в public/ (если структура с папкой)
const INDEX = fs.existsSync(path.join(__dirname, 'index.html'))
  ? path.join(__dirname, 'index.html')
  : path.join(__dirname, 'public', 'index.html');

function checkAccess(req, res, next) {
  if (!ACCESS_PASSWORD && !WORKER_TOKEN) return next();
  const pass = req.headers['x-access-password'] || req.headers['x-worker-token'] || (req.body && req.body.password);
  if (pass === ACCESS_PASSWORD || (WORKER_TOKEN && pass === WORKER_TOKEN)) return next();
  return res.status(401).json({ error: 'Неверный пароль доступа' });
}

async function callClaude(system, messages, maxTokens = 600) {
  if (!API_KEY) {
    return '⚠️ ИИ не подключён: на сервере не задан ANTHROPIC_API_KEY. Это демо-ответ. Добавь ключ в переменные окружения — и я заговорю по-настоящему.';
  }
  const body = { model: MODEL, max_tokens: maxTokens, system, messages };
  // веб-поиск: даём агентам доступ в интернет (можно выключить WEB_SEARCH=off)
  if (process.env.WEB_SEARCH !== 'off') {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) {
    console.error('Anthropic error', data);
    return '⚠️ Ошибка ИИ: ' + (data.error && data.error.message ? data.error.message : 'неизвестно');
  }
  // ответ может содержать блоки веб-поиска — собираем все текстовые блоки
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return text || '(пустой ответ)';
}

app.get('/api/agents', (req, res) => {
  res.json({
    agents: Object.entries(AGENTS).filter(([id]) => id !== 'lead').map(([id, a]) => ({ id, emoji: a.emoji, name: a.name })),
    aiEnabled: !!API_KEY,
    passwordRequired: !!ACCESS_PASSWORD
  });
});

app.post('/api/chat', checkAccess, async (req, res) => {
  const { agentId, message, history } = req.body || {};
  const agent = AGENTS[agentId];
  if (!agent) return res.status(400).json({ error: 'Неизвестный сотрудник' });
  if (!message) return res.status(400).json({ error: 'Пустое сообщение' });
  const mine = store.load().tasks.filter(t => t.assignee === agentId && t.status !== 'done');
  const taskCtx = mine.length ? ` Твои текущие задачи на доске (помни их, при необходимости выдавай по ним готовый результат): ${mine.map(t => `«${t.title}» (${t.priority}${t.deadline ? ', до ' + t.deadline : ''})`).join('; ')}.` : '';
  const msgs = [];
  (history || []).slice(-12).forEach(h => msgs.push({ role: h.role, content: h.content }));
  msgs.push({ role: 'user', content: message });
  const reply = await callClaude(agent.system + taskCtx, msgs, 900);
  res.json({ reply, agent: { emoji: agent.emoji, name: agent.name } });
});

app.post('/api/roundtable', checkAccess, async (req, res) => {
  const { topic } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'Укажи тему летучки' });
  const order = ['analytics', 'smm', 'marketing', 'media', 'stream', 'strategy'];
  const turns = [];
  let discussion = '';
  for (const id of order) {
    const a = AGENTS[id];
    const sys = a.system + ' Это командная летучка. Будь конкретным и не бойся спорить с коллегами: если их доводы слабые — оспорь их по делу.';
    const userMsg = discussion
      ? `Тема летучки: «${topic}».\n\nЧто уже сказали коллеги:\n${discussion}\n\nДай свою позицию (2–4 предложения): согласись или поспорь по делу, добавь своё.`
      : `Тема летучки: «${topic}». Ты высказываешься первым. Дай свою позицию по делу (2–4 предложения).`;
    const text = await callClaude(sys, [{ role: 'user', content: userMsg }], 350);
    turns.push({ id, emoji: a.emoji, name: a.name, text });
    discussion += `\n${a.name}: ${text}\n`;
  }
  const lead = AGENTS.lead;
  const synthesis = await callClaude(
    lead.system,
    [{ role: 'user', content: `Тема: «${topic}». Дискуссия команды:\n${discussion}\n\nСведи в итог: согласованное решение и 3 шага с приоритетами P0/P1/P2.` }],
    500
  );
  turns.push({ id: 'lead', emoji: lead.emoji, name: lead.name, text: synthesis, isLead: true });
  res.json({ turns });
});

// ===== задачи, общий чат, помощник =====
const WORKERS = ['analytics', 'smm', 'marketing', 'media', 'stream', 'strategy', 'designer', 'developer', 'gambling', 'clipper'];
function rosterLine() { return WORKERS.map(id => `${id}: ${AGENTS[id].name}`).join(' | '); }
function dateIn(days) { const d = new Date(); d.setDate(d.getDate() + (parseInt(days) || 3)); return d.toISOString().slice(0, 10); }

app.get('/api/tasks', (req, res) => { const d = store.load(); res.json({ tasks: d.tasks, feed: d.feed.slice(0, 30), summary: store.summary() }); });
app.post('/api/tasks/move', checkAccess, (req, res) => { const t = store.moveTask(parseInt(req.body.id), req.body.status); res.json({ ok: !!t, task: t }); });
app.post('/api/tasks/delete', checkAccess, (req, res) => { store.deleteTask(parseInt(req.body.id)); res.json({ ok: true }); });

app.post('/api/team-chat', checkAccess, async (req, res) => {
  const message = ((req.body && req.body.message) || '').trim();
  if (!message) return res.status(400).json({ error: 'Пустое сообщение' });
  const sys = AGENTS.assistant.system + ` Сегодня ${new Date().toISOString().slice(0, 10)}. Состав команды (id: имя): ${rosterLine()}.`;
  const prompt = `Шеф написал в общий чат команды:\n«${message}»\n\nВы — команда ИСПОЛНИТЕЛЕЙ, работаете мгновенно, БЕЗ сроков в днях. Сделай так:\n1) Коротко: кто что берёт.\n2) КАЖДЫЙ, кто взял задачу, ПРЯМО ЗДЕСЬ выдаёт первый ГОТОВЫЙ результат (черновик текста/контент-плана/списка хештегов/идей/кода/промптов — то, что просили), а не обещание и не сроки. Реальный кусок работы, как будто уже сделано.\n3) В конце верни СТРОГО блок \`\`\`json {"tasks":[{"title":"...","assignee_id":"<id из состава>","priority":"P0|P1|P2","deadline_days":<0 если сегодня, 1 если завтра>}]}\`\`\`. Если это просто вопрос без задач — "tasks":[] и ответь по делу.`;
  const text = await callClaude(sys, [{ role: 'user', content: prompt }], 1100);
  let created = [];
  const m = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
  if (m) { try { const obj = JSON.parse(m[1] || m[0]); (obj.tasks || []).forEach(t => { const a = AGENTS[t.assignee_id]; created.push(store.addTask({ title: t.title, assignee: t.assignee_id, assigneeName: a ? a.name : null, assigneeEmoji: a ? a.emoji : '', priority: t.priority || 'P1', deadline: dateIn(t.deadline_days), status: 'progress' })); }); } catch (e) { } }
  const discussion = text.replace(/```json[\s\S]*?```/i, '').trim();
  store.addFeed({ kind: 'task', who: '🤖 Помощник', txt: created.length ? `Разобрали: «${message}» → ${created.length} задач(и).` : `Обсудили: «${message}»` });
  res.json({ reply: discussion, tasks: created, summary: store.summary() });
});

app.post('/api/assistant', checkAccess, async (req, res) => {
  const q = ((req.body && req.body.question) || '').trim();
  const d = store.load();
  const board = d.tasks.map(t => `#${t.id} [${t.status}] ${t.priority} "${t.title}" — ${t.assigneeName || 'без исполнителя'}${t.deadline ? (' до ' + t.deadline) : ''}`).join('\n') || '(задач нет)';
  const sys = AGENTS.assistant.system + ` Сегодня ${new Date().toISOString().slice(0, 10)}.`;
  const prompt = (q ? `Вопрос шефа: «${q}».\n\n` : 'Дай шефу короткий брифинг по доске.\n\n') + `Доска задач:\n${board}\n\nОтветь сжато (буллеты): что горит (P0/дедлайны), что без исполнителя, 1–2 предложения.`;
  const reply = await callClaude(sys, [{ role: 'user', content: prompt }], 450);
  res.json({ reply });
});
app.get('/api/digest', async (req, res) => {
  const d = store.load();
  if (!API_KEY) return res.json({ reply: 'Добавь ANTHROPIC_API_KEY — и я начну давать брифинги. Сейчас на доске: ' + store.summary().total + ' задач.' });
  const board = d.tasks.slice(0, 20).map(t => `[${t.status}] ${t.priority} "${t.title}" — ${t.assigneeName || 'без исполнителя'}${t.deadline ? (' до ' + t.deadline) : ''}`).join('\n') || '(задач пока нет)';
  const sys = AGENTS.assistant.system + ` Сегодня ${new Date().toISOString().slice(0, 10)}.`;
  const reply = await callClaude(sys, [{ role: 'user', content: `Доска:\n${board}\n\nБрифинг на 4-6 буллетов: что важно сейчас, что горит, что без исполнителя, 1 предложение. Коротко.` }], 400);
  res.json({ reply });
});

// ===== студии: заявки дизайнеру / нарезчику / разработчику =====
app.post('/api/req/create', checkAccess, (req, res) => {
  const b = req.body || {};
  let logoUrl = null;
  if (b.logoData && /^data:image\//.test(b.logoData)) {
    try {
      const ext = (b.logoData.match(/^data:image\/(\w+)/) || [])[1] || 'png';
      const data = b.logoData.split(',')[1];
      const fn = 'logo_' + Date.now() + '.' + ext;
      fs.writeFileSync(path.join(UPLOADS, fn), Buffer.from(data, 'base64'));
      logoUrl = '/uploads/' + fn;
    } catch (e) {}
  }
  const r = store.createReq({ type: b.type, brief: b.brief, logoUrl, videoUrl: b.videoUrl, params: b.params });
  res.json({ request: r });
});
app.get('/api/req/list', checkAccess, (req, res) => {
  res.json({ requests: store.listReq(req.query.type || null) });
});
app.post('/api/req/fulfill', checkAccess, (req, res) => {
  const b = req.body || {};
  const r = store.fulfillReq(parseInt(b.id), b.deliverables || [], b.note || '', b.status || 'done');
  if (!r) return res.status(404).json({ error: 'Заявка не найдена' });
  res.json({ request: r });
});

app.get('*', (req, res) => res.sendFile(INDEX));

app.listen(PORT, () => console.log('POKEROK HQ AI running on port ' + PORT + (API_KEY ? ' (ИИ включён)' : ' (без ключа — демо)')));
