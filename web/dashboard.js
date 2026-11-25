const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('zh-CN');
const periods = ['today', '7d', 'week', 'month', '30d', 'all', 'custom'];
const sorts = ['updated', 'tokens', 'cache_rate', 'input', 'output', 'turns'];
const homeZone = 'Asia/Shanghai';
const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const mobile = matchMedia('(max-width: 850px)');
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

function chart(container, items, expanded = false) {
  if (!items.length) {
    container.replaceChildren();
    return;
  }
  const width = 500;
  const height = 148;
  const rawTotals = items.map((item) => item.total);
  const grand = rawTotals.reduce((sum, value) => sum + value, 0);
  const max = Math.max(1, grand);
  const startTime = items[0].time;
  const elapsed = items.at(-1).time - startTime;
  let running = 0;
  const points = rawTotals.map((value, i) => {
    running += value;
    const fraction = elapsed > 0 ? (items[i].time - startTime) / elapsed : (i + 1) / rawTotals.length;
    return [fraction * width, height - (running / max) * (height - 7)];
  });
  const line = 'M0 ' + height + points.map(([x, y]) => ` L${x.toFixed(2)} ${y.toFixed(2)}`).join('');
  const grid = expanded ? [5, 52, 100, height].map((y) => `M0 ${y}H${width}`).join(' ') : '';
  const bars = expanded ? points.map(([x], i) => {
    const size = Math.max(1, Math.min(9, width / rawTotals.length / 2));
    const h = (rawTotals[i] / max) * (height - 7);
    return `<rect x="${Math.max(0, Math.min(width - size, x - size / 2))}" y="${height - h}" width="${size}" height="${h}" fill="currentColor" opacity=".24"/>`;
  }).join('') : '';
  const gradient = expanded ? 'detail-fill' : 'overview-fill';
  const stroke = expanded ? 'currentColor' : 'url(#overview-stroke)';
  const rainbow = expanded ? '' : `<linearGradient id="overview-stroke" gradientUnits="userSpaceOnUse" x1="0" x2="${width}">
    <stop offset="0%" stop-color="var(--arc-blue)"/><stop offset="35%" stop-color="var(--arc-green)"/>
    <stop offset="69%" stop-color="var(--arc-gold)"/><stop offset="100%" stop-color="var(--arc-coral)"/>
  </linearGradient>`;
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs>${rainbow}<linearGradient id="${gradient}" x2="0%" y2="100%"><stop offset="0%" stop-color="currentColor" stop-opacity=".17"/><stop offset="100%" stop-color="currentColor" stop-opacity=".015"/></linearGradient></defs>
    <path d="${grid}" stroke="#e0e6f3" fill="none" vector-effect="non-scaling-stroke"/>
    <path d="${line} V${height}H0Z" fill="url(#${gradient})"/>${bars}
    <path d="${line}" fill="none" stroke="${stroke}" stroke-width="${expanded ? 2 : 2.35}" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

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
  const marks = timeline.filter((bucket) => bucket.output).slice(-7);
  const maxOutput = Math.max(1, ...marks.map((bucket) => bucket.output));
  $('output-chart').replaceChildren(...marks.map((bucket) => {
    const bar = node('i');
    bar.style.setProperty('--size', `${Math.max(9, bucket.output / maxOutput * 100)}%`);
    return bar;
  }));

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
  trendHead.append(trend.firstElementChild, node('span', '', '累计用量 / 单次请求'));
  const graph = node('div', 'detail-chart');
  graph.setAttribute('role', 'img');
  graph.setAttribute('aria-label', `累计用量从 0 增至 ${number.format(details.total)} tokens`);
  chart(graph, details.events, true);
  const axis = node('div', 'axis-labels');
  axis.append(node('span', '', started), node('span', '', updated));
  trend.append(trendHead, graph, axis);
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
