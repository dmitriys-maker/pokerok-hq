/**
 * Хранилище задач команды ПОКЕРОК HQ.
 * Пишет в JSON-файл. На Railway для постоянства смонтируй volume и задай DATA_DIR=/data.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DIR, 'tasks.json');

let cache = null;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { cache = { tasks: [], feed: [], seq: 0 }; }
  if (!cache.tasks) cache.tasks = [];
  if (!cache.feed) cache.feed = [];
  if (!cache.seq) cache.seq = 0;
  if (!cache.requests) cache.requests = [];
  if (!cache.reqSeq) cache.reqSeq = 0;
  return cache;
}
function createReq(r) {
  const d = load();
  d.reqSeq += 1;
  const req = {
    id: d.reqSeq, type: r.type || 'design', brief: r.brief || '',
    logoUrl: r.logoUrl || null, videoUrl: r.videoUrl || null, params: r.params || {},
    status: 'pending', deliverables: [], note: '', createdAt: Date.now()
  };
  d.requests.unshift(req); save(); return req;
}
function listReq(type) { const d = load(); return type ? d.requests.filter(r => r.type === type) : d.requests; }
function fulfillReq(id, deliverables, note, status) {
  const d = load(); const r = d.requests.find(x => x.id === id);
  if (!r) return null;
  if (deliverables) r.deliverables = (r.deliverables || []).concat(deliverables);
  if (note) r.note = note;
  r.status = status || 'done'; save(); return r;
}
function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(cache)); }
  catch (e) { console.error('tasks save error', e.message); }
}
function nextId() { const d = load(); d.seq += 1; return d.seq; }

function addTask(t) {
  const d = load();
  const task = {
    id: nextId(),
    title: t.title || 'Задача',
    status: t.status || 'backlog',          // backlog | progress | done
    assignee: t.assignee || null,           // id агента
    assigneeName: t.assigneeName || null,
    assigneeEmoji: t.assigneeEmoji || '',
    priority: t.priority || 'P1',           // P0 | P1 | P2
    deadline: t.deadline || null,           // 'YYYY-MM-DD'
    note: t.note || '',
    by: t.by || 'boss',
    createdAt: Date.now()
  };
  d.tasks.unshift(task);
  save();
  return task;
}
function moveTask(id, status) {
  const d = load();
  const t = d.tasks.find(x => x.id === id);
  if (t) { t.status = status; save(); }
  return t;
}
function deleteTask(id) {
  const d = load();
  d.tasks = d.tasks.filter(x => x.id !== id);
  save();
}
function addFeed(entry) {
  const d = load();
  d.feed.unshift({ at: Date.now(), ...entry });
  if (d.feed.length > 100) d.feed.length = 100;
  save();
}
function summary() {
  const d = load();
  const by = (k, v) => d.tasks.filter(t => t[k] === v).length;
  return {
    total: d.tasks.length,
    backlog: by('status', 'backlog'),
    progress: by('status', 'progress'),
    done: by('status', 'done'),
    p0: d.tasks.filter(t => t.priority === 'P0' && t.status !== 'done').length
  };
}

module.exports = { load, save, addTask, moveTask, deleteTask, addFeed, summary, createReq, listReq, fulfillReq, DIR, FILE };
