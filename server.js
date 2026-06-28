/**
 * ПОКЕРОК HQ — ИИ-чат с командой
 * Express + Anthropic API. Ключ только на сервере (env), клиенту не отдаётся.
 * Плоская структура: index.html лежит рядом с server.js (удобно для деплоя).
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { AGENTS } = require('./agents');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.MODEL || 'claude-haiku-4-5-20251001';
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';

app.use(express.json({ limit: '1mb' }));

// index.html ищем рядом (плоско) или в public/ (если структура с папкой)
const INDEX = fs.existsSync(path.join(__dirname, 'index.html'))
  ? path.join(__dirname, 'index.html')
  : path.join(__dirname, 'public', 'index.html');

function checkAccess(req, res, next) {
  if (!ACCESS_PASSWORD) return next();
  const pass = req.headers['x-access-password'] || (req.body && req.body.password);
  if (pass === ACCESS_PASSWORD) return next();
  return res.status(401).json({ error: 'Неверный пароль доступа' });
}

async function callClaude(system, messages, maxTokens = 600) {
  if (!API_KEY) {
    return '⚠️ ИИ не подключён: на сервере не задан ANTHROPIC_API_KEY. Это демо-ответ. Добавь ключ в переменные окружения — и я заговорю по-настоящему.';
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages })
  });
  const data = await r.json();
  if (!r.ok) {
    console.error('Anthropic error', data);
    return '⚠️ Ошибка ИИ: ' + (data.error && data.error.message ? data.error.message : 'неизвестно');
  }
  return (data.content && data.content[0] && data.content[0].text) || '(пустой ответ)';
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
  const msgs = [];
  (history || []).slice(-10).forEach(h => msgs.push({ role: h.role, content: h.content }));
  msgs.push({ role: 'user', content: message });
  const reply = await callClaude(agent.system, msgs, 600);
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

app.get('*', (req, res) => res.sendFile(INDEX));

app.listen(PORT, () => console.log('POKEROK HQ AI running on port ' + PORT + (API_KEY ? ' (ИИ включён)' : ' (без ключа — демо)')));
