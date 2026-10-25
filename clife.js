#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const API_URL = 'https://life-api.caulfieldlife.com.au/';
const API_AUTH = 'Bearer X-ae97a16a-3e28-4365:Y-53e74b38-8a53-4ef7';
const ORIGIN = 'https://caulfieldlife.com.au';
const TZ = 'Australia/Melbourne';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CONFIG_PATH =
  process.env.CLIFE_CONFIG ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'clife', 'config.json');

const SESSION_QUERY = `
query GetSessionByJwt($jwtToken: String!) {
  sessionByJwt(jwtIdToken: $jwtToken) {
    id
    processedAt
    isImpersonating
    xhqToken
    member {
      id
      firstName
      lastName
      preferredName
      roles { title }
    }
    sessionSyncCheckpoints { success type error }
  }
}`;

const CLASS_QUERY = `
fragment ClassFields on Class {
  id
  title
  description
  startTime
  endTime
  dayOrder
  periodOrder
  periodName
  colour
  room
  teacherName
  __typename
}

query ClassData($memberId: ID!, $startTime: DateTime!, $endTime: DateTime) {
  classes(
    where: { startTime: $startTime, endTime: $endTime, memberId: $memberId }
    orderBy: { property: "startTime", sort: ASC }
  ) {
    ...ClassFields
  }
}`;

const HELP = `clife - Caulfield Grammar timetable from your terminal

Usage:
  clife login [token]          Save your CaulfieldLife token (or "-" / pipe to read stdin)
  clife logout                 Remove the saved token
  clife whoami                 Show the logged in user and token expiry
  clife token                  Print the saved token
  clife ls [date]              Show classes on a date (default: today)
  clife search <class name>    Find upcoming classes by subject, code, teacher

Dates for ls and --from:
  today, tomorrow, yesterday, +3, -1, mon, friday,
  2026-04-13, 13/4, 13/4/2026

Options:
  --json             Output raw JSON
  --no-color         Disable colours
  -d, --days <n>     Days to scan for search (default 14, max 120)
  --from <date>      Start date for search (default today)
  -h, --help         Show this help

Getting a token:
  1. Log in at https://caulfieldlife.com.au
  2. Open DevTools console and run: copy(localStorage.jwt)
  3. Run: clife login   (then paste)

Tokens expire after about an hour, so you will need to log in again.
Config file: ${CONFIG_PATH}`;

class CliError extends Error {}

let useColor = false;

function paint(code, s) {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {}
}

function clearConfig() {
  try {
    fs.unlinkSync(CONFIG_PATH);
    return true;
  } catch {
    return false;
  }
}

function cleanToken(raw) {
  return raw
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new CliError('That does not look like a JWT.');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new CliError('Could not decode the token payload.');
  }
}

function describeExpiry(exp) {
  if (!exp) return 'unknown';
  const ms = exp * 1000 - Date.now();
  if (ms <= 0) return 'expired';
  return `in ${Math.max(1, Math.round(ms / 60000))} min`;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    })
  );
}

function post(body, jwt) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      API_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          accept: '*/*',
          authorization: API_AUTH,
          origin: ORIGIN,
          referer: ORIGIN + '/',
          'user-agent': 'clife-cli',
          'x-community-token': jwt,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new CliError(`Unexpected response from API (HTTP ${res.statusCode}).`));
          }
        });
      }
    );
    req.on('error', (e) => reject(new CliError(`Network error: ${e.message}`)));
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
    req.write(data);
    req.end();
  });
}

async function gql(jwt, operationName, query, variables) {
  const res = await post({ operationName, query, variables }, jwt);
  if (res.errors && res.errors.length) {
    const e = res.errors[0];
    if (e.name === 'Unauthorized') {
      throw new CliError('Unauthorized. Your token has probably expired. Run: clife login');
    }
    throw new CliError(e.message || 'The API returned an error.');
  }
  return res.data;
}

function requireAuth() {
  const cfg = loadConfig();
  if (!cfg.jwt || !cfg.memberId) throw new CliError('Not logged in. Run: clife login');
  let exp = cfg.exp;
  if (!exp) {
    try {
      exp = decodeJwt(cfg.jwt).exp;
    } catch {}
  }
  if (exp && exp * 1000 <= Date.now()) throw new CliError('Token expired. Run: clife login');
  return cfg;
}

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function tzOffsetMs(ms) {
  const v = {};
  for (const p of partsFmt.formatToParts(new Date(ms))) v[p.type] = Number(p.value);
  return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - Math.floor(ms / 1000) * 1000;
}

function startOfDayMs({ y, m, d }) {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMs(guess);
  return guess - tzOffsetMs(first);
}

function melbourneToday() {
  const v = {};
  for (const p of partsFmt.formatToParts(new Date())) v[p.type] = Number(p.value);
  return { y: v.year, m: v.month, d: v.day };
}

function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf({ y, m, d }) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isValidDate({ y, m, d }) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function isoDate({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function formatDate(date) {
  const wd = WEEKDAYS[weekdayOf(date)].slice(0, 3);
  return `${wd} ${date.d} ${MONTHS[date.m - 1]} ${date.y}`;
}

function parseDate(input) {
  const today = melbourneToday();
  if (!input) return today;
  const s = input.trim().toLowerCase();
  if (s === 'today') return today;
  if (s === 'tomorrow' || s === 'tmr') return addDays(today, 1);
  if (s === 'yesterday') return addDays(today, -1);

  let match = s.match(/^([+-]\d+)$/);
  if (match) return addDays(today, Number(match[1]));

  if (s.length >= 3) {
    const wd = WEEKDAYS.findIndex((name) => name.toLowerCase().startsWith(s));
    if (wd !== -1) return addDays(today, (wd - weekdayOf(today) + 7) % 7);
  }

  let date = null;
  match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    date = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  } else {
    match = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (match) {
      let y = match[3] ? Number(match[3]) : today.y;
      if (y < 100) y += 2000;
      date = { y, m: Number(match[2]), d: Number(match[1]) };
    }
  }
  if (!date || !isValidDate(date)) throw new CliError(`Could not understand the date "${input}".`);
  return date;
}

async function fetchDay(cfg, date) {
  const start = startOfDayMs(date);
  const end = startOfDayMs(addDays(date, 1)) - 1;
  const data = await gql(cfg.jwt, 'ClassData', CLASS_QUERY, {
    memberId: cfg.memberId,
    startTime: new Date(start).toISOString(),
    endTime: new Date(end).toISOString(),
  });
  return (data.classes || []).slice().sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function visibleLength(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function renderTable(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, visibleLength(cell));
    });
  }
  return rows
    .map((row) =>
      '  ' +
      row
        .map((cell, i) => cell + ' '.repeat(widths[i] - visibleLength(cell)))
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}

function swatch(hex) {
  const m = typeof hex === 'string' && hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (useColor && m) {
    const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
    return `\x1b[38;2;${r};${g};${b}m█\x1b[0m`;
  }
  return '-';
}

function classRow(c) {
  const period = c.periodName ? (/^\d+$/.test(c.periodName) ? `P${c.periodName}` : c.periodName) : '';
  const time = `${timeFmt.format(new Date(c.startTime))}-${timeFmt.format(new Date(c.endTime))}`;
  return [
    swatch(c.colour),
    period,
    time,
    c.description || c.title || '',
    c.room || '',
    c.teacherName || '',
    paint(2, c.title || ''),
  ];
}

async function cmdLogin(args) {
  let raw = args.positional[0];
  if (raw === '-' || (!raw && !process.stdin.isTTY)) raw = await readStdin();
  if (!raw) raw = await prompt('Paste your jwt (localStorage.jwt on caulfieldlife.com.au): ');
  const jwt = cleanToken(raw || '');
  if (!jwt) throw new CliError('No token provided.');

  const payload = decodeJwt(jwt);
  if (payload.exp && payload.exp * 1000 <= Date.now()) {
    throw new CliError('That token has already expired. Log in on caulfieldlife.com.au and copy a fresh one.');
  }

  const data = await gql(jwt, 'GetSessionByJwt', SESSION_QUERY, { jwtToken: jwt });
  const session = data && data.sessionByJwt;
  if (!session || !session.member) throw new CliError('Login failed: the API did not return a session.');

  const member = session.member;
  const name = [member.preferredName || member.firstName, member.lastName].filter(Boolean).join(' ');
  saveConfig({
    jwt,
    exp: payload.exp || null,
    memberId: member.id,
    name,
    email: payload.preferred_username || payload.email || payload.upn || null,
    roles: (member.roles || []).map((r) => r.title),
    xhqToken: session.xhqToken || null,
    savedAt: new Date().toISOString(),
  });

  console.log(`Logged in as ${name}. Token expires ${describeExpiry(payload.exp)}.`);
}

function cmdLogout() {
  console.log(clearConfig() ? 'Logged out.' : 'Already logged out.');
}

function cmdWhoami(args) {
  const cfg = loadConfig();
  if (!cfg.jwt) throw new CliError('Not logged in. Run: clife login');
  let exp = cfg.exp;
  if (!exp) {
    try {
      exp = decodeJwt(cfg.jwt).exp;
    } catch {}
  }
  const info = {
    name: cfg.name || null,
    email: cfg.email || null,
    memberId: cfg.memberId || null,
    roles: cfg.roles || [],
    tokenExpires: exp ? new Date(exp * 1000).toISOString() : null,
    tokenStatus: describeExpiry(exp),
  };
  if (args.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  const lines = [
    ['Name', info.name],
    ['Email', info.email],
    ['Member ID', info.memberId],
    ['Roles', info.roles.join(', ')],
    ['Token', info.tokenStatus === 'expired' ? paint(31, 'expired') : `valid, expires ${info.tokenStatus}`],
  ];
  for (const [label, value] of lines) {
    if (value) console.log(`${label.padEnd(10)}${value}`);
  }
}

function cmdToken() {
  const cfg = loadConfig();
  if (!cfg.jwt) throw new CliError('Not logged in. Run: clife login');
  console.log(cfg.jwt);
}

async function cmdLs(args) {
  const cfg = requireAuth();
  const date = parseDate(args.positional[0]);
  const classes = await fetchDay(cfg, date);

  if (args.json) {
    console.log(JSON.stringify(classes, null, 2));
    return;
  }

  console.log(paint(1, formatDate(date)));
  if (!classes.length) console.log('  No classes');
  else console.log(renderTable(classes.map(classRow)));
}

async function cmdSearch(args) {
  const cfg = requireAuth();
  const query = args.positional.join(' ').trim().toLowerCase();
  if (!query) throw new CliError('Usage: clife search <class name>');
  const terms = query.split(/\s+/);

  const days = args.days === undefined ? 14 : Number(args.days);
  if (!Number.isInteger(days) || days < 1 || days > 120) {
    throw new CliError('--days must be a whole number between 1 and 120.');
  }

  const from = parseDate(args.from);
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const perDay = await mapLimit(dates, 6, (date) => fetchDay(cfg, date));

  const results = [];
  dates.forEach((date, i) => {
    for (const c of perDay[i]) {
      const haystack = [c.description, c.title, c.teacherName].filter(Boolean).join(' ').toLowerCase();
      if (terms.every((t) => haystack.includes(t))) results.push({ date, class: c });
    }
  });

  if (args.json) {
    console.log(JSON.stringify(results.map((r) => ({ date: isoDate(r.date), ...r.class })), null, 2));
    return;
  }

  if (!results.length) {
    console.log(`No classes matching "${query}" from ${formatDate(from)} for ${days} days.`);
    return;
  }

  let last = null;
  for (const r of results) {
    const key = isoDate(r.date);
    if (key !== last) {
      if (last !== null) console.log('');
      console.log(paint(1, formatDate(r.date)));
      last = key;
    }
    const rows = [classRow(r.class)];
    console.log(renderTable(rows));
  }
}

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--no-color') out.noColor = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-d' || a === '--days') out.days = argv[++i];
    else if (a.startsWith('--days=')) out.days = a.slice(7);
    else if (a === '--from') out.from = argv[++i];
    else if (a.startsWith('--from=')) out.from = a.slice(7);
    else if (a.startsWith('-') && a !== '-' && !/^-\d+$/.test(a)) throw new CliError(`Unknown option ${a}`);
    else out.positional.push(a);
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !args.noColor;

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help' || args.help) {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case 'login':
      return cmdLogin(args);
    case 'logout':
      return cmdLogout();
    case 'whoami':
      return cmdWhoami(args);
    case 'token':
      return cmdToken();
    case 'ls':
    case 'list':
      return cmdLs(args);
    case 'search':
    case 'find':
      return cmdSearch(args);
    default:
      throw new CliError(`Unknown command "${cmd}". Run: clife --help`);
  }
}

main().catch((e) => {
  console.error(e instanceof CliError ? e.message : `Error: ${e.message}`);
  process.exit(1);
});
