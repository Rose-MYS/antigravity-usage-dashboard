const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('zh-CN');
const periods = ['today', '7d', 'week', 'month', '30d', 'all', 'custom'];
const sorts = ['updated', 'tokens', 'cache_rate', 'input', 'output', 'turns'];
const homeZone = 'Asia/Shanghai';
const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const mobile = matchMedia('(max-width: 850px)');
const modelPalette = ['--arc-blue', '--arc-green', '--arc-gold', '--arc-coral', '--model-teal', '--model-red', '--model-violet', '--model-slate'];
const sessionRows = new Map();
const folded = new Set();
const emptyDetail = $('detail').firstElementChild.cloneNode(true);

function readSetting(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function saveSetting(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Settings still apply for this tab. */ }
}

function queryFromUrl() {
  const params = new URLSearchParams(location.search);
  const period = params.get('period');
  const sort = params.get('sort');
  return {
    period: periods.includes(period) ? period : 'today',
    timezone: params.get('timezone') || readSetting('timezone', homeZone),
    sort: sorts.includes(sort) ? sort : 'updated',
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
    model: params.get('model') || '',
    from: params.get('from') || '',
    to: params.get('to') || '',
  };
}

let query = queryFromUrl();
let view = readSetting('view', 'model') === 'session' ? 'session' : 'model';
let hideTitles = readSetting('hideTitles', 'false') === 'true';
let autoRefresh = readSetting('autoRefresh', 'true') === 'true';
let data;
let selectedId = '';
let details;
let modelOverviewOpen = false;
let overviewRequest;
let detailRequest;
let timeFormat;
let dateTimeFormat;

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content != null) element.textContent = content;
  return element;
}

function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  svg.setAttribute('class', `icon ${className}`);
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function compact(value) {
  for (const [unit, divisor] of [['B', 1e9], ['M', 1e6], ['K', 1e3]]) {
    if (value >= divisor) {
      const scaled = value / divisor;
      return `${Number(scaled.toFixed(scaled >= 100 ? 1 : 2))}${unit}`;
    }
  }
  return number.format(value);
}

function percent(value) {
  return value == null ? '—' : `${(100 * value).toFixed(1)}%`;
}

function timeLabel(value) {
  return timeFormat.format(value);
}

function titleFor(session) {
  return hideTitles ? '会话 ' + session.id.slice(0, 8) : session.title;
}

function apiParams() {
  const params = new URLSearchParams(query);
  if (query.period !== 'custom') {
    params.delete('from');
    params.delete('to');
  }
  if (!query.model) params.delete('model');
  if (query.order === 'desc') params.delete('order');
  return params;
}

function updateQuery(changes) {
  query = { ...query, ...changes };
  history.pushState(null, '', `/?${apiParams()}`);
  updateControls();
  refresh(true);
}

function updateControls() {
  for (const button of $('quick-periods').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', button.dataset.period === query.period);
  }
  for (const button of $('view-controls').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', button.dataset.view === view);
  }
  $('sort').value = query.sort;
  $('sort-direction').dataset.order = query.order;
  $('sort-direction').title = query.order === 'desc' ? '降序' : '升序';
  $('filter-count').hidden = !query.model;
  $('filter-trigger').title = query.model ? `当前模型：${query.model}` : '按模型和时区筛选';
}

async function getJson(path, params, signal) {
  const response = await fetch(`${path}?${params}`, { signal, cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '无法读取用量。');
  return result;
}

function dateText(date, full) {
  const [year, month, day] = date.split('-').map(Number);
  return `${full ? year + '年' : ''}${month}月${day}日`;
}

function smoothPath(points) {
  if (points.length < 3) return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  let path = `M${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const mid = (x0 + x1) / 2;
    path += ` C${mid.toFixed(2)} ${y0.toFixed(2)} ${mid.toFixed(2)} ${y1.toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  return path;
}

function chart(container, items) {
  if (!items.length) {
    container.replaceChildren();
    return;
  }
  const width = 500;
  const height = 148;
  const grand = Math.max(1, items.reduce((sum, item) => sum + item.total, 0));
  let running = 0;
  const points = [[0, height], ...items.map((item, i) => {
    running += item.total;
    return [((i + 1) / items.length) * width, height - (running / grand) * (height - 7)];
  })];
  const line = smoothPath(points);
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="overview-stroke" gradientUnits="userSpaceOnUse" x1="0" x2="${width}">
      <stop offset="0%" stop-color="var(--arc-blue)"/><stop offset="35%" stop-color="var(--arc-green)"/>
      <stop offset="69%" stop-color="var(--arc-gold)"/><stop offset="100%" stop-color="var(--arc-coral)"/>
    </linearGradient><linearGradient id="overview-fill" x2="0%" y2="100%"><stop offset="0%" stop-color="currentColor" stop-opacity=".16"/><stop offset="100%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
    <path d="${line} V${height}H0Z" fill="url(#overview-fill)"/>
    <path d="${line}" fill="none" stroke="url(#overview-stroke)" stroke-width="2.4" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function niceStep(value) {
  const raw = Math.max(1, value);
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 1.5, 2, 2.5, 3, 5, 10].map((factor) => factor * power).find((step) => step >= raw);
}

function detailChart(container, events, format) {
  container.replaceChildren();
  if (!events.length) {
    container.append(node('p', 'chart-empty', '这个范围内没有请求'));
    return;
  }
  const width = 600;
  const height = 180;
  const totals = events.map((event) => event.total);
  const grand = totals.reduce((sum, value) => sum + value, 0);
  const step = niceStep(grand / 3);
  const top = step * 3;
  const startTime = events[0].time;
  const elapsed = events.at(-1).time - startTime;
  const xAt = (i) => (elapsed > 0 ? (events[i].time - startTime) / elapsed : (events.length > 1 ? i / (events.length - 1) : 1));
  let running = 0;
  const points = totals.map((value, i) => {
    running += value;
    return { x: xAt(i), y: running / top, cumulative: running, event: events[i] };
  });
  const maxSingle = Math.max(1, ...totals);
  const coords = [[0, height], ...points.map((point) => [point.x * width, height - point.y * height])];
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const barWidth = Math.max(1.5, Math.min(8, width / events.length * 0.55));
  const bars = points.map((point, i) => {
    const h = Math.max(1.5, totals[i] / maxSingle * height * 0.28);
    const x = Math.max(0, Math.min(width - barWidth, point.x * width - barWidth / 2));
    return `<rect x="${x.toFixed(2)}" y="${(height - h).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${h.toFixed(2)}" rx="1" class="bar"/>`;
  }).join('');
  const xTicks = [0, 1 / 3, 2 / 3, 1];
  const grid = [1, 2, 3].map((n) => `M0 ${(height - n / 3 * height).toFixed(2)}H${width}`)
    .concat(xTicks.slice(1, -1).map((t) => `M${(t * width).toFixed(2)} 0V${height}`)).join(' ');

  const frame = node('div', 'chart-frame');
  const yAxis = node('div', 'y-axis');
  for (let n = 0; n <= 3; n++) {
    const tick = node('span', '', compact(step * n));
    tick.style.setProperty('--at', `${n / 3 * 100}%`);
    yAxis.append(tick);
  }
  const plot = node('div', 'plot');
  plot.tabIndex = 0;
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', `累计用量从 0 增至 ${number.format(grand)} tokens，共 ${events.length} 次请求。可用左右方向键查看每次请求。`);
  plot.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="detail-fill" x2="0%" y2="100%"><stop offset="0%" stop-color="currentColor" stop-opacity=".2"/><stop offset="100%" stop-color="currentColor" stop-opacity=".02"/></linearGradient></defs>
    <path d="${grid}" class="grid" vector-effect="non-scaling-stroke"/>
    <path d="M0 ${height}H${width}" class="baseline" vector-effect="non-scaling-stroke"/>
    ${bars}
    <path d="${line} V${height}H0Z" fill="url(#detail-fill)"/>
    <path d="${line}" class="line" vector-effect="non-scaling-stroke"/>
  </svg>`;
  const cursor = node('i', 'chart-cursor');
  const dot = node('i', 'chart-dot');
  cursor.hidden = dot.hidden = true;
  plot.append(cursor, dot);
  const xAxis = node('div', 'x-axis');
  for (const t of xTicks) {
    const time = elapsed > 0 ? startTime + t * elapsed : events[Math.round(t * (events.length - 1))].time;
    const label = node('span', '', format.format(time));
    label.style.setProperty('--at', `${t * 100}%`);
    xAxis.append(label);
  }
  frame.append(yAxis, plot, node('span'), xAxis);
  container.append(frame);

  let active = -1;
  const show = (index, anchor) => {
    active = Math.max(0, Math.min(points.length - 1, index));
    const point = points[active];
    for (const mark of [cursor, dot]) {
      mark.hidden = false;
      mark.style.setProperty('--x', `${point.x * 100}%`);
      mark.style.setProperty('--y', `${point.y * 100}%`);
    }
    const rect = plot.getBoundingClientRect();
    tooltip.show([
      [format.format(point.event.time), point.event.model],
      ['累计', `${number.format(point.cumulative)} tokens`],
      ['本次请求', `${number.format(point.event.total)} tokens`],
    ], anchor ?? { x: rect.left + point.x * rect.width, y: rect.top + (1 - point.y) * rect.height });
  };
  const hide = () => {
    cursor.hidden = dot.hidden = true;
    tooltip.hide();
  };
  plot.addEventListener('pointermove', (event) => {
    const rect = plot.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    let nearest = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].x - fraction) < Math.abs(points[nearest].x - fraction)) nearest = i;
    }
    show(nearest, { x: event.clientX, y: event.clientY });
  });
  plot.addEventListener('pointerleave', hide);
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (event) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const move = moves[event.key];
    show(Number.isFinite(move) ? (active < 0 ? points.length - 1 : active + move) : (move < 0 ? 0 : points.length - 1));
  });
}

const tooltip = (() => {
  const box = $('tooltip');
  let owner = null;
  function place({ x, y }) {
    const gap = 14;
    const { width, height } = box.getBoundingClientRect();
    const left = x + gap + width > innerWidth - 8 ? x - gap - width : x + gap;
    const top = Math.min(innerHeight - height - 8, Math.max(8, y - height - gap));
    box.style.setProperty('left', `${Math.max(8, left)}px`);
    box.style.setProperty('top', `${top}px`);
  }
  function show(rows, at) {
    box.replaceChildren(...rows.map(([label, value], i) => {
      const row = node('div', i ? 'tip-row' : 'tip-title');
      row.append(node('span', '', label));
      if (value) row.append(node('b', '', value));
      return row;
    }));
    box.hidden = false;
    place(at);
  }
  function hide() {
    box.hidden = true;
    owner = null;
  }
  const rowsFor = (element) => JSON.parse(element.dataset.tip);
  const centerOf = (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top };
  };
  document.addEventListener('pointerover', (event) => {
    const target = event.target.closest?.('[data-tip]');
    if (target === owner) return;
    if (!target) {
      if (owner) hide();
      return;
    }
    owner = target;
    show(rowsFor(target), { x: event.clientX, y: event.clientY });
  });
  document.addEventListener('pointermove', (event) => {
    if (owner && !box.hidden) place({ x: event.clientX, y: event.clientY });
  });
  document.addEventListener('focusin', (event) => {
    const target = event.target.closest?.('[data-tip]');
    if (target) {
      owner = target;
      show(rowsFor(target), centerOf(target));
    }
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('scroll', hide, true);
  return { show, hide };
})();

function tip(element, rows) {
  element.dataset.tip = JSON.stringify(rows);
  return element;
}

function bucketLabel(label) {
  return label.length > 10 ? `${label.slice(11, 13)}:00` : dateText(label);
}

function dailyBars(container, buckets) {
  const items = buckets.slice(-31);
  const max = Math.max(1, ...items.map((bucket) => bucket.output));
  container.style.setProperty('--count', items.length);
  container.replaceChildren(...items.map((bucket, i) => {
    const column = node('span', 'daily-column');
    const bar = node('i', i === items.length - 1 ? 'latest' : '');
    bar.style.setProperty('--size', bucket.output ? `${Math.max(4, bucket.output / max * 100)}%` : '2px');
    column.append(bar);
    column.setAttribute('aria-label', `${bucketLabel(bucket.label)}：${number.format(bucket.output)} tokens`);
    return tip(column, [[bucketLabel(bucket.label)], ['输出', `${compact(bucket.output)} tokens`], ['请求', number.format(bucket.turns)]]);
  }));
}

function makeModelCard(model, index, total) {
  const card = node('article', 'model-card');
  card.style.setProperty('--model-color', `var(${modelPalette[index % modelPalette.length]})`);
  card.style.setProperty('--delay', `${Math.min(index, 8) * 22}ms`);
  card.tabIndex = 0;
  const share = total ? model.total / total : null;
  const heading = node('h3', 'model-card-name');
  heading.append(node('i'), node('span', '', model.name));
  const values = node('div', 'model-card-values');
  values.append(node('strong', '', compact(model.total)), node('span', '', percent(share)));
  card.append(heading, values, node('p', 'model-card-meta', `${number.format(model.turns)} 次请求 · 缓存命中 ${percent(model.rate)}`));
  card.setAttribute('aria-label', `${model.name}：${number.format(model.total)} tokens，占 ${percent(share)}`);
  return tip(card, [
    [model.name],
    ['用量', `${number.format(model.total)} tokens`],
    ['占总用量', percent(share)],
    ['请求', number.format(model.turns)],
    ['缓存命中', percent(model.rate)],
  ]);
}

function setModelOverview(open) {
  const models = data?.modelBreakdown ?? [];
  const toggle = $('model-toggle');
  const label = $('model-toggle-label');
  const panel = $('model-panel');
  const overflow = $('model-overflow');
  const visibleCount = 6;
  modelOverviewOpen = open && models.length > 0;
  const showOverflow = modelOverviewOpen && models.length > visibleCount;
  const total = data?.summary.total ?? 0;
  drawModelBorder();

  toggle.disabled = !models.length;
  toggle.setAttribute('aria-expanded', modelOverviewOpen);
  toggle.setAttribute('aria-controls', showOverflow ? 'model-panel model-overflow' : 'model-panel');
  toggle.setAttribute('aria-label', modelOverviewOpen ? '返回用量概览' : '按模型查看用量');
  toggle.title = toggle.getAttribute('aria-label');
  label.textContent = modelOverviewOpen ? '返回概览' : '按模型';
  $('metrics').classList.toggle('models-open', modelOverviewOpen);
  panel.hidden = !modelOverviewOpen;
  overflow.hidden = !showOverflow;
  if (!modelOverviewOpen) return;

  const cards = models.map((model, index) => makeModelCard(model, index, total));
  panel.classList.toggle('single-row', models.length <= 3);
  panel.replaceChildren(...cards.slice(0, visibleCount));
  overflow.replaceChildren(...cards.slice(visibleCount));
}

function drawModelBorder() {
  const svg = $('model-border');
  const hero = svg.parentElement;
  const models = data?.modelBreakdown ?? [];
  const total = models.reduce((sum, model) => sum + model.total, 0);
  const width = hero.clientWidth;
  const height = hero.clientHeight;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  let offset = 0;
  svg.replaceChildren(...models.map((model, index) => {
    const share = total ? model.total / total * 100 : 100 / models.length;
    const rect = document.createElementNS(svg.namespaceURI, 'rect');
    for (const [key, value] of Object.entries({
      x: 1.5, y: 1.5, width: Math.max(0, width - 3), height: Math.max(0, height - 3), rx: 14.5,
      pathLength: 100, stroke: `var(${modelPalette[index % modelPalette.length]})`,
      'stroke-dasharray': `${share} ${100 - share}`,
    })) rect.setAttribute(key, value);
    rect.style.setProperty('--offset', -offset);
    offset += share;
    return rect;
  }).filter((_, index) => models[index].total || !total));
  $('metrics').style.setProperty('--hero-height', `${height}px`);
}

new ResizeObserver(drawModelBorder).observe($('model-border').parentElement);
$('model-toggle').addEventListener('click', () => setModelOverview(!modelOverviewOpen));
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !modelOverviewOpen || document.querySelector('dialog[open]')) return;
  setModelOverview(false);
  $('model-toggle').focus({ preventScroll: true });
});

function renderOverview() {
  const { summary, timeline, meta } = data;
  timeFormat = new Intl.DateTimeFormat('zh-CN', {
    timeZone: meta.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  dateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
    timeZone: meta.timeZone, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const label = meta.start ? dateText(meta.start, true) : '全部时间';
  const end = meta.end && meta.end !== meta.start ? ' – ' + dateText(meta.end, meta.end.slice(0, 4) !== meta.start.slice(0, 4)) : '';
  $('date-label').textContent = label + end;
  $('date-trigger').title = `${label}${end} · ${meta.timeZone}`;
  for (const key of ['total', 'output']) {
    $(key).textContent = compact(summary[key]);
    $(key).title = number.format(summary[key]) + ' tokens';
  }
  $('session-count').textContent = number.format(summary.sessions);
  $('single-model').textContent = number.format(summary.sessions - summary.multiModel);
  $('multi-model').textContent = number.format(summary.multiModel);
  $('rate').textContent = percent(summary.rate);
  $('cache-ring').style.setProperty('--fill', percent(summary.rate ?? 0));
  $('session-ring').style.setProperty('--fill', percent(summary.sessions ? (summary.sessions - summary.multiModel) / summary.sessions : 0));
  $('session-ring').style.setProperty('--remainder', summary.sessions ? 'var(--session-secondary)' : 'var(--ring-track)');
  $('hero-caption').textContent = `${number.format(summary.turns)} 次模型请求`;
  $('output-caption').textContent = summary.total ? `占总量 ${percent(summary.output / summary.total)}` : '模型输出';
  $('cache-caption').textContent = `缓存 ${compact(summary.cached)} / 输入 ${compact(summary.input + summary.cached)}`;
  $('cache-caption').title = '缓存输入 ÷（未缓存输入 + 缓存输入）';
  chart($('hero-chart'), timeline);
  setModelOverview(modelOverviewOpen);
  dailyBars($('output-chart'), timeline);
  $('output-chart').setAttribute('aria-label', meta.start && meta.start === meta.end ? '每小时输出用量' : '每日输出用量');
  tip($('cache-ring'), [[`缓存命中率 · ${percent(summary.rate)}`], ['缓存输入', `${number.format(summary.cached)} tokens`], ['未缓存输入', `${number.format(summary.input)} tokens`]]);
  const single = summary.sessions - summary.multiModel;
  tip($('session-ring'), [['会话构成'], ['单模型', `${number.format(single)} · ${percent(summary.sessions ? single / summary.sessions : null)}`], ['多模型', `${number.format(summary.multiModel)} · ${percent(summary.sessions ? summary.multiModel / summary.sessions : null)}`]]);

  const note = meta.source === 'missing' ? '未找到 Antigravity 日志目录。请启动 Antigravity，或设置 ANTIGRAVITY_BRAIN_DIR。'
    : meta.skipped ? `有 ${meta.skipped} 份日志暂时无法读取，刷新后会重试。` : '';
  showNotice(note);
  $('refresh-status').textContent = `已更新 ${timeLabel(meta.generatedAt)} · ${meta.timeZone}`;
}

function showNotice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function rowStats(row, values) {
  const total = node('span', '', compact(values.total));
  total.title = number.format(values.total) + ' tokens';
  row.append(total, node('span', '', number.format(values.turns)), node('span', 'rate-cell', percent(values.rate)));
}

function makeSessionRow(session, nested = false) {
  const row = node('button', `row-grid session-row${nested ? '' : ' standalone'}`);
  row.type = 'button';
  row.dataset.session = session.id;
  row.setAttribute('aria-pressed', session.id === selectedId);
  const title = titleFor(session);
  const name = node('span', 'name');
  const identity = node('span', 'identity');
  const heading = node('span', 'session-title', title);
  heading.title = title;
  const meta = node('span', 'row-meta');
  const model = node('span', 'model-tag', session.models[0]);
  model.title = session.models.join(' · ');
  meta.append(model);
  if (session.models.length > 1) meta.append(node('span', '', `+${session.models.length - 1}`));
  meta.append(node('span', '', data.meta.start === data.meta.end && data.meta.start
    ? timeLabel(session.updatedAt) : dateTimeFormat.format(session.updatedAt)));
  identity.append(heading, meta);
  name.append(icon('message'), identity);
  row.append(name);
  rowStats(row, session);
  sessionRows.set(session.id, row);
  return row;
}

function sessionGroups(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const key = session.models[0];
    if (!groups.has(key)) groups.set(key, { key, sessions: [], updatedAt: 0, total: 0, turns: 0, cached: 0, input: 0, output: 0 });
    const group = groups.get(key);
    group.sessions.push(session);
    group.updatedAt = Math.max(group.updatedAt, session.updatedAt);
    for (const metric of ['total', 'turns', 'cached', 'input', 'output']) group[metric] += session[metric];
  }
  const field = { updated: 'updatedAt', tokens: 'total', cache_rate: 'rate', input: 'input', output: 'output', turns: 'turns' }[query.sort];
  const direction = query.order === 'desc' ? -1 : 1;
  return [...groups.values()].map((group) => ({
    ...group, rate: group.cached + group.input ? group.cached / (group.cached + group.input) : null,
  })).sort((a, b) => direction * ((a[field] ?? -1) - (b[field] ?? -1)) || a.key.localeCompare(b.key));
}

function makeGroup(group) {
  const block = node('details');
  block.dataset.model = group.key;
  block.open = !folded.has(group.key);
  const row = node('summary', 'row-grid group-row');
  const name = node('span', 'name');
  const heading = node('span', 'identity');
  heading.append(node('strong', '', group.key), node('span', 'row-meta', `${group.sessions.length} 个会话`));
  name.append(icon('chevron', 'chevron'), icon('stack', 'group-icon'), heading);
  row.append(name);
  rowStats(row, group);
  const children = node('div', 'group-sessions');
  children.append(...group.sessions.map((session) => makeSessionRow(session, true)));
  block.append(row, children);
  return block;
}

function renderList() {
  if (!data) return;
  const search = $('search').value.trim().toLocaleLowerCase();
  const sessions = data.sessions.filter((session) => (
    titleFor(session).toLocaleLowerCase().includes(search)
    || session.models.some((model) => model.toLocaleLowerCase().includes(search))
  ));
  const list = $('session-list');
  const active = document.activeElement;
  const activeId = active?.dataset.session;
  const activeGroup = active?.closest('details')?.dataset.model;
  const scroll = list.scrollTop;
  for (const group of list.querySelectorAll('details')) {
    if (group.open) folded.delete(group.dataset.model);
    else folded.add(group.dataset.model);
  }
  sessionRows.clear();
  const groups = view === 'model' ? sessionGroups(sessions) : null;
  list.replaceChildren(...(groups ? groups.map(makeGroup) : sessions.map((session) => makeSessionRow(session))));
  list.scrollTop = scroll;
  if (activeId) sessionRows.get(activeId)?.focus({ preventScroll: true });
  else if (activeGroup) [...list.querySelectorAll('details')].find((group) => group.dataset.model === activeGroup)?.firstElementChild.focus({ preventScroll: true });
  $('list-count').textContent = groups ? `${groups.length} 个模型组` : `${sessions.length} 个会话`;
  $('list-status').hidden = sessions.length > 0;
  $('list-status').textContent = search ? '没有匹配的会话' : '这个范围内还没有会话记录';
}

function section(title) {
  const result = node('section', 'detail-section');
  result.append(node('h3', 'section-label', title));
  return result;
}

function table(headers, rows) {
  const wrapper = node('div', 'data-table');
  const grid = node('table');
  const head = grid.createTHead().insertRow();
  for (const header of headers) {
    const cell = node('th', '', header);
    cell.scope = 'col';
    head.append(cell);
  }
  const body = grid.createTBody();
  for (const row of rows) {
    const element = body.insertRow();
    for (const item of row) element.insertCell().textContent = item;
  }
  wrapper.append(grid);
  return wrapper;
}

function renderDetail() {
  if (!details) return;
  const durationFormat = data.meta.start === data.meta.end && data.meta.start ? timeFormat : dateTimeFormat;
  const started = durationFormat.format(details.startedAt);
  const updated = durationFormat.format(details.updatedAt);
  const body = node('div', 'detail-body');
  const heading = node('header', 'detail-heading');
  const close = node('button', 'icon-button');
  close.type = 'button';
  close.title = '关闭会话详情';
  close.setAttribute('aria-label', close.title);
  close.append(icon('close'));
  close.addEventListener('click', () => closeDetail(true));
  heading.append(node('h2', '', titleFor(details)), close);
  const meta = node('div', 'detail-meta');
  meta.append(...details.models.map((model) => node('span', 'model-tag', model)));
  meta.append(node('span', '', `${started} – ${updated}`));
  const label = node('h3', 'section-label', '总用量');
  const total = node('div', 'detail-total');
  const value = node('div');
  value.append(node('strong', '', compact(details.total)), node('small', '', ' tokens'));
  value.title = number.format(details.total) + ' tokens';
  total.append(value, node('span', '', `${number.format(details.turns)} 次请求 · 缓存命中 ${percent(details.rate)}`));
  body.append(heading, meta, label, total);

  const entries = [['input', '未缓存输入'], ['cached', '缓存输入'], ['output', '输出']];
  const colors = ['--input-color', '--cache-color', '--output-color'];
  const breakdown = section('用量构成');
  const segments = node('div', 'focus-bars');
  const stats = node('div', 'section-data');
  entries.forEach(([key, text], i) => {
    const value = details[key];
    const part = details.total ? value / details.total : 0;
    const line = node('div', 'usage-line');
    const bar = node('span', 'track');
    const fill = node('i');
    fill.style.setProperty('--size', percent(part));
    fill.style.setProperty('--color', `var(${colors[i]})`);
    bar.append(fill);
    line.append(node('span', '', text), bar, node('span', '', number.format(value)));
    body.append(line);
    segments.append(fill.cloneNode());
    const metric = node('div', '', text + ' · ' + percent(part));
    metric.append(node('b', '', compact(value)));
    stats.append(metric);
  });

  const trend = section('用量走势');
  const trendHead = node('div', 'chart-head');
  const legend = node('span', 'chart-legend');
  const lineKey = node('span');
  lineKey.append(node('i', 'line-key'), '累计用量');
  const barKey = node('span');
  barKey.append(node('i', 'bar-key'), '单次请求');
  legend.append(lineKey, barKey);
  trendHead.append(trend.firstElementChild, legend);
  const graph = node('div', 'detail-chart');
  detailChart(graph, details.events, durationFormat);
  trend.append(trendHead, graph);
  breakdown.append(segments, stats);
  body.append(trend, breakdown);

  const byModel = section('模型明细');
  byModel.append(table(['模型', '用量 (tokens)', '请求', '缓存命中'], details.breakdown.map((item) => [
    item.name, number.format(item.total), number.format(item.turns), percent(item.rate),
  ])));
  const events = section('请求明细');
  events.append(table(['时间', '模型', '未缓存输入', '缓存输入', '输出'], [...details.events].reverse().map((item) => [
    durationFormat.format(item.time), item.model, number.format(item.input), number.format(item.cached), number.format(item.output),
  ])));
  body.append(byModel, events);
  const panel = $('detail');
  const oldScroll = panel.scrollTop;
  const closeFocused = panel.contains(document.activeElement) && document.activeElement.tagName === 'BUTTON';
  panel.replaceChildren(body);
  panel.scrollTop = oldScroll;
  if (closeFocused) close.focus({ preventScroll: true });
}

function closeDetail(restoreFocus = false) {
  const row = sessionRows.get(selectedId);
  row?.setAttribute('aria-pressed', false);
  detailRequest?.abort();
  selectedId = '';
  details = undefined;
  $('detail').replaceChildren(emptyDetail.cloneNode(true));
  if (restoreFocus) row?.focus();
}

async function loadDetail(id, showLoading = false) {
  detailRequest?.abort();
  const request = new AbortController();
  detailRequest = request;
  if (showLoading) {
    $('detail').replaceChildren(node('p', 'list-status', '正在读取会话…'));
    $('detail').scrollTop = 0;
  }
  const params = apiParams();
  params.set('id', id);
  try {
    const result = await getJson('/api/session', params, request.signal);
    if (request.signal.aborted) return;
    details = result;
    renderDetail();
  } catch (error) {
    if (request.signal.aborted) return;
    if (!showLoading && details) return;
    const message = node('div', 'empty-detail');
    const retry = node('button', 'control', '返回会话列表');
    retry.addEventListener('click', () => closeDetail(true));
    message.append(node('p', '', error.message), retry);
    $('detail').replaceChildren(message);
  }
}

async function refresh(force = false) {
  if (overviewRequest && !force) return;
  overviewRequest?.abort();
  if (force) detailRequest?.abort();
  const request = new AbortController();
  overviewRequest = request;
  $('refresh').disabled = true;
  try {
    const result = await getJson('/api/usage', apiParams(), request.signal);
    if (request.signal.aborted) return;
    data = result;
    renderOverview();
    if (selectedId && !data.sessions.some((session) => session.id === selectedId)) closeDetail();
    renderList();
    if (selectedId) await loadDetail(selectedId);
  } catch (error) {
    if (request.signal.aborted) return;
    showNotice(error.message);
    $('refresh-status').textContent = data ? '刷新失败 · 显示上次读取结果' : '读取失败';
    if (!data) $('list-status').textContent = '请调整筛选，或点击刷新重试';
  } finally {
    if (overviewRequest === request) {
      overviewRequest = undefined;
      $('refresh').disabled = false;
    }
  }
}

$('session-list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-session]');
  if (!button) return;
  sessionRows.get(selectedId)?.setAttribute('aria-pressed', false);
  selectedId = button.dataset.session;
  button.setAttribute('aria-pressed', true);
  details = undefined;
  loadDetail(selectedId, true);
  if (mobile.matches) {
    $('detail').scrollIntoView({ block: 'start' });
    $('detail').focus({ preventScroll: true });
  }
});

function options(select, values) {
  select.replaceChildren(...values.map(([value, label]) => new Option(label, value)));
}

$('filter-trigger').addEventListener('click', () => {
  const models = [...new Set([...(data?.models ?? []), ...(query.model ? [query.model] : [])])];
  options($('model-filter'), [['', '全部模型'], ...models.map((name) => [name, name])]);
  const zones = [...new Set([homeZone, systemZone, 'UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'America/New_York', 'Europe/London', query.timezone])];
  options($('timezone'), zones.map((zone) => [zone, zone]));
  $('model-filter').value = query.model;
  $('timezone').value = query.timezone;
  $('filters').showModal();
});
$('filter-form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('filters').close();
  saveSetting('timezone', $('timezone').value);
  updateQuery({ timezone: $('timezone').value, model: $('model-filter').value });
});
$('reset-filters').addEventListener('click', () => {
  $('model-filter').value = '';
  $('timezone').value = homeZone;
});

function updateDateFields() {
  const custom = $('period').value === 'custom';
  $('date-fields').hidden = !custom;
  $('date-from').required = custom;
  $('date-to').required = custom;
  $('date-to').min = custom ? $('date-from').value : '';
}

$('date-trigger').addEventListener('click', () => {
  $('period').value = query.period;
  $('date-from').value = query.from || data?.meta.start || data?.meta.today || '';
  $('date-to').value = query.to || data?.meta.end || data?.meta.today || '';
  updateDateFields();
  $('dates').showModal();
});
$('period').addEventListener('change', updateDateFields);
$('date-from').addEventListener('change', updateDateFields);
$('date-form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('dates').close();
  updateQuery({ period: $('period').value, from: $('date-from').value, to: $('date-to').value });
});
$('quick-periods').addEventListener('click', (event) => {
  if (event.target.dataset.period) updateQuery({ period: event.target.dataset.period });
});

$('view-controls').addEventListener('click', (event) => {
  if (!event.target.dataset.view) return;
  view = event.target.dataset.view;
  saveSetting('view', view);
  updateControls();
  renderList();
});
$('search').addEventListener('input', renderList);
$('sort').addEventListener('change', () => updateQuery({ sort: $('sort').value }));
$('sort-direction').addEventListener('click', () => updateQuery({ order: query.order === 'desc' ? 'asc' : 'desc' }));
$('refresh').addEventListener('click', () => refresh(true));
window.addEventListener('popstate', () => {
  query = queryFromUrl();
  updateControls();
  refresh(true);
});

$('settings-trigger').addEventListener('click', () => $('settings').showModal());
$('auto-refresh').checked = autoRefresh;
$('hide-titles').checked = hideTitles;
$('auto-refresh').addEventListener('change', (event) => {
  autoRefresh = event.target.checked;
  saveSetting('autoRefresh', String(autoRefresh));
});
$('hide-titles').addEventListener('change', (event) => {
  hideTitles = event.target.checked;
  saveSetting('hideTitles', String(hideTitles));
  renderList();
  renderDetail();
});
for (const button of document.querySelectorAll('.close-dialog')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}

setInterval(() => {
  if (autoRefresh && !document.hidden) refresh();
}, 20000);
updateControls();
refresh();
