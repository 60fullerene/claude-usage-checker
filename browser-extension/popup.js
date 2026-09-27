import { formatAgo, formatIn, getSettings, primaryWindows } from './usage.js';

const $ = (id) => document.getElementById(id);

function setLine(id, state, text) {
  const item = $(id);
  item.className = state;
  item.querySelector('.text').textContent = text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function windowRow(label, window) {
  const row = el('div', 'row');
  row.append(el('span', '', label));
  if (!window) {
    row.append(el('span', 'detail', 'no limit'));
    return row;
  }
  const left = Math.max(0, 100 - window.percent);
  const bar = el('div', `bar ${left < 10 ? 'bad' : left < 30 ? 'warn' : ''}`);
  const fill = el('span');
  fill.style.width = `${Math.min(100, window.percent)}%`;
  bar.append(fill);
  row.append(bar);
  const resets = window.resetsAt ? ` · resets in ${formatIn(window.resetsAt)}` : '';
  row.append(el('span', 'detail', `${Math.round(left)}% left${resets}`));
  return row;
}

function render(status) {
  if (status.desktop === 'connected') {
    setLine('desktop', 'ok', `Claude Desktop connected (port ${status.port})`);
  } else if (status.desktop === 'unreachable') {
    setLine('desktop', 'bad', `Claude Desktop not reachable on port ${status.port}: start Claude Desktop with the “Claude Usage” extension enabled.`);
  }

  const fetch = status.last_fetch;
  if (fetch?.error) {
    setLine('claude', 'bad', fetch.error.message);
  } else if (fetch) {
    const delivered = status.delivered_at && status.delivered_at >= fetch.at ? 'sent to Claude Desktop' : 'not sent (Claude Desktop not reachable)';
    setLine('claude', 'ok', `claude.ai read ${formatAgo(fetch.at)}, ${delivered}`);
  }

  const container = $('orgs');
  container.replaceChildren();
  for (const org of fetch?.orgs || []) {
    const card = el('div', 'org');
    card.append(el('h2', '', org.name || org.uuid || 'Organization'));
    if (org.usage) {
      const windows = primaryWindows(org.usage);
      card.append(windowRow('5-hour', windows.five_hour), windowRow('Weekly', windows.seven_day));
    } else {
      card.append(el('div', 'detail', `No usage data (${org.error || 'unknown error'})`));
    }
    container.append(card);
  }
}

async function refresh() {
  const button = $('refresh');
  button.disabled = true;
  try {
    render(await chrome.runtime.sendMessage({ type: 'refresh' }));
  } finally {
    button.disabled = false;
  }
}

$('refresh').addEventListener('click', refresh);
$('save').addEventListener('click', async () => {
  const port = Number($('port').value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, port } });
  refresh();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.status?.newValue) render(changes.status.newValue);
});

(async () => {
  $('port').value = (await getSettings()).port;
  const { status } = await chrome.storage.local.get('status');
  if (status) render(status);
  refresh(); // opening the popup reads claude.ai right away
})();
