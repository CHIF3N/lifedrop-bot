// LifeDrop admin dashboard. Plain JS, no build step. All text from the server goes in via textContent.
const $ = (sel) => document.querySelector(sel);
const BLOOD_TYPES = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];
let currentTab = 'overview';
let pendingBroadcast = null; // the request that "Send now" will post
let pollTimer = null;
let openBroadcastId = null; // broadcast whose recipient list is shown

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : String(c));
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (res.status === 403 && path.startsWith('/admin/api')) { showLogin(); throw new Error('Please log in.'); }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
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

const fmtDate = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const fmtDay = (v) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const yesNo = (v) => (v ? '✅' : '—');
const revealQuery = () => ($('#reveal').checked ? 'reveal=1' : '');

// columns: [header, row => value or Node]
function renderTable(table, rows, columns, emptyText = 'Nothing here yet.') {
  table.replaceChildren(
    el('thead', {}, el('tr', {}, columns.map(([h]) => el('th', {}, h)))),
    el('tbody', {}, rows.length
      ? rows.map(r => el('tr', {}, columns.map(([, f]) => el('td', {}, f(r) ?? ''))))
      : el('tr', {}, el('td', { colspan: columns.length, class: 'empty' }, emptyText)))
  );
}

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

// ---------- Tabs ----------
$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.dataset?.tab;
  if (tab) openTab(tab);
});

function openTab(tab) {
  currentTab = tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== tab; });
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
    broadcast: loadBroadcastTab
  };
  loaders[tab]().catch(err => toast(err.message, true));
}

$('#reveal').addEventListener('change', () => loadTab(currentTab));

// ---------- Overview ----------
$('#stats-days').addEventListener('change', () => loadStats().catch(err => toast(err.message, true)));
$('#stats-refresh').addEventListener('click', () => loadStats().catch(err => toast(err.message, true)));

function card(label, value, note, onclick) {
  return el('div', { class: onclick ? 'stat clickable' : 'stat', onclick },
    el('div', { class: 'stat-value' }, value ?? 0),
    el('div', { class: 'stat-label' }, label),
    note ? el('div', { class: 'stat-note' }, note) : null);
}

async function loadStats() {
  const days = $('#stats-days').value;
  const { stats: s, totals: t, report } = await api(`/admin/api/stats?days=${days}`);
  const period = days === '1' ? '24h' : `${days}d`;
  const goDonors = (status) => () => { document.querySelector('[data-list="donors"] [name="status"]').value = status; openTab('donors'); };
  $('#stat-cards').replaceChildren(
    el('h3', { class: 'cards-title' }, 'Donors'),
    card('Total donors', s.donors.total),
    card(`New (${period})`, s.donors.new),
    card('Ready now', s.donors.ready, 'can be matched today'),
    card('Resting', s.donors.resting, 'donated recently'),
    card('Needs review', s.donors.needs_review, 'click to review', goDonors('needs_review')),
    card('Opted out of news', t.donors_opted_out),
    el('h3', { class: 'cards-title' }, 'Requests (all time)'),
    card('Open', t.requests_open),
    card('Fulfilled', t.requests_fulfilled),
    card('No donor found', t.requests_no_donor),
    card(`New (${period})`, s.requests.total),
    el('h3', { class: 'cards-title' }, 'Matches and donations'),
    card('Donors contacted', t.matches_total, 'all time'),
    card('Replied', t.matches_replied, 'all time'),
    card(`Yes (${period})`, s.matches.yes),
    card('Confirmed donations', t.donations_confirmed, 'all time'),
    card(`Confirmed (${period})`, s.donations.confirmed)
  );
  $('#stats-report').textContent = report.join('\n\n────────\n\n');
}

// ---------- Lists ----------
document.querySelectorAll('form.filters').forEach(form => {
  form.addEventListener('submit', (e) => { e.preventDefault(); loadList(form.dataset.list).catch(err => toast(err.message, true)); });
});

for (const sel of document.querySelectorAll('select.blood-types')) {
  for (const t of BLOOD_TYPES) sel.append(el('option', { value: t }, t));
}

function filterQuery(list) {
  const params = new URLSearchParams(new FormData(document.querySelector(`form[data-list="${list}"]`)));
  for (const [k, v] of [...params]) if (!v) params.delete(k);
  if ($('#reveal').checked) params.set('reveal', '1');
  return params.toString();
}

const STATUS_LABELS = {
  eligible: 'Eligible', needs_review: '🔎 Needs review', needs_update: 'Needs update', on_hold: 'On hold', not_eligible: '❌ Not eligible'
};

async function reviewDonor(id, decision) {
  if (!confirm(decision === 'approve' ? 'Approve this donor? They can then be matched.' : 'Reject this donor? They will not be matched.')) return;
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

const COLUMNS = {
  donors: [
    ['#', r => r.id],
    ['Name', r => r.name],
    ['Phone', r => r.phone],
    ['Blood', r => r.blood_type],
    ['City', r => r.city],
    ['Status', r => STATUS_LABELS[r.eligibility_status] || r.eligibility_status],
    ['Screening notes', r => r.screening_reasons],
    ['Last donation', r => fmtDay(r.last_donation_date)],
    ['Joined', r => fmtDay(r.created_at)],
    ['News', r => (r.broadcast_opt_out ? 'Opted out' : '')],
    ['Review', r => (r.eligibility_status === 'needs_review'
      ? el('span', { class: 'actions' },
        el('button', { class: 'small', onclick: () => reviewDonor(r.id, 'approve') }, 'Approve'),
        el('button', { class: 'small danger', onclick: () => reviewDonor(r.id, 'reject') }, 'Reject'))
      : '')]
  ],
  requests: [
    ['#', r => r.id],
    ['Blood', r => r.blood_type_needed],
    ['Units', r => r.units_needed],
    ['Urgency', r => r.urgency],
    ['Status', r => r.status],
    ['Place', r => r.location],
    ['Hospital', r => r.facility_name || r.hospital_name],
    ['Contacted / yes', r => `${r.contacted} / ${r.yes}`],
    ['Requester', r => r.requester_phone],
    ['Contact', r => [r.contact_name, r.contact_phone].filter(Boolean).join(' ')],
    ['Created', r => fmtDate(r.created_at)]
  ],
  matches: [
    ['#', r => r.id],
    ['Request', r => `#${r.request_id}`],
    ['Donor', r => r.donor_name],
    ['Phone', r => r.phone],
    ['Blood', r => r.blood_type_needed],
    ['Place', r => r.location],
    ['Reply', r => r.response],
    ['Contacted', r => fmtDate(r.contacted_at)],
    ['Replied', r => fmtDate(r.responded_at)],
    ['Code', r => r.confirm_code],
    ['Donation', r => (r.donation_confirmed_at ? `✅ ${r.confirmed_by_facility ? 'by hospital' : 'self-reported'}` : '')]
  ],
  facilities: [
    ['#', r => r.id],
    ['Name', r => `${r.name}${r.is_demo ? ' (demo)' : ''}`],
    ['Type', r => r.type],
    ['City', r => r.city],
    ['Staff phone', r => r.staff_phone],
    ...[['Partner', 'is_partner'], ['Collects blood', 'does_blood_collection'], ['Lab tests', 'does_lab_tests']].map(([h, flag]) =>
      [h, r => el('input', { type: 'checkbox', checked: Boolean(r[flag]), onchange: (e) => toggleFacility(r.id, flag, e.target.checked) })])
  ]
};

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
  e.target.form.does_lab_tests.checked = lab;
  e.target.form.does_blood_collection.checked = !lab;
});

// ---------- Templates ----------
$('#templates-refresh').addEventListener('click', () => loadTemplates(true).catch(err => toast(err.message, true)));

const STATUS_BADGE = { APPROVED: '✅ Approved', PENDING: '⏳ In review', REJECTED: '❌ Rejected', MISSING: '➖ Not submitted', PAUSED: '⏸️ Paused', DISABLED: '🚫 Disabled' };

async function loadTemplates(refresh) {
  const table = $('#table-templates');
  try {
    const data = await api(`/admin/api/templates${refresh ? '?refresh=1' : ''}`);
    if (!data.configured) {
      renderTable(table, [], [['Status', () => '']], 'Add WABA_ID (and WHATSAPP_TOKEN) on Render to see template status.');
      return;
    }
    renderTable(table, data.rows, [
      ['Template', r => r.name],
      ['Category', r => r.category],
      ['Status', r => el('span', { class: `badge ${String(r.status).toLowerCase()}` }, STATUS_BADGE[r.status] || r.status)],
      ['Note', r => (r.extra ? 'In WhatsApp Manager, not used by the bot' : '')]
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

function hidePreview() {
  pendingBroadcast = null;
  $('#broadcast-preview').hidden = true;
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
    const p = await api('/admin/api/broadcasts/preview', { method: 'POST', body });
    pendingBroadcast = { ...body, expected_count: p.total };
    const minutes = p.secondsEstimate > 90 ? `about ${Math.ceil(p.secondsEstimate / 60)} min` : `about ${p.secondsEstimate} s`;
    $('#preview-summary').textContent =
      `${p.total} donor(s) will get this (${p.audience}). ${p.inWindow} as a normal message, ${p.viaTemplate} with the template. Sending takes ${minutes}.`;
    let warning = '';
    if (p.total === 0) warning = 'No donors match. Nothing will be sent.';
    else if (p.viaTemplate > 0 && p.templateStatus !== 'APPROVED') {
      warning = `⚠️ Template donor_broadcast is ${p.templateStatus === 'UNKNOWN' ? 'not checked (WABA_ID missing?)' : STATUS_BADGE[p.templateStatus] || p.templateStatus}. ` +
        `The ${p.viaTemplate} donor(s) outside the 24h window will fail. Tick "Only donors who messaged in the last 24 hours" to skip them.`;
    }
    $('#preview-warning').textContent = warning;
    $('#preview-text').textContent = p.sampleText;
    $('#preview-template').textContent = p.sampleTemplate;
    $('#confirm-check').checked = false;
    $('#broadcast-send').disabled = true;
    $('#broadcast-preview').hidden = false;
    $('#broadcast-send').textContent = `Send to ${p.total} donor(s)`;
  } catch (err) { toast(err.message, true); }
});

$('#confirm-check').addEventListener('change', (e) => {
  $('#broadcast-send').disabled = !e.target.checked || !pendingBroadcast?.expected_count;
});
$('#broadcast-cancel').addEventListener('click', hidePreview);

$('#broadcast-send').addEventListener('click', async () => {
  if (!pendingBroadcast) return;
  if (!confirm(`Last check: send this message to ${pendingBroadcast.expected_count} donor(s) now? This cannot be undone.`)) return;
  $('#broadcast-send').disabled = true;
  try {
    const { id, total } = await api('/admin/api/broadcasts', { method: 'POST', body: { ...pendingBroadcast, confirm: true } });
    toast(`Broadcast #${id} started: sending to ${total} donor(s).`);
    hidePreview();
    bForm.reset();
    $('#msg-count').textContent = '0';
    openBroadcastId = id;
    await loadBroadcasts();
  } catch (err) {
    toast(err.message, true);
    $('#broadcast-send').disabled = false;
  }
});

async function loadBroadcasts() {
  const { rows } = await api('/admin/api/broadcasts');
  renderTable($('#table-broadcasts'), rows, [
    ['#', r => r.id],
    ['When', r => fmtDate(r.created_at)],
    ['To', r => r.audience?.label || ''],
    ['Message', r => (r.message.length > 80 ? `${r.message.slice(0, 80)}…` : r.message)],
    ['Status', r => r.status],
    ['Sent / failed / total', r => `${r.sent} / ${r.failed} / ${r.total}`],
    ['', r => el('button', { class: 'small ghost', onclick: () => showBroadcast(r.id) }, 'Details')]
  ], 'No broadcasts yet.');
  if (openBroadcastId) await showBroadcast(openBroadcastId);
  clearTimeout(pollTimer);
  if (rows.some(r => r.status === 'sending') && currentTab === 'broadcast') pollTimer = setTimeout(() => loadBroadcasts().catch(() => {}), 3000);
}

async function showBroadcast(id) {
  openBroadcastId = id;
  const { broadcast: b, recipients } = await api(`/admin/api/broadcasts/${id}?${revealQuery()}`);
  $('#broadcast-detail').hidden = false;
  $('#broadcast-detail-title').textContent = `Broadcast #${b.id}: ${b.status}`;
  renderTable($('#table-broadcast-recipients'), recipients, [
    ['Donor', r => r.name],
    ['Phone', r => r.phone],
    ['Sent as', r => (r.channel === 'template' ? 'template' : 'normal message')],
    ['Result', r => (r.status === 'sent' ? '✅ sent' : '❌ failed')],
    ['Error', r => r.error],
    ['Time', r => fmtDate(r.sent_at)]
  ], 'Sending has not started yet.');
}

// ---------- Start ----------
async function start() {
  try {
    await api('/admin/api/me');
  } catch (err) {
    return; // showLogin() already ran
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  openTab(currentTab);
}

start();
