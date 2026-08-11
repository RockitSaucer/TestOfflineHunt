/**
 * Secure site → GitHub Issues bridge for TestOfflineHunt.
 * Token stays server-side only (Vercel env GITHUB_ISSUE_TOKEN).
 *
 * POST JSON: { message, title?, site: 'testofflinehunt'|'hunt', contact? }
 * Creates issue on RockitSaucer/TestOfflineHunt with labels from-site + from-testofflinehunt.
 */

const REPO = 'RockitSaucer/TestOfflineHunt';
const MAX_MSG = 4000;
const MAX_TITLE = 120;

const hits = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 8;

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : 'unknown';
}

function allowRate(ip) {
  const now = Date.now();
  let arr = hits.get(ip) || [];
  arr = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    hits.set(ip, arr);
    return false;
  }
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

function cors(res, origin) {
  const allowed = [
    'https://huntslayer.com',
    'https://www.huntslayer.com',
    'https://regslayer.com',
    'https://www.regslayer.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ];
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  // Always allow same-origin Vercel previews
  if (origin && /\.vercel\.app$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sanitize(s, max) {
  return String(s == null ? '' : s)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  cors(res, origin);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
    return;
  }

  const token = process.env.GITHUB_ISSUE_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!token) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Issue reporting not configured' }));
    return;
  }

  const ip = clientIp(req);
  if (!allowRate(ip)) {
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Too many reports — try later' }));
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const message = sanitize(body.message, MAX_MSG);
  if (!message || message.length < 8) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Message too short' }));
    return;
  }

  const titleIn = sanitize(body.title, MAX_TITLE);
  const contact = sanitize(body.contact, 120);
  const site = 'testofflinehunt';
  const appVersion = sanitize(body.appVersion || body.version, 40);
  const title = titleIn || ('[TestOfflineHunt] ' + message.slice(0, 72).replace(/\n/g, ' '));

  const bodyMd = [
    '## Report (TestOfflineHunt merge lab)',
    '',
    message,
    '',
    '---',
    '- **Site:** TestOfflineHunt (Plan event cards + List float — not production Hunt)',
    appVersion ? '- **App version:** ' + appVersion : null,
    contact ? '- **Contact:** ' + contact : null,
    '- **Labels:** from-site, from-testofflinehunt',
    '- **IP (coarse):** ' + String(ip).slice(0, 48),
    '',
    '_Agent: fix on TestOfflineHunt first; only promote to Hunt-Slayer after Rockit approves._'
  ].filter(Boolean).join('\n');

  try {
    const gh = await fetch('https://api.github.com/repos/' + REPO + '/issues', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'TestOfflineHunt-report-issue'
      },
      body: JSON.stringify({
        title: title.slice(0, MAX_TITLE),
        body: bodyMd,
        labels: ['from-site', 'from-testofflinehunt']
      })
    });
    const data = await gh.json().catch(() => ({}));
    if (!gh.ok) {
      console.error('GitHub issue create failed', gh.status, data);
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'Could not create issue' }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      number: data.number,
      url: data.html_url
    }));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Server error' }));
  }
};
