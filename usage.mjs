import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERIODS = ['today', '7d', 'week', 'month', '30d', 'all', 'custom'];
const SORTS = ['updated', 'tokens', 'cache_rate', 'input', 'output', 'turns'];

function calendarDate(value) {
  if (!DATE.test(value ?? '')) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? date : null;
}

function shiftDate(value, dayCount) {
  const date = calendarDate(value);
  date.setUTCDate(date.getUTCDate() + dayCount);
  return date.toISOString().slice(0, 10);
}

export function readQuery(params, now = new Date()) {
  const period = params.get('period') || 'today';
  const timeZone = params.get('timezone') || 'Asia/Shanghai';
  const sort = params.get('sort') || 'updated';
  const order = params.get('order') || 'desc';
  if (!PERIODS.includes(period) || !SORTS.includes(sort) || !['asc', 'desc'].includes(order)) {
    throw new RangeError('筛选或排序参数无效。');
  }
  let format;
  try {
    format = new Intl.DateTimeFormat('sv-SE', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    });
  } catch {
    throw new RangeError('时区无效。');
  }
  const localTime = (time) => format.format(time);
  const current = localTime(now);
  const today = current.slice(0, 10);
  const currentHour = Number(current.slice(11, 13));
  let start = today;
  let end = today;
  switch (period) {
    case '7d': start = shiftDate(today, -6); break;
    case '30d': start = shiftDate(today, -29); break;
    case 'week': start = shiftDate(today, -((calendarDate(today).getUTCDay() + 6) % 7)); break;
    case 'month': start = `${today.slice(0, 7)}-01`; break;
    case 'all': start = end = null; break;
    case 'custom':
      start = params.get('from');
      end = params.get('to');
      if (!calendarDate(start) || !calendarDate(end) || start > end) {
        throw new RangeError('请选择有效的起止日期。');
      }
      break;
  }
  return { period, timeZone, today, currentHour, start, end, sort, order, model: params.get('model') || '', localTime };
}

function tokenCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

async function readTranscript(file, id) {
  const result = { id, title: '', events: [] };
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type === 'USER_INPUT' && !result.title && typeof row.content === 'string') {
      const request = row.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
      result.title = (request?.[1] ?? row.content).replace(/\s+/g, ' ').trim().slice(0, 160);
    }
    if (row?.type !== 'PLANNER_RESPONSE' || typeof row.created_at !== 'string') continue;
    const time = Date.parse(row.created_at);
    if (!Number.isFinite(time)) continue;
    result.events.push({
      time,
      step: Number.isSafeInteger(row.step_index) ? row.step_index : result.events.length,
      model: typeof row.model === 'string' && row.model.trim() ? row.model.trim().slice(0, 100) : 'unknown',
      input: tokenCount(row.input_tokens),
      cached: tokenCount(row.cache_read_tokens),
      output: tokenCount(row.output_tokens),
    });
  }
  result.events.sort((a, b) => a.time - b.time);
  return result;
}

export class TranscriptSource {
  #cache = new Map();
  #pending;

  constructor(directory) {
    this.directory = directory;
  }

  read() {
    this.#pending ??= this.#scan().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #scan() {
    let dirs;
    try {
      dirs = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return { source: 'missing', skipped: 0, records: [] };
      throw error;
    }
    const records = [];
    const nextCache = new Map();
    let skipped = 0;
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const file = join(this.directory, dir.name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        const signature = `${info.size}:${info.mtimeMs}:${info.ino}`;
        let entry = this.#cache.get(dir.name);
        if (entry?.signature !== signature) {
          entry = { signature, data: await readTranscript(file, dir.name) };
        }
        nextCache.set(dir.name, entry);
        records.push(entry.data);
      } catch (error) {
        if (error.code !== 'ENOENT') skipped++;
      }
    }
    this.#cache = nextCache;
    return { source: 'ready', skipped, records };
  }
}

function stats() {
  return { input: 0, cached: 0, output: 0, total: 0, turns: 0, uncachedTurns: 0 };
}

function add(target, event) {
  target.input += event.input;
  target.cached += event.cached;
  target.output += event.output;
  target.total += event.input + event.cached + event.output;
  target.turns++;
  if (!event.cached && event.input) target.uncachedTurns++;
  return target;
}

function addToMap(map, key, event) {
  if (!map.has(key)) map.set(key, stats());
  add(map.get(key), event);
}

function withRate(totals) {
  const input = totals.input + totals.cached;
  return { ...totals, rate: input ? totals.cached / input : null };
}

export function buildUsage(snapshot, query, sessionId) {
  const { start, end, localTime, model, period, today, currentHour, timeZone, sort, order } = query;
  const summary = stats();
  const availableModels = new Set();
  const modelTotals = new Map();
  const sessionList = [];
  const buckets = new Map();
  let detail = null;

  for (const record of snapshot.records) {
    if (sessionId && sessionId !== record.id) continue;
    const sessionTotals = stats();
    const sessionModels = new Map();
    const events = [];
    let first, last;
    for (const event of record.events) {
      const stamp = localTime(event.time);
      const date = stamp.slice(0, 10);
      if ((start && date < start) || (end && date > end)) continue;
      availableModels.add(event.model);
      if (model && event.model !== model) continue;
      first ??= event.time;
      last = event.time;
      add(sessionTotals, event);
      addToMap(sessionModels, event.model, event);
      if (sessionId) {
        events.push({ ...event, total: event.input + event.cached + event.output });
      } else {
        add(summary, event);
        addToMap(modelTotals, event.model, event);
        addToMap(buckets, start === end && start ? stamp.slice(0, 13) : date, event);
      }
    }
    if (!sessionTotals.turns) continue;
    const models = [...sessionModels].sort((a, b) => b[1].total - a[1].total || b[1].turns - a[1].turns || a[0].localeCompare(b[0]));
    const session = {
      id: record.id, title: record.title || '未命名会话', startedAt: first, updatedAt: last,
      models: models.map(([name]) => name), ...withRate(sessionTotals),
    };
    sessionList.push(session);
    if (sessionId) detail = { ...session, events, breakdown: models.map(([name, totals]) => ({ name, ...withRate(totals) })) };
  }

  if (sessionId) return detail;

  const field = { updated: 'updatedAt', tokens: 'total', cache_rate: 'rate', input: 'input', output: 'output', turns: 'turns' }[sort];
  const direction = order === 'desc' ? -1 : 1;
  sessionList.sort((a, b) => direction * ((a[field] ?? -1) - (b[field] ?? -1)) || b.updatedAt - a.updatedAt);
  if (start && start === end) {
    const lastHour = start === today ? currentHour : 23;
    for (let hour = 0; hour <= lastHour; hour++) {
      const key = `${start} ${String(hour).padStart(2, '0')}`;
      if (!buckets.has(key)) buckets.set(key, stats());
    }
  } else if (start && end && (calendarDate(end) - calendarDate(start)) <= 60 * 86400000) {
    for (let day = start; day <= end; day = shiftDate(day, 1)) {
      if (!buckets.has(day)) buckets.set(day, stats());
    }
  }
  const modelBreakdown = [...modelTotals]
    .map(([name, totals]) => ({ name, ...withRate(totals) }))
    .sort((a, b) => b.total - a.total || b.turns - a.turns || a.name.localeCompare(b.name));
  return {
    modelBreakdown,
    meta: { period, timeZone, start, end, today, source: snapshot.source, skipped: snapshot.skipped, generatedAt: Date.now() },
    summary: { ...withRate(summary), sessions: sessionList.length, multiModel: sessionList.filter((session) => session.models.length > 1).length },
    timeline: [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([label, totals]) => ({ label, ...totals })),
    models: [...availableModels].sort(), sessions: sessionList,
  };
}
