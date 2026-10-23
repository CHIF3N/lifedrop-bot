// LifeDrop Control dashboard. Plain JS + Chart.js, no build step. Server text always goes in via textContent.
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const BLOOD_TYPES = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];
let currentTab = 'overview';
let days = 30;
let lastStats = null; // kept so charts can be redrawn on theme change
let pendingBroadcast = null; // the request that "Send" will post
let pollTimer = null;
let openBroadcastId = null; // broadcast whose recipient list is shown
let shareLink = 'https://wa.me/237686001785?text=Hi';
let imageFile = null; // picked broadcast image (uploaded to WhatsApp only when sending)
let imageUrl = null; // local preview URL for it
const charts = {};

// ---------- Small helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'checked') node.checked = Boolean(v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

function icon(name, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const n = (v) => Number(v || 0);
const fmt = (v) => n(v).toLocaleString('en-GB');
const pct = (part, whole) => (n(whole) > 0 ? Math.round((n(part) / n(whole)) * 100) : 0);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtDate = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const fmtDay = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

function ago(v) {
  if (!v) return '';
  const mins = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

function minutesText(m) {
  if (m == null) return '–';
  const v = Number(m);
  if (v < 60) return `${Math.round(v)} min`;
  if (v < 48 * 60) return `${(v / 60).toFixed(1)} h`;
  return `${(v / 1440).toFixed(1)} days`;
}

const blood = (t) => (t ? el('span', { class: 'blood' }, t === 'UNKNOWN' ? '?' : t) : '');
const badge = (text, tone = '') => el('span', { class: `badge ${tone}` }, text);
const reveal = () => $('.reveal').checked;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 403 && path.startsWith('/admin/api') && data.error === 'Not logged in.') { showLogin(); throw new Error('Please sign in.'); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(text, isError = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = isError ? 'toast error' : 'toast';
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 5000);
}

// In-page confirm box. Native confirm() is blocked in some browsers (it silently returns false), so never use it.
// Only one question is open at a time: asking a new one answers the old one with "no".
let answerConfirm = null;
function finishConfirm(value) {
  const answer = answerConfirm;
  answerConfirm = null;
  if ($('#confirm-dialog').open) $('#confirm-dialog').close();
  if (answer) answer(value);
}
$('#confirm-ok').addEventListener('click', () => finishConfirm(true));
$('#confirm-cancel').addEventListener('click', () => finishConfirm(false));
// Esc key. The close event arrives late, so ignore it if a new question has already reopened the box.
$('#confirm-dialog').addEventListener('close', () => { if (!$('#confirm-dialog').open) finishConfirm(false); });

function askConfirm({ title, text, confirmLabel = 'Yes', tone = 'primary' }) {
  finishConfirm(false);
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = confirmLabel;
  $('#confirm-ok').className = `btn ${tone}`;
  return new Promise(resolve => {
    answerConfirm = resolve;
    $('#confirm-dialog').showModal();
    $('#confirm-cancel').focus(); // the safe choice has focus, so Enter never confirms by accident
  });
}

// columns: [header, row => value or Node]
function renderTable(table, rows, columns, emptyText = 'Nothing here yet.') {
  table.replaceChildren(
    el('thead', {}, el('tr', {}, columns.map(([h]) => el('th', {}, h)))),
    el('tbody', {}, rows.length
      ? rows.map(r => el('tr', {}, columns.map(([, f]) => el('td', {}, f(r) ?? ''))))
      : el('tr', {}, el('td', { colspan: columns.length, class: 'empty' }, emptyText)))
  );
}

const stack = (main, sub) => el('div', {}, el('div', { class: 'cell-main' }, main ?? ''), sub ? el('div', { class: 'cell-sub' }, sub) : null);

// ---------- Theme ----------
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
try { applyTheme(localStorage.getItem('ld-theme')); } catch (e) { /* storage blocked */ }

$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('ld-theme', next); } catch (e) { /* ignore */ }
  if (lastStats) renderOverview(lastStats);
});

// ---------- Login ----------
function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-key').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/admin/login', { method: 'POST', body: { key: $('#login-key').value } });
    $('#login-key').value = '';
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ---------- Navigation ----------
$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('button')?.dataset.tab;
  if (tab) openTab(tab);
});
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) openTab(go.dataset.goto);
});

function openTab(tab) {
  currentTab = tab;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== tab; });
  window.scrollTo({ top: 0 });
  loadTab(tab);
}

function loadTab(tab) {
  const loaders = {
    overview: loadStats,
    donors: () => loadList('donors'),
    requests: () => loadList('requests'),
    matches: () => loadList('matches'),
    facilities: () => loadList('facilities'),
    templates: () => loadTemplates(false),
    broadcast: loadBroadcastTab,
    log: loadLog
  };
  loaders[tab]().catch(err => toast(err.message, true));
}

// All "Show numbers" switches move together
$$('.reveal').forEach(box => box.addEventListener('change', () => {
  $$('.reveal').forEach(b => { b.checked = box.checked; });
  loadTab(currentTab);
}));

// ---------- Overview ----------
$('#period').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  days = Number(b.dataset.days);
  $$('#period button').forEach(x => x.classList.toggle('active', x === b));
  loadStats().catch(err => toast(err.message, true));
});
$('#stats-refresh').addEventListener('click', () => loadStats().catch(err => toast(err.message, true)));

async function loadStats() {
  $('#updated').textContent = 'Loading…';
  const data = await api(`/admin/api/stats?days=${days}`);
  lastStats = data;
  renderOverview(data);
}

const periodLabel = () => (days === 1 ? 'last 24h' : `last ${days} days`);

function setNavCount(id, value) {
  const node = $(id);
  node.textContent = value;
  node.hidden = !n(value);
}

function chartDefaults() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 12;
  Chart.defaults.font.weight = '600';
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--border');
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
  Chart.defaults.plugins.legend.labels.boxHeight = 8;
  Chart.defaults.plugins.tooltip.backgroundColor = css('--text');
  Chart.defaults.plugins.tooltip.titleColor = css('--bg');
  Chart.defaults.plugins.tooltip.bodyColor = css('--bg');
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 12;
  Chart.defaults.maintainAspectRatio = false;
}

function drawChart(key, canvas, config) {
  charts[key]?.destroy();
  charts[key] = new Chart(canvas, config);
}

// "#rrggbb" -> rgba
function alpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
}

function widthBar(cls, percent, color) {
  const bar = el('div', { class: cls });
  bar.style.width = `${percent}%`;
  if (color) bar.style.background = color;
  return bar;
}

function kpiCard({ label, value, sub, tone, iconName, sparkKey, sparkData, sparkColor, progress }) {
  const card = el('div', { class: `kpi tone-${tone}` },
    el('div', { class: 'kpi-top' }, el('span', {}, label), el('span', { class: 'kpi-icon' }, icon(iconName))),
    el('div', { class: 'kpi-value' }, value),
    el('div', { class: 'kpi-sub' }, sub));
  if (progress != null) card.append(el('div', { class: 'bar-track' }, widthBar('bar-fill', progress)));
  if (sparkData) {
    const canvas = el('canvas');
    card.append(el('div', { class: 'spark' }, canvas));
    requestAnimationFrame(() => drawChart(sparkKey, canvas, {
      type: 'line',
      data: { labels: sparkData.map((_, i) => i), datasets: [{ data: sparkData, borderColor: sparkColor, borderWidth: 3, cubicInterpolationMode: 'monotone', pointRadius: 0, fill: true, backgroundColor: alpha(sparkColor, .12) }] },
      options: { plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true } }, animation: false }
    }));
  }
  return card;
}

function renderOverview({ stats: s, totals: t, series, bloodTypes, openRequests, report }) {
  if (typeof Chart === 'undefined') { toast('Charts failed to load.', true); return; }
  chartDefaults();
  const d = s.donors;
  const m = s.matches;
  const col = { c1: css('--c1'), c2: css('--c2'), c3: css('--c3'), c4: css('--c4'), c5: css('--c5'), c6: css('--c6'), ok: css('--ok'), danger: css('--danger') };
  const lastN = (key) => series.slice(-Math.max(days, 7)).map(r => n(r[key]));

  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Africa/Douala', hour: '2-digit', hour12: false }));
  $('#greeting').textContent = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'} 👋 Here is how LifeDrop is doing`;
  $('#updated').textContent = `Live data · updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · ${periodLabel()}`;
  setNavCount('#nav-review', d.needs_review);
  setNavCount('#nav-open', t.requests_open);

  $('#kpis').replaceChildren(
    kpiCard({ label: 'Registered donors', value: fmt(d.total), sub: el('span', {}, el('b', {}, `+${fmt(d.new)}`), ` new · ${periodLabel()}`),
      tone: 'red', iconName: 'users', sparkKey: 'k1', sparkData: lastN('donors'), sparkColor: col.c1 }),
    kpiCard({ label: 'Ready to donate now', value: fmt(d.ready), sub: `${pct(d.ready, d.total)}% of donors can give today`,
      tone: 'green', iconName: 'drop', progress: pct(d.ready, d.total) }),
    kpiCard({ label: 'Open requests', value: fmt(t.requests_open), sub: `${fmt(t.requests_no_donor)} had no donor to contact`,
      tone: 'amber', iconName: 'alert', sparkKey: 'k3', sparkData: lastN('requests'), sparkColor: col.c4 }),
    kpiCard({ label: 'Confirmed donations', value: fmt(s.donations.confirmed), sub: `${fmt(t.donations_confirmed)} all time · ${periodLabel()}`,
      tone: 'blue', iconName: 'hospital', sparkKey: 'k4', sparkData: lastN('donations'), sparkColor: col.c2 })
  );

  const chip = (label, value, onclick) => el('span', { class: onclick ? 'chip clickable' : 'chip', onclick }, label, el('b', {}, value));
  const goReview = () => { document.querySelector('[data-list="donors"] [name="status"]').value = 'needs_review'; openTab('donors'); };
  $('#mini-stats').replaceChildren(
    chip('Needs review', fmt(d.needs_review), n(d.needs_review) ? goReview : null),
    chip('Resting', fmt(d.resting)),
    chip('Short wait', fmt(d.waiting)),
    chip('Not eligible', fmt(d.not_eligible)),
    chip('Reply rate', `${pct(n(m.contacted) - n(m.no_reply), m.contacted)}%`),
    chip('Yes rate', `${pct(m.yes, m.contacted)}%`),
    chip('Time to a yes', minutesText(m.median_minutes_to_yes)),
    chip('Time to fulfil', minutesText(s.requests.median_minutes_to_fulfil)),
    chip('Partner hospitals', fmt(s.facilities.partners)),
    chip('Opted out of news', fmt(t.donors_opted_out))
  );

  // Activity per day
  const labels = series.map(r => new Date(`${r.day}T12:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }));
  const line = (label, key, color, fill = false) => ({
    label, data: series.map(r => n(r[key])), borderColor: color, backgroundColor: fill ? alpha(color, .12) : color,
    borderWidth: 3, cubicInterpolationMode: 'monotone', pointRadius: 0, pointHoverRadius: 5, fill
  });
  drawChart('activity', $('#chart-activity'), {
    type: 'line',
    data: { labels, datasets: [line('New donors', 'donors', col.c1, true), line('Requests', 'requests', col.c4), line('Yes replies', 'yes', col.c3), line('Donations', 'donations', col.c2)] },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'end' } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });

  // Donor readiness doughnut, total in the middle
  const statusParts = [
    ['Ready', d.ready, col.ok], ['Resting', d.resting, col.c2], ['Short wait', d.waiting, col.c4],
    ['Needs review', d.needs_review, col.c5], ['Paused', d.paused, col.c6], ['Not eligible', d.not_eligible, col.danger]
  ];
  const centerText = {
    id: 'center',
    afterDraw(chart) {
      const { ctx, chartArea: a } = chart;
      const x = (a.left + a.right) / 2;
      const y = (a.top + a.bottom) / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = css('--text');
      ctx.font = `600 30px "Clash Display", ${Chart.defaults.font.family}`;
      ctx.fillText(fmt(d.total), x, y + 4);
      ctx.fillStyle = css('--muted');
      ctx.font = `600 11px ${Chart.defaults.font.family}`;
      ctx.fillText('DONORS', x, y + 22);
      ctx.restore();
    }
  };
  drawChart('status', $('#chart-status'), {
    type: 'doughnut',
    data: { labels: statusParts.map(p => p[0]), datasets: [{ data: statusParts.map(p => n(p[1])), backgroundColor: statusParts.map(p => p[2]), borderColor: css('--surface'), borderWidth: 4, borderRadius: 6 }] },
    options: { cutout: '70%', plugins: { legend: { position: 'bottom' } } },
    plugins: [centerText]
  });

  // Blood supply vs demand
  const ready = Object.fromEntries((s.readyByType || []).map(x => [x.blood_type, n(x.count)]));
  const demand = Object.fromEntries((s.demandByType || []).map(x => [x.blood_type_needed, n(x.units)]));
  const all = Object.fromEntries((bloodTypes || []).map(x => [x.blood_type, n(x.count)]));
  const short = BLOOD_TYPES.filter(g => (demand[g] || 0) > (ready[g] || 0));
  $('#supply-note').textContent = short.length ? `⚠ short on ${short.join(', ')}` : `requests: ${periodLabel()}`;
  const bars = (label, data, color) => ({ label, data, backgroundColor: color, borderRadius: 8, borderSkipped: false, maxBarThickness: 26 });
  drawChart('blood', $('#chart-blood'), {
    type: 'bar',
    data: {
      labels: BLOOD_TYPES,
      datasets: [
        bars('All donors', BLOOD_TYPES.map(g => all[g] || 0), alpha(col.c6, .35)),
        bars('Ready now', BLOOD_TYPES.map(g => ready[g] || 0), col.c3),
        bars(`Units requested (${periodLabel()})`, BLOOD_TYPES.map(g => demand[g] || 0), col.c1)
      ]
    },
    options: { plugins: { legend: { position: 'top', align: 'end' } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } }
  });

  // Donors by town (stacked: ready + not ready)
  const cities = (s.donorsByCity || []).filter(c => c.city);
  drawChart('cities', $('#chart-cities'), {
    type: 'bar',
    data: {
      labels: cities.map(c => c.city.replace(/\b\w/g, ch => ch.toUpperCase())),
      datasets: [
        { label: 'Ready', data: cities.map(c => n(c.ready)), backgroundColor: col.c3, borderRadius: 8, borderSkipped: false, maxBarThickness: 24 },
        { label: 'Not ready yet', data: cities.map(c => n(c.count) - n(c.ready)), backgroundColor: alpha(col.c6, .4), borderRadius: 8, borderSkipped: false, maxBarThickness: 24 }
      ]
    },
    options: { indexAxis: 'y', plugins: { legend: { position: 'top', align: 'end' } }, scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true, grid: { display: false } } } }
  });

  // Reply funnel for the period
  const steps = [
    ['Donors contacted', n(m.contacted), col.c6],
    ['Replied', n(m.contacted) - n(m.no_reply), col.c2],
    ['Said yes', n(m.yes), col.c3],
    ['Donation confirmed', n(s.donations.confirmed), col.c1]
  ];
  const top = Math.max(steps[0][1], 1);
  $('#funnel').replaceChildren(
    ...steps.map(([label, value, color]) => el('div', { class: 'funnel-row' },
      el('div', { class: 'funnel-label' }, el('span', {}, label), el('span', {}, `${fmt(value)} · ${pct(value, steps[0][1])}%`)),
      el('div', { class: 'funnel-bar' }, widthBar('', Math.max((value / top) * 100, value ? 3 : 0), color)))),
  );
  $('#funnel-note').textContent = periodLabel();

  // Open requests
  $('#open-requests').replaceChildren(...(openRequests.length ? openRequests.map(r => el('div', { class: 'req' },
    blood(r.blood_type_needed),
    el('div', {},
      el('div', { class: 'req-place' }, `${r.location || 'Unknown place'} · ${r.units_needed || 1} unit(s)`),
      el('div', { class: 'req-meta' }, `#${r.id} · ${ago(r.created_at)} · ${r.contacted} contacted · ${r.yes} yes`)),
    badge(r.urgency || '–', URGENCY[r.urgency] || ''))) : [el('p', { class: 'empty-note' }, 'No open requests.')]));

  $('#stats-report').textContent = report.join('\n\n────────\n\n');
}

// ---------- Lists ----------
$$('form.toolbar').forEach(form => {
  form.addEventListener('submit', (e) => { e.preventDefault(); loadList(form.dataset.list).catch(err => toast(err.message, true)); });
});
for (const sel of $$('select.blood-types')) for (const t of BLOOD_TYPES) sel.append(el('option', { value: t }, t));

function filterQuery(list) {
  const params = new URLSearchParams(new FormData(document.querySelector(`form[data-list="${list}"]`)));
  for (const [k, v] of [...params]) if (!v) params.delete(k);
  if (reveal()) params.set('reveal', '1');
  return params.toString();
}

const DONOR_STATUS = {
  eligible: ['Eligible', 'ok'], needs_review: ['Needs review', 'warn'], needs_update: ['Needs update', 'info'],
  on_hold: ['On hold', 'info'], not_eligible: ['Not eligible', 'danger']
};
const REPLY = { yes: ['Yes', 'ok'], no: ['No', 'danger'], no_reply: ['No reply', ''], not_needed: ['Not needed', 'info'] };
const URGENCY = { Emergency: 'danger', Urgent: 'warn', Routine: 'info' };

async function reviewDonor(id, decision, name) {
  const approve = decision === 'approve';
  const yes = await askConfirm({
    title: approve ? `Approve ${name || 'this donor'}?` : `Reject ${name || 'this donor'}?`,
    text: approve ? 'They become eligible and can be matched to blood requests.' : 'They will be marked not eligible and will not be matched.',
    confirmLabel: approve ? 'Approve donor' : 'Reject donor',
    tone: approve ? 'success' : 'danger'
  });
  if (!yes) return;
  try {
    await api(`/admin/api/donors/${id}/review`, { method: 'POST', body: { decision } });
    toast(decision === 'approve' ? 'Donor approved.' : 'Donor rejected.');
    loadList('donors');
  } catch (err) { toast(err.message, true); }
}

async function toggleFacility(id, flag, value) {
  try {
    await api(`/admin/api/facilities/${id}`, { method: 'PATCH', body: { [flag]: value } });
    toast('Saved.');
  } catch (err) {
    toast(err.message, true);
    loadList('facilities');
  }
}

const switchCell = (r, flag) => el('label', { class: 'switch' },
  el('input', { type: 'checkbox', checked: r[flag], onchange: (e) => toggleFacility(r.id, flag, e.target.checked) }), el('span'));

const COLUMNS = {
  donors: [
    ['Donor', r => el('button', { class: 'name-link', onclick: () => openDonor(r.id) }, stack(r.name || 'No name', `#${r.id} · joined ${fmtDay(r.created_at)}`))],
    ['Phone', r => el('span', { class: 'mono' }, r.phone)],
    ['Blood', r => blood(r.blood_type)],
    ['Town', r => r.city],
    ['Status', r => { const [t, tone] = DONOR_STATUS[r.eligibility_status] || [r.eligibility_status || '–', '']; return badge(t, tone); }],
    ['Screening notes', r => (r.screening_reasons ? el('span', { class: 'cell-sub' }, r.screening_reasons) : '')],
    ['Last donation', r => fmtDay(r.last_donation_date)],
    ['Last message', r => ago(r.last_inbound_at)],
    ['Review', r => (r.eligibility_status === 'needs_review'
      ? el('span', { class: 'actions' },
        el('button', { class: 'btn sm ok-outline', onclick: () => reviewDonor(r.id, 'approve', r.name) }, 'Approve'),
        el('button', { class: 'btn sm danger-outline', onclick: () => reviewDonor(r.id, 'reject', r.name) }, 'Reject'))
      : (r.broadcast_opt_out ? badge('No news', '') : ''))]
  ],
  requests: [
    ['Request', r => stack(`#${r.id}`, fmtDate(r.created_at))],
    ['Blood', r => blood(r.blood_type_needed)],
    ['Units', r => r.units_needed],
    ['Urgency', r => badge(r.urgency || '–', URGENCY[r.urgency] || '')],
    ['Status', r => { const [t, tone] = REQUEST_STATUS[r.status] || [r.status, '']; return badge(t, tone); }],
    ['Place', r => stack(r.location, r.facility_name || r.hospital_name)],
    ['Donors', r => el('button', { class: 'link', onclick: () => showMatchesFor('request_id', r.id) }, `${r.contacted} contacted · ${r.yes} yes`)],
    ['Requester', r => el('span', { class: 'mono' }, r.requester_phone)],
    ['Contact', r => stack(r.contact_name, r.contact_phone)],
    ['Actions', r => (r.status === 'open'
      ? el('span', { class: 'actions' },
        el('button', { class: 'btn sm ok-outline', onclick: () => setRequestStatus(r, 'fulfilled') }, 'Fulfilled'),
        el('button', { class: 'btn sm', onclick: () => setRequestStatus(r, 'closed') }, 'Close'))
      : el('button', { class: 'btn sm', onclick: () => setRequestStatus(r, 'open') }, 'Reopen'))]
  ],
  matches: [
    ['Match', r => stack(`#${r.id}`, `request #${r.request_id}`)],
    ['Donor', r => el('button', { class: 'name-link', onclick: () => openDonor(r.donor_id) }, stack(r.donor_name || `#${r.donor_id}`, r.phone))],
    ['Blood', r => blood(r.blood_type_needed)],
    ['Place', r => r.location],
    ['Reply', r => { const [t, tone] = REPLY[r.response] || [r.response, '']; return badge(t, tone); }],
    ['Contacted', r => fmtDate(r.contacted_at)],
    ['Replied', r => fmtDate(r.responded_at)],
    ['Code', r => (r.confirm_code ? el('span', { class: 'mono' }, r.confirm_code) : '')],
    ['Donation', r => (r.donation_confirmed_at ? badge(r.confirmed_by_facility ? 'By hospital' : 'Self-reported', r.confirmed_by_facility ? 'ok' : 'info') : '')]
  ],
  facilities: [
    ['Facility', r => stack(`${r.name}${r.is_demo ? ' (demo)' : ''}`, `#${r.id} · ${String(r.type).replace('_', ' ')}`)],
    ['Town', r => r.city],
    ['Staff phone', r => el('span', { class: 'mono' }, r.staff_phone || '–')],
    ['Partner', r => switchCell(r, 'is_partner')],
    ['Collects blood', r => switchCell(r, 'does_blood_collection')],
    ['Lab tests', r => switchCell(r, 'does_lab_tests')],
    ['Added', r => fmtDay(r.created_at)]
  ]
};

const REQUEST_STATUS = { open: ['Open', 'warn'], fulfilled: ['Fulfilled', 'ok'], closed: ['Closed', ''] };

async function setRequestStatus(r, status) {
  const text = {
    fulfilled: ['Mark as fulfilled?', 'Use this when the patient got the blood they needed.', 'Mark fulfilled', 'success'],
    closed: ['Close this request?', 'Use this when blood is no longer needed (cancelled, duplicate or a test).', 'Close request', 'danger'],
    open: ['Reopen this request?', 'It will show as open again on the overview.', 'Reopen', 'primary']
  }[status];
  const yes = await askConfirm({ title: `Request #${r.id}: ${text[0]}`, text: text[1], confirmLabel: text[2], tone: text[3] });
  if (!yes) return;
  try {
    await api(`/admin/api/requests/${r.id}/status`, { method: 'POST', body: { status } });
    toast(`Request #${r.id} is now ${REQUEST_STATUS[status][0].toLowerCase()}.`);
    loadList('requests');
  } catch (err) { toast(err.message, true); }
}

function showMatchesFor(field, id) {
  const form = document.querySelector('form[data-list="matches"]');
  form.reset();
  form.elements[field].value = id;
  openTab('matches');
}

// CSV download with the current filters
$$('[data-export]').forEach(b => b.addEventListener('click', () => {
  window.location.href = `/admin/api/export/${b.dataset.export}.csv?${filterQuery(b.dataset.export)}`;
}));

// ---------- Donor profile ----------
$('#drawer-close').addEventListener('click', () => $('#donor-drawer').close());
$('#donor-drawer').addEventListener('click', (e) => { if (e.target === $('#donor-drawer')) $('#donor-drawer').close(); }); // click outside

async function openDonor(id) {
  if (!id) return;
  let data;
  try {
    data = await api(`/admin/api/donors/${id}${reveal() ? '?reveal=1' : ''}`);
  } catch (err) { toast(err.message, true); return; }
  const { donor: d, matches, appointments, broadcastsReceived } = data;
  const [statusText, statusTone] = DONOR_STATUS[d.eligibility_status] || [d.eligibility_status || '–', ''];
  $('#drawer-title').replaceChildren(el('div', { class: 'who' }, blood(d.blood_type || '?'),
    el('div', {}, el('h2', {}, d.name || 'No name'), el('div', { class: 'cell-sub' }, `Donor #${d.id} · ${d.phone}`))));
  const fact = (label, value) => el('div', { class: 'fact' }, el('span', {}, label), el('b', {}, value || '–'));
  const donated = matches.filter(m => m.donation_confirmed_at).length;
  const body = [
    el('div', {}, badge(statusText, statusTone), ' ', d.broadcast_opt_out ? badge('No news (STOP)', '') : ''),
    d.screening_reasons ? el('p', { class: 'warn' }, `Screening notes: ${d.screening_reasons}`) : null,
    d.eligibility_status === 'needs_review' ? el('div', { class: 'drawer-actions' },
      el('button', { class: 'btn success', onclick: async () => { await reviewDonor(d.id, 'approve', d.name); openDonor(d.id); } }, 'Approve'),
      el('button', { class: 'btn danger', onclick: async () => { await reviewDonor(d.id, 'reject', d.name); openDonor(d.id); } }, 'Reject')) : null,
    el('div', { class: 'facts' },
      fact('Town', d.place),
      fact('Gender / age', [d.gender, d.age].filter(Boolean).join(' · ')),
      fact('Joined', fmtDay(d.created_at)),
      fact('Last message', ago(d.last_inbound_at)),
      fact('Last donation', fmtDay(d.last_donation_date)),
      fact('Can give again', d.deferred_until ? fmtDay(d.deferred_until) : 'Now / unknown'),
      fact('Verified', d.verified_at ? `${fmtDay(d.verified_at)}${d.verified_by ? ` · ${d.verified_by}` : ''}` : 'No'),
      fact('Location pin', d.has_pin ? 'Shared' : 'Not shared'),
      fact('Times contacted', String(matches.length)),
      fact('Confirmed donations', String(donated)),
      fact('Said yes', String(matches.filter(m => m.response === 'yes').length)),
      fact('Broadcasts received', String(broadcastsReceived))),
    el('h2', {}, 'Request history'),
    el('div', { class: 'timeline' }, matches.length ? matches.map(m => {
      const [t, tone] = REPLY[m.response] || [m.response, ''];
      return el('div', { class: 'tl-item' }, blood(m.blood_type_needed),
        el('div', {}, el('div', { class: 'cell-main' }, `Request #${m.request_id} · ${m.location || ''}`),
          el('div', { class: 'cell-sub' }, `${fmtDate(m.contacted_at)}${m.donation_confirmed_at ? ` · donated ${fmtDay(m.donation_confirmed_at)}` : ''}${m.confirm_code ? ` · ${m.confirm_code}` : ''}`)),
        badge(m.donation_confirmed_at ? 'Donated' : t, m.donation_confirmed_at ? 'ok' : tone));
    }) : el('p', { class: 'empty-note' }, 'Not contacted for any request yet.')),
    appointments.length ? el('h2', {}, 'Lab bookings') : null,
    appointments.length ? el('div', { class: 'timeline' }, appointments.map(a => el('div', { class: 'tl-item' }, el('span'),
      el('div', {}, el('div', { class: 'cell-main' }, a.facility_name), el('div', { class: 'cell-sub' }, fmtDate(a.slot_at))), badge(a.status, a.status === 'booked' ? 'info' : '')))) : null
  ];
  $('#drawer-body').replaceChildren(...body.filter(Boolean));
  if (!$('#donor-drawer').open) $('#donor-drawer').showModal();
}

// ---------- Activity log ----------
const ACTION_TEXT = {
  donor_approved: ['Donor approved', 'ok'], donor_rejected: ['Donor rejected', 'danger'],
  facility_added: ['Hospital/lab added', 'info'], facility_updated: ['Hospital/lab changed', 'info'],
  request_fulfilled: ['Request fulfilled', 'ok'], request_closed: ['Request closed', ''], request_open: ['Request reopened', 'warn'],
  broadcast_sent: ['Broadcast sent', 'warn']
};

function describeLog(r) {
  const det = r.details || {};
  if (r.target_type === 'donor') return el('button', { class: 'link', onclick: () => openDonor(r.target_id) }, `${r.target_name || 'Donor'} (#${r.target_id})`);
  if (r.target_type === 'facility') {
    const flags = Object.entries(det).filter(([k]) => k.startsWith('is_') || k.startsWith('does_')).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v ? 'on' : 'off'}`);
    return `${r.target_name || 'Facility'} (#${r.target_id})${flags.length ? ` · ${flags.join(', ')}` : det.city ? ` · ${det.city}` : ''}`;
  }
  if (r.target_type === 'request') return `Request #${r.target_id}`;
  if (r.target_type === 'broadcast') return `Broadcast #${r.target_id} · ${det.audience || ''} · ${det.total || 0} donor(s)`;
  return '';
}

async function loadLog() {
  const { rows } = await api('/admin/api/log');
  renderTable($('#table-log'), rows, [
    ['When', r => stack(ago(r.created_at), fmtDate(r.created_at))],
    ['What', r => { const [t, tone] = ACTION_TEXT[r.action] || [r.action, '']; return badge(t, tone); }],
    ['Details', r => describeLog(r)]
  ], 'Nothing changed from the dashboard yet.');
}

// Overview refreshes itself every minute while it is on screen
setInterval(() => {
  if (currentTab === 'overview' && !$('#app').hidden && document.visibilityState === 'visible' && !$('#confirm-dialog').open) {
    loadStats().catch(() => {});
  }
}, 60000);

async function loadList(list) {
  const { rows } = await api(`/admin/api/${list}?${filterQuery(list)}`);
  renderTable($(`#table-${list}`), rows, COLUMNS[list]);
}

$('#facility-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements; // form.name is the form's own name, so read fields via .elements
  try {
    const { facility, knownTown } = await api('/admin/api/facilities', {
      method: 'POST',
      body: {
        name: f.name.value, city: f.city.value, staff_phone: f.staff_phone.value, type: f.type.value,
        is_partner: f.is_partner.checked, does_blood_collection: f.does_blood_collection.checked, does_lab_tests: f.does_lab_tests.checked
      }
    });
    toast(`${facility.name} registered (ID ${facility.id}).${knownTown ? '' : ' ⚠️ Unknown town: requests will only match this exact name.'}`, !knownTown);
    e.target.reset();
    loadList('facilities');
  } catch (err) { toast(err.message, true); }
});

$('#facility-form').elements.type.addEventListener('change', (e) => {
  const lab = e.target.value === 'lab';
  e.target.form.elements.does_lab_tests.checked = lab;
  e.target.form.elements.does_blood_collection.checked = !lab;
});

// ---------- Templates ----------
$('#templates-refresh').addEventListener('click', () => loadTemplates(true).catch(err => toast(err.message, true)));

const TEMPLATE_STATUS = {
  APPROVED: ['Approved', 'ok'], PENDING: ['In review', 'warn'], REJECTED: ['Rejected', 'danger'],
  MISSING: ['Not submitted', 'danger'], PAUSED: ['Paused', 'warn'], DISABLED: ['Disabled', 'danger']
};

function summaryCard(label, value, tone, iconName) {
  return el('div', { class: `kpi tone-${tone}` },
    el('div', { class: 'kpi-top' }, el('span', {}, label), el('span', { class: 'kpi-icon' }, icon(iconName))),
    el('div', { class: 'kpi-value' }, value));
}

async function loadTemplates(refresh) {
  const table = $('#table-templates');
  try {
    const data = await api(`/admin/api/templates${refresh ? '?refresh=1' : ''}`);
    if (!data.configured) {
      $('#template-summary').replaceChildren();
      renderTable(table, [], [['Status', () => '']], 'Add WABA_ID on Render to see template status.');
      return;
    }
    const used = data.rows.filter(r => !r.extra);
    const count = (st) => used.filter(r => st.includes(r.status)).length;
    $('#template-summary').replaceChildren(
      summaryCard('Approved', count(['APPROVED']), 'green', 'file'),
      summaryCard('In review', count(['PENDING']), 'amber', 'refresh'),
      summaryCard('Not submitted', count(['MISSING']), 'red', 'alert'),
      summaryCard('Rejected / paused', count(['REJECTED', 'PAUSED', 'DISABLED']), 'blue', 'alert')
    );
    renderTable(table, data.rows, [
      ['Template', r => el('span', { class: 'mono' }, r.name)],
      ['Category', r => r.category],
      ['Status', r => { const [t, tone] = TEMPLATE_STATUS[r.status] || [r.status, '']; return badge(t, tone); }],
      ['Note', r => (r.extra ? el('span', { class: 'cell-sub' }, 'In WhatsApp Manager, not used by the bot') : '')]
    ]);
  } catch (err) {
    renderTable(table, [], [['Status', () => '']], err.message);
  }
}

// ---------- Broadcast ----------
const bForm = $('#broadcast-form');

bForm.message.addEventListener('input', () => { $('#msg-count').textContent = bForm.message.value.length; hidePreview(); });
bForm.audience.addEventListener('change', () => {
  $('#aud-blood').hidden = bForm.audience.value !== 'blood_type';
  $('#aud-city').hidden = bForm.audience.value !== 'city';
  hidePreview();
});
for (const name of ['blood_type', 'city', 'window_only']) bForm[name].addEventListener('change', hidePreview);

$('#add-share-link').addEventListener('click', () => {
  const msg = bForm.message;
  if (!msg.value.includes(shareLink)) msg.value = `${msg.value.trimEnd()}${msg.value.trim() ? '\n\n' : ''}Join LifeDrop: ${shareLink}`.slice(0, 700);
  msg.dispatchEvent(new Event('input'));
});

function setImage(file) {
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageFile = file || null;
  imageUrl = imageFile ? URL.createObjectURL(imageFile) : null;
  $('#image-chosen').hidden = !imageFile;
  if (imageFile) {
    $('#image-thumb').src = imageUrl;
    $('#image-name').textContent = imageFile.name;
    $('#image-size').textContent = `${(imageFile.size / 1024 / 1024).toFixed(2)} MB`;
  } else {
    bForm.image.value = '';
  }
  hidePreview();
}

bForm.image.addEventListener('change', () => {
  const file = bForm.image.files[0];
  if (!file) return setImage(null);
  if (!['image/jpeg', 'image/png'].includes(file.type)) { toast('Pick a JPG or PNG image.', true); return setImage(null); }
  if (file.size > 5 * 1024 * 1024) { toast('Image is too big (max 5 MB).', true); return setImage(null); }
  setImage(file);
});
$('#image-remove').addEventListener('click', () => setImage(null));

function hidePreview() {
  pendingBroadcast = null;
  $('#broadcast-preview').hidden = true;
  $('#preview-empty').hidden = false;
}

function audienceFromForm() {
  const type = bForm.audience.value;
  return {
    type,
    value: type === 'blood_type' ? bForm.blood_type.value : type === 'city' ? bForm.city.value.trim() : undefined,
    window_only: bForm.window_only.checked
  };
}

async function loadBroadcastTab() {
  const opts = await api('/admin/api/audience-options');
  const sel = bForm.blood_type;
  const keep = sel.value;
  sel.replaceChildren(...opts.bloodTypes.map(t => el('option', { value: t.value }, `${t.value} (${t.count})`)));
  if (keep) sel.value = keep;
  $('#city-list').replaceChildren(...opts.cities.map(c => el('option', { value: c.value }, `${c.count} donors`)));
  await loadBroadcasts();
}

bForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { message: bForm.message.value, audience: audienceFromForm() };
  try {
    const p = await api('/admin/api/broadcasts/preview', { method: 'POST', body: { ...body, with_image: Boolean(imageFile) } });
    pendingBroadcast = { ...body, expected_count: p.total };
    const time = p.secondsEstimate > 90 ? `about ${Math.ceil(p.secondsEstimate / 60)} min` : `about ${p.secondsEstimate} s`;
    $('#preview-total').textContent = fmt(p.total);
    $('#preview-summary').textContent = `${p.audience}: ${p.inWindow} get ${imageFile ? 'an image message' : 'a normal message'}, ${p.viaTemplate} get the template. Sending takes ${time}.`;
    let warning = '';
    if (p.total === 0) warning = 'No donors match. Nothing will be sent.';
    else if (p.viaTemplate > 0 && p.templateStatus !== 'APPROVED') {
      const st = p.templateStatus === 'UNKNOWN' ? 'not checked (WABA_ID missing?)' : (TEMPLATE_STATUS[p.templateStatus]?.[0] || p.templateStatus).toLowerCase();
      warning = `Template ${p.templateName} is ${st}. The ${p.viaTemplate} donor(s) outside the 24h window will fail. Tick "Only donors who messaged the bot in the last 24 hours" to skip them.`;
    }
    $('#preview-warning').textContent = warning;
    $('#preview-warning').hidden = !warning;
    $('#preview-text').textContent = p.sampleText;
    $('#preview-template').textContent = p.sampleTemplate;
    for (const img of $$('#broadcast-preview .bubble-img')) {
      img.hidden = !imageUrl;
      if (imageUrl) img.src = imageUrl;
    }
    $('#preview-text-meta').textContent = `${imageFile ? 'Image message' : 'Normal message'} · donors active in last 24h`;
    $('#preview-template-meta').textContent = `Template ${p.templateName} · everyone else`;
    $('#confirm-check').checked = false;
    $('#broadcast-send').disabled = true;
    $('#broadcast-send').textContent = `Send to ${fmt(p.total)} donor(s)`;
    $('#preview-empty').hidden = true;
    $('#broadcast-preview').hidden = false;
  } catch (err) { toast(err.message, true); }
});

$('#confirm-check').addEventListener('change', (e) => {
  $('#broadcast-send').disabled = !e.target.checked || !pendingBroadcast?.expected_count;
});
$('#broadcast-cancel').addEventListener('click', hidePreview);

$('#broadcast-send').addEventListener('click', async () => {
  if (!pendingBroadcast) return;
  const yes = await askConfirm({
    title: `Send to ${pendingBroadcast.expected_count} donor(s)?`,
    text: 'This goes out on WhatsApp right away and cannot be undone.',
    confirmLabel: 'Send now',
    tone: 'danger'
  });
  if (!yes) return;
  $('#broadcast-send').disabled = true;
  try {
    let image = null;
    if (imageFile) {
      toast('Uploading the image to WhatsApp…');
      const res = await fetch('/admin/api/broadcast-image', {
        method: 'POST',
        headers: { 'Content-Type': imageFile.type, 'X-File-Name': imageFile.name.replace(/[^\w.\- ]/g, '_').slice(0, 80) },
        body: imageFile
      });
      const up = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(up.error || `Image upload failed (${res.status})`);
      image = { media_id: up.mediaId, name: up.name };
    }
    const { id, total } = await api('/admin/api/broadcasts', { method: 'POST', body: { ...pendingBroadcast, image, confirm: true } });
    toast(`Broadcast #${id} started: sending to ${total} donor(s).`);
    hidePreview();
    bForm.reset();
    setImage(null);
    bForm.audience.dispatchEvent(new Event('change')); // hide the town / blood type boxes again
    $('#msg-count').textContent = '0';
    openBroadcastId = id;
    await loadBroadcasts();
  } catch (err) {
    toast(err.message, true);
    $('#broadcast-send').disabled = false;
  }
});

const BROADCAST_STATUS = { sending: ['Sending', 'warn'], done: ['Done', 'ok'], interrupted: ['Interrupted', 'danger'] };

async function loadBroadcasts() {
  const { rows } = await api('/admin/api/broadcasts');
  renderTable($('#table-broadcasts'), rows, [
    ['#', r => r.id],
    ['When', r => fmtDate(r.created_at)],
    ['Audience', r => r.audience?.label || ''],
    ['Message', r => el('span', { class: 'cell-sub' }, `${r.image_name ? '🖼 ' : ''}${r.message.length > 90 ? `${r.message.slice(0, 90)}…` : r.message}`)],
    ['Status', r => { const [t, tone] = BROADCAST_STATUS[r.status] || [r.status, '']; return badge(t, tone); }],
    ['Sent', r => `${r.sent} / ${r.total}`],
    ['Failed', r => (n(r.failed) ? badge(String(r.failed), 'danger') : '0')],
    ['', r => el('button', { class: 'btn sm', onclick: () => showBroadcast(r.id) }, 'Details')]
  ], 'No broadcasts yet.');
  if (openBroadcastId) await showBroadcast(openBroadcastId);
  clearTimeout(pollTimer);
  if (rows.some(r => r.status === 'sending') && currentTab === 'broadcast') pollTimer = setTimeout(() => loadBroadcasts().catch(() => {}), 3000);
}

async function showBroadcast(id) {
  openBroadcastId = id;
  const { broadcast: b, recipients } = await api(`/admin/api/broadcasts/${id}?${reveal() ? 'reveal=1' : ''}`);
  $('#broadcast-detail').hidden = false;
  $('#broadcast-detail-title').textContent = `Broadcast #${b.id} · ${(BROADCAST_STATUS[b.status] || [b.status])[0]}`;
  renderTable($('#table-broadcast-recipients'), recipients, [
    ['Donor', r => r.name],
    ['Phone', r => el('span', { class: 'mono' }, r.phone)],
    ['Sent as', r => ({ text: 'Normal message', template: 'Template', image: 'Image message', image_template: 'Image template' }[r.channel] || r.channel)],
    ['Result', r => (r.status === 'sent' ? badge('Sent', 'ok') : badge('Failed', 'danger'))],
    ['Error', r => (r.error ? el('span', { class: 'cell-sub' }, r.error) : '')],
    ['Time', r => fmtDate(r.sent_at)]
  ], 'Sending has not started yet.');
}

// ---------- Start ----------
async function start() {
  let me;
  try {
    me = await api('/admin/api/me');
  } catch (err) {
    return; // showLogin() already ran
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#local-banner').hidden = me.allowSend !== false;
  if (me.shareLink) shareLink = me.shareLink;
  $('#conn-text').textContent = me.allowSend === false ? 'Live database · local' : 'Live database';
  openTab(currentTab);
}

start();
