// Generates the dark, HUD-style SVG panels in assets/ and the dynamic block in README.md
// from public GitHub data. Runs in GitHub Actions (see .github/workflows/profile.yml).
//
// Env:
//   GH_TOKEN      token for the GraphQL API (GITHUB_TOKEN is enough for public data)
//   GH_USER       login to render (defaults to the repository owner)
//   PROFILE_TZ    IANA timezone for "active hours" (default Asia/Taipei)

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const LOGIN = process.env.GH_USER || process.env.GITHUB_REPOSITORY_OWNER || 'YueyuHoshizora';
const TZ = process.env.PROFILE_TZ || 'Asia/Taipei';
const OUT = new URL('../assets/', import.meta.url);
const README = new URL('../README.md', import.meta.url);

if (!TOKEN) {
  console.error('GH_TOKEN is required');
  process.exit(1);
}

// ---------------------------------------------------------------- data ----

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

const PROFILE_QUERY = `
query($login: String!) {
  user(login: $login) {
    id login name bio location createdAt avatarUrl(size: 220)
    followers { totalCount }
    following { totalCount }
    repositories(ownerAffiliations: OWNER, privacy: PUBLIC) { totalCount }
    pullRequests { totalCount }
    issues { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount weekday } }
      }
    }
  }
}`;

const REPOS_QUERY = `
query($login: String!, $after: String, $since: GitTimestamp!, $author: ID!) {
  user(login: $login) {
    repositories(first: 50, after: $after, ownerAffiliations: OWNER, privacy: PUBLIC,
                 orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name description url isFork isArchived stargazerCount forkCount pushedAt
        primaryLanguage { name color }
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
        defaultBranchRef {
          target {
            ... on Commit {
              history(first: 100, since: $since, author: { id: $author }) {
                pageInfo { hasNextPage endCursor }
                nodes { authoredDate }
              }
            }
          }
        }
      }
    }
  }
}`;

const HISTORY_QUERY = `
query($owner: String!, $name: String!, $after: String, $since: GitTimestamp!, $author: ID!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, after: $after, since: $since, author: { id: $author }) {
            pageInfo { hasNextPage endCursor }
            nodes { authoredDate }
          }
        }
      }
    }
  }
}`;

// Follows commit-history pagination for repos with more than 100 commits in the window.
async function fillHistory(repo, since, author) {
  const history = repo.defaultBranchRef?.target?.history;
  let page = history?.pageInfo;
  for (let i = 0; page?.hasNextPage && i < 30; i++) {
    const data = await gql(HISTORY_QUERY, { owner: LOGIN, name: repo.name, after: page.endCursor, since, author });
    const next = data.repository.defaultBranchRef.target.history;
    history.nodes.push(...next.nodes);
    page = next.pageInfo;
  }
}

async function fetchAll() {
  const { user } = await gql(PROFILE_QUERY, { login: LOGIN });
  const since = new Date(Date.now() - 365 * 864e5).toISOString();
  const repos = [];
  let after = null;
  do {
    const data = await gql(REPOS_QUERY, { login: LOGIN, after, since, author: user.id });
    const page = data.user.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  for (const r of repos) await fillHistory(r, since, user.id);
  return { user, repos };
}

async function fetchAvatar(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- analysis ---

function analyze({ user, repos }) {
  const own = repos.filter((r) => !r.isFork);
  const cc = user.contributionsCollection;
  const days = cc.contributionCalendar.weeks.flatMap((w) => w.contributionDays);

  // Streaks (today may still be empty, so the current streak may start yesterday).
  let longest = 0, run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) current++;
    else if (i === days.length - 1) continue;
    else break;
  }
  const best = days.reduce((a, d) => (d.contributionCount > a.contributionCount ? d : a), days[0]);

  // Weekday distribution from the contribution calendar (0 = Sunday).
  const weekdays = Array(7).fill(0);
  for (const d of days) weekdays[d.weekday] += d.contributionCount;

  // Hour-of-day distribution from commit timestamps, in the profile's timezone.
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
  const hours = Array(24).fill(0);
  let commits = 0;
  for (const r of repos) {
    for (const c of r.defaultBranchRef?.target?.history?.nodes ?? []) {
      hours[Number(hourFmt.format(new Date(c.authoredDate))) % 24]++;
      commits++;
    }
  }

  // Language share by bytes across owned, non-fork repositories.
  const langs = new Map();
  for (const r of own) {
    for (const e of r.languages.edges) {
      const cur = langs.get(e.node.name) || { name: e.node.name, color: e.node.color || '#8b949e', size: 0 };
      cur.size += e.size;
      langs.set(e.node.name, cur);
    }
  }
  const langTotal = [...langs.values()].reduce((a, l) => a + l.size, 0) || 1;
  const languages = [...langs.values()]
    .sort((a, b) => b.size - a.size)
    .map((l) => ({ ...l, pct: (l.size / langTotal) * 100 }));

  return {
    user,
    days,
    weeks: cc.contributionCalendar.weeks,
    totalContrib: cc.contributionCalendar.totalContributions,
    commits1y: cc.totalCommitContributions,
    prs1y: cc.totalPullRequestContributions,
    issues1y: cc.totalIssueContributions,
    reviews1y: cc.totalPullRequestReviewContributions,
    publicRepos: user.repositories.totalCount,
    sourceRepos: own.length,
    stars: own.reduce((a, r) => a + r.stargazerCount, 0),
    forks: own.reduce((a, r) => a + r.forkCount, 0),
    followers: user.followers.totalCount,
    following: user.following.totalCount,
    current, longest, best, weekdays, hours, commits, languages,
    recent: own.filter((r) => r.name.toLowerCase() !== LOGIN.toLowerCase() && !r.isArchived).slice(0, 6),
  };
}

// ------------------------------------------------------------------ svg ---

const C = {
  bg0: '#05070d', bg1: '#0b1022', panel: '#0d1326', line: '#1b2440',
  dim: '#5b6b8c', text: '#c9d6f2', white: '#eef4ff',
  cyan: '#00e5ff', mag: '#ff2bd6', violet: '#8b5cf6', green: '#39ff88', amber: '#ffb020',
};
const MONO = `'JetBrains Mono','Fira Code','SFMono-Regular',Consolas,'Noto Sans Mono CJK TC','PingFang TC','Microsoft JhengHei',monospace`;

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US'));
const pad2 = (n) => String(n).padStart(2, '0');

function frame(w, h, title, body, extraDefs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${MONO}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bg0}"/><stop offset="1" stop-color="${C.bg1}"/></linearGradient>
  <linearGradient id="neon" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.cyan}"/><stop offset="1" stop-color="${C.mag}"/></linearGradient>
  <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="${C.cyan}" stroke-opacity=".05"/></pattern>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  ${extraDefs}
</defs>
<style>
  .blink{animation:blink 1.2s steps(2,start) infinite}
  @keyframes blink{to{visibility:hidden}}
  .fade{opacity:0;animation:fade .6s ease-out forwards}
  @keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .scan{animation:scan 6s linear infinite}
  @keyframes scan{from{transform:translateY(-60px)}to{transform:translateY(${h + 60}px)}}
</style>
<rect width="${w}" height="${h}" rx="14" fill="url(#bg)"/>
<rect width="${w}" height="${h}" rx="14" fill="url(#grid)"/>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="14" fill="none" stroke="${C.line}"/>
${corners(w, h)}
${title ? `<text x="28" y="38" font-size="13" fill="${C.dim}" letter-spacing="2"><tspan fill="${C.cyan}">▍</tspan>${esc(title)}</text>
<circle class="blink" cx="${w - 34}" cy="33" r="4" fill="${C.green}" filter="url(#glow)"/>
<text x="${w - 46}" y="38" font-size="11" fill="${C.green}" text-anchor="end" letter-spacing="2">LIVE</text>` : ''}
${body}
<rect class="scan" x="0" y="0" width="${w}" height="40" fill="${C.cyan}" opacity=".035"/>
</svg>`;
}

function corners(w, h, s = 16, m = 8) {
  const p = (d) => `<path d="${d}" fill="none" stroke="${C.cyan}" stroke-width="2" opacity=".7"/>`;
  return [
    p(`M${m} ${m + s}V${m}H${m + s}`),
    p(`M${w - m - s} ${m}H${w - m}V${m + s}`),
    p(`M${m} ${h - m - s}V${h - m}H${m + s}`),
    p(`M${w - m - s} ${h - m}H${w - m}V${h - m - s}`),
  ].join('');
}

function heroSvg(s, avatar) {
  const w = 1200, h = 300;
  const u = s.user;
  const created = new Date(u.createdAt);
  const daysOn = Math.floor((Date.now() - created) / 864e5);
  const name = u.name || u.login;
  const lines = [
    ['whoami', `${u.login}${u.bio ? ` — ${u.bio}` : ''}`],
    ['uptime', `on GitHub since ${created.toISOString().slice(0, 10)} · ${num(daysOn)} days`],
    ['ls ~/public | wc -l', `${s.publicRepos} public repositories · ★ ${num(s.stars)} stars`],
    ['locate', `${u.location || 'Earth'} · ${TZ}`],
  ];
  const term = lines.map(([cmd, out], i) => `
  <g class="fade" style="animation-delay:${0.4 + i * 0.35}s">
    <text x="60" y="${150 + i * 30}" font-size="15" fill="${C.text}"><tspan fill="${C.green}">❯</tspan> <tspan fill="${C.cyan}">${esc(cmd)}</tspan><tspan fill="${C.dim}">  →  </tspan>${esc(out)}</text>
  </g>`).join('');
  const cx = 1010, cy = 150;
  const avatarDefs = `<clipPath id="av"><circle cx="${cx}" cy="${cy}" r="62"/></clipPath>
  <radialGradient id="orb" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${C.mag}" stop-opacity=".35"/><stop offset="1" stop-color="${C.mag}" stop-opacity="0"/></radialGradient>
  <radialGradient id="orb2" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${C.cyan}" stop-opacity=".25"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></radialGradient>`;
  const body = `
<style>
  .spin{transform-box:fill-box;transform-origin:center;animation:spin 18s linear infinite}
  .spin-r{transform-box:fill-box;transform-origin:center;animation:spin 12s linear infinite reverse}
  @keyframes spin{to{transform:rotate(360deg)}}
  .g1{animation:g1 3.2s infinite steps(1)} .g2{animation:g2 3.2s infinite steps(1)}
  @keyframes g1{0%,92%,100%{transform:none;opacity:0}93%{transform:translate(-3px,1px);opacity:.8}95%{transform:translate(2px,-1px);opacity:.8}}
  @keyframes g2{0%,92%,100%{transform:none;opacity:0}94%{transform:translate(3px,-1px);opacity:.8}96%{transform:translate(-2px,1px);opacity:.8}}
</style>
<circle cx="880" cy="60" r="220" fill="url(#orb)"/>
<circle cx="200" cy="300" r="240" fill="url(#orb2)"/>
<text x="60" y="58" font-size="12" fill="${C.dim}" letter-spacing="3">// IDENTITY.MODULE <tspan fill="${C.green}">▸ ONLINE</tspan></text>
<g font-size="48" font-weight="700" letter-spacing="1">
  <text class="g1" x="60" y="110" fill="${C.cyan}">${esc(name)}</text>
  <text class="g2" x="60" y="110" fill="${C.mag}">${esc(name)}</text>
  <text x="60" y="110" fill="url(#neon)" filter="url(#glow)">${esc(name)}</text>
</g>
${term}
<rect class="blink" x="60" y="${150 + lines.length * 30 - 14}" width="9" height="17" fill="${C.cyan}"/>
<g>
  <circle cx="${cx}" cy="${cy}" r="96" fill="none" stroke="${C.line}" stroke-width="1"/>
  <circle class="spin" cx="${cx}" cy="${cy}" r="88" fill="none" stroke="${C.cyan}" stroke-width="2" stroke-dasharray="40 14 6 14" opacity=".8"/>
  <circle class="spin-r" cx="${cx}" cy="${cy}" r="76" fill="none" stroke="${C.mag}" stroke-width="1.5" stroke-dasharray="2 8" opacity=".9"/>
  ${avatar
    ? `<image href="${avatar}" x="${cx - 62}" y="${cy - 62}" width="124" height="124" clip-path="url(#av)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="${cx}" cy="${cy}" r="62" fill="${C.panel}"/><text x="${cx}" y="${cy + 14}" font-size="40" text-anchor="middle" fill="url(#neon)">${esc(u.login.slice(0, 2).toUpperCase())}</text>`}
  <circle cx="${cx}" cy="${cy}" r="62" fill="none" stroke="${C.cyan}" stroke-opacity=".6"/>
  <text x="${cx}" y="${cy + 122}" font-size="11" fill="${C.dim}" text-anchor="middle" letter-spacing="3">@${esc(u.login)}</text>
</g>`;
  return frame(w, h, '', body, avatarDefs);
}

function statsSvg(s) {
  const w = 1200, h = 290;
  const tiles = [
    ['PUBLIC REPOS', s.publicRepos, `${s.sourceRepos} source · ${s.publicRepos - s.sourceRepos} forks`, C.cyan],
    ['STARS EARNED', s.stars, `${num(s.forks)} forks of my work`, C.amber],
    ['CONTRIBUTIONS', s.totalContrib, 'last 365 days', C.green],
    ['COMMITS', s.commits1y, 'last 365 days', C.cyan],
    ['PULL REQUESTS', s.prs1y, `${num(s.user.pullRequests.totalCount)} all-time`, C.violet],
    ['ISSUES', s.issues1y, `${num(s.user.issues.totalCount)} all-time`, C.mag],
    ['CURRENT STREAK', s.current, `longest ${s.longest} days`, C.green],
    ['FOLLOWERS', s.followers, `following ${num(s.following)}`, C.amber],
  ];
  const tw = 270, th = 100, gx = 16, gy = 16, x0 = 28, y0 = 62;
  const body = tiles.map(([label, value, sub, color], i) => {
    const x = x0 + (i % 4) * (tw + gx), y = y0 + Math.floor(i / 4) * (th + gy);
    return `<g class="fade" style="animation-delay:${i * 0.08}s">
  <rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="10" fill="${C.panel}" stroke="${C.line}"/>
  <rect x="${x}" y="${y + 18}" width="3" height="${th - 36}" fill="${color}" filter="url(#glow)"/>
  <text x="${x + 20}" y="${y + 28}" font-size="11" fill="${C.dim}" letter-spacing="2">${label}</text>
  <text x="${x + 20}" y="${y + 66}" font-size="32" font-weight="700" fill="${C.white}">${num(value)}</text>
  <text x="${x + 20}" y="${y + 86}" font-size="11" fill="${color}" opacity=".85">${esc(sub)}</text>
</g>`;
  }).join('\n');
  return frame(w, h, 'TELEMETRY // PUBLIC CONTRIBUTION DATA', body);
}

function chronotype(hours) {
  const sum = (a, b) => hours.slice(a, b).reduce((x, y) => x + y, 0);
  const buckets = [
    ['EARLY BIRD', sum(5, 12)],
    ['DAY RUNNER', sum(12, 18)],
    ['EVENING CODER', sum(18, 23)],
    ['NIGHT OWL', hours[23] + sum(0, 5)],
  ];
  return buckets.sort((a, b) => b[1] - a[1])[0][0];
}

function activitySvg(s) {
  const w = 1200, h = 380;
  const max = Math.max(1, ...s.hours);
  const peak = s.hours.indexOf(Math.max(...s.hours));
  const bx = 40, by = 300, bh = 190, bw = 22, step = 29.5;
  const bars = s.hours.map((v, i) => {
    const hh = Math.max(2, (v / max) * bh);
    const x = bx + i * step;
    const isPeak = i === peak && v > 0;
    return `<rect x="${x}" y="${by - hh}" width="${bw}" height="${hh}" rx="3" fill="${isPeak ? C.mag : 'url(#bar)'}" ${isPeak ? 'filter="url(#glow)"' : `opacity="${0.35 + 0.65 * (v / max)}"`}>
    <animate attributeName="height" from="0" to="${hh}" dur=".8s" begin="${i * 0.025}s" fill="freeze"/>
    <animate attributeName="y" from="${by}" to="${by - hh}" dur=".8s" begin="${i * 0.025}s" fill="freeze"/>
  </rect>${i % 3 === 0 ? `<text x="${x + bw / 2}" y="${by + 20}" font-size="11" fill="${C.dim}" text-anchor="middle">${pad2(i)}</text>` : ''}`;
  }).join('\n');

  const peakX = bx + peak * step + bw / 2;
  const peakY = by - (s.hours[peak] / max) * bh;
  const names = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const wmax = Math.max(1, ...s.weekdays);
  const wx = 830, wy = 92, ww = 280;
  const wbest = s.weekdays.indexOf(Math.max(...s.weekdays));
  const week = s.weekdays.map((v, i) => `
  <text x="${wx}" y="${wy + i * 30 + 12}" font-size="12" fill="${i === wbest ? C.white : C.dim}">${names[i]}</text>
  <rect x="${wx + 46}" y="${wy + i * 30}" width="${ww}" height="14" rx="3" fill="${C.panel}" stroke="${C.line}"/>
  <rect x="${wx + 46}" y="${wy + i * 30}" width="${Math.max(2, (v / wmax) * ww)}" height="14" rx="3" fill="${i === wbest ? C.mag : 'url(#neon)'}" opacity="${i === wbest ? 1 : 0.75}"/>
  <text x="${wx + 46 + ww + 10}" y="${wy + i * 30 + 12}" font-size="11" fill="${C.text}">${v}</text>`).join('');

  const defs = `<linearGradient id="bar" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${C.violet}"/><stop offset="1" stop-color="${C.cyan}"/></linearGradient>`;
  const body = `
<text x="40" y="78" font-size="12" fill="${C.text}">COMMITS BY HOUR <tspan fill="${C.dim}">(${esc(TZ)} · ${s.commits} commits, last 365d)</tspan></text>
${s.commits ? `<line x1="${peakX}" y1="${peakY - 8}" x2="${peakX}" y2="${peakY - 26}" stroke="${C.mag}"/>
<text x="${peakX}" y="${peakY - 32}" font-size="11" fill="${C.mag}" text-anchor="middle">PEAK ${pad2(peak)}:00</text>` : ''}
<line x1="${bx - 6}" y1="${by + 0.5}" x2="${bx + 24 * step}" y2="${by + 0.5}" stroke="${C.line}"/>
${bars}
<line x1="790" y1="62" x2="790" y2="350" stroke="${C.line}" stroke-dasharray="3 5"/>
<text x="${wx}" y="78" font-size="12" fill="${C.text}">CONTRIBUTIONS BY WEEKDAY</text>
${week}
<text x="${wx}" y="${wy + 7 * 30 + 26}" font-size="12" fill="${C.dim}">CHRONOTYPE ▸ <tspan fill="${C.green}" font-weight="700">${s.commits ? chronotype(s.hours) : 'CALIBRATING'}</tspan></text>`;
  return frame(w, h, 'ACTIVITY.LOG // WHEN I SHIP CODE', body, defs);
}

function languagesSvg(s) {
  const w = 1200;
  const top = s.languages.slice(0, 8);
  const rest = s.languages.slice(8).reduce((a, l) => a + l.pct, 0);
  if (rest > 0) top.push({ name: 'Other', color: C.dim, pct: rest });
  const rows = Math.ceil(top.length / 3);
  const h = 130 + rows * 28;
  const bx = 28, by = 64, bw = w - 56;
  let x = bx;
  const segs = top.map((l) => {
    const sw = (l.pct / 100) * bw;
    const r = `<rect x="${x}" y="${by}" width="${Math.max(sw - 2, 1)}" height="12" fill="${l.color}"/>`;
    x += sw;
    return r;
  }).join('');
  const legend = top.map((l, i) => {
    const lx = 28 + (i % 3) * 390, ly = by + 52 + Math.floor(i / 3) * 28;
    return `<g><circle cx="${lx + 6}" cy="${ly - 4}" r="5" fill="${l.color}" filter="url(#glow)"/>
  <text x="${lx + 20}" y="${ly}" font-size="13" fill="${C.text}">${esc(l.name)}</text>
  <text x="${lx + 360}" y="${ly}" font-size="13" fill="${C.dim}" text-anchor="end">${l.pct.toFixed(1)}%</text></g>`;
  }).join('\n');
  const body = `<clipPath id="lb"><rect x="${bx}" y="${by}" width="${bw}" height="12" rx="6"/></clipPath>
<rect x="${bx}" y="${by}" width="${bw}" height="12" rx="6" fill="${C.panel}"/>
<g clip-path="url(#lb)">${segs}</g>
${legend}`;
  return frame(w, h, 'STACK.SCAN // LANGUAGES BY BYTES (OWNED PUBLIC REPOS)', body);
}

function contribSvg(s) {
  const w = 1200, h = 250;
  const counts = s.days.map((d) => d.contributionCount).filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p) => counts[Math.floor((counts.length - 1) * p)] ?? 0;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const palette = ['#121a30', '#0b4a5a', '#0a8aa0', '#14c8e0', '#8ff6ff'];
  const level = (c) => (c === 0 ? 0 : c <= cuts[0] ? 1 : c <= cuts[1] ? 2 : c <= cuts[2] ? 3 : 4);
  const cell = 13, gap = 3, x0 = 64, y0 = 82;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  let lastMonth = -1;
  const cells = s.weeks.map((wk, wi) => {
    const first = wk.contributionDays[0];
    const m = Number(first.date.slice(5, 7)) - 1;
    let label = '';
    if (m !== lastMonth && wi < s.weeks.length - 2) {
      label = `<text x="${x0 + wi * (cell + gap)}" y="${y0 - 10}" font-size="10" fill="${C.dim}">${months[m]}</text>`;
      lastMonth = m;
    }
    return label + wk.contributionDays.map((d) => {
      const lv = level(d.contributionCount);
      return `<rect x="${x0 + wi * (cell + gap)}" y="${y0 + d.weekday * (cell + gap)}" width="${cell}" height="${cell}" rx="2.5" fill="${palette[lv]}"${lv === 4 ? ' filter="url(#glow)"' : ''}><title>${d.date}: ${d.contributionCount}</title></rect>`;
    }).join('');
  }).join('\n');
  const dayLabels = [[1, 'MON'], [3, 'WED'], [5, 'FRI']].map(([i, t]) =>
    `<text x="${x0 - 10}" y="${y0 + i * (cell + gap) + 10}" font-size="10" fill="${C.dim}" text-anchor="end">${t}</text>`).join('');
  const legendX = x0 + s.weeks.length * (cell + gap) - 5 * (cell + gap);
  const legend = palette.map((c, i) => `<rect x="${legendX + i * (cell + gap)}" y="${y0 + 7 * (cell + gap) + 8}" width="${cell}" height="${cell}" rx="2.5" fill="${c}"/>`).join('');
  const sx = 960;
  const side = [
    ['TOTAL / 1Y', num(s.totalContrib), C.cyan],
    ['BEST DAY', `${s.best.contributionCount} · ${s.best.date.slice(5)}`, C.mag],
    ['STREAK NOW', `${s.current}d`, C.green],
    ['LONGEST', `${s.longest}d`, C.amber],
  ].map(([k, v, c], i) => `<text x="${sx}" y="${y0 + 6 + i * 36}" font-size="10" fill="${C.dim}" letter-spacing="2">${k}</text>
<text x="${sx}" y="${y0 + 24 + i * 36}" font-size="17" font-weight="700" fill="${c}">${esc(v)}</text>`).join('\n');
  const body = `${cells}
${dayLabels}
<text x="${legendX - 8}" y="${y0 + 7 * (cell + gap) + 19}" font-size="10" fill="${C.dim}" text-anchor="end">LESS</text>
${legend}
<text x="${legendX + 5 * (cell + gap) + 4}" y="${y0 + 7 * (cell + gap) + 19}" font-size="10" fill="${C.dim}">MORE</text>
<line x1="${sx - 30}" y1="${y0 - 14}" x2="${sx - 30}" y2="${y0 + 7 * (cell + gap) + 20}" stroke="${C.line}" stroke-dasharray="3 5"/>
${side}`;
  return frame(w, h, 'CONTRIB.MATRIX // LAST 365 DAYS', body);
}

// --------------------------------------------------------------- readme ---

function readmeBlock(s) {
  const rows = s.recent.map((r) => {
    const lang = r.primaryLanguage?.name ?? '—';
    const desc = (r.description || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—';
    return `| [**${r.name}**](${r.url}) | ${desc} | \`${lang}\` | ★ ${r.stargazerCount} | ${r.pushedAt.slice(0, 10)} |`;
  });
  return [
    '<!-- PROFILE:START -->',
    '| Repository | Description | Lang | Stars | Last push |',
    '|:--|:--|:--:|:--:|:--:|',
    ...rows,
    '<!-- PROFILE:END -->',
  ].join('\n');
}

async function updateReadme(s) {
  const md = await readFile(README, 'utf8');
  const next = md.replace(/<!-- PROFILE:START -->[\s\S]*?<!-- PROFILE:END -->/, readmeBlock(s));
  if (next !== md) await writeFile(README, next);
}

// ----------------------------------------------------------------- main ---

const raw = await fetchAll();
const s = analyze(raw);
const avatar = await fetchAvatar(s.user.avatarUrl);
await mkdir(OUT, { recursive: true });
await Promise.all([
  writeFile(new URL('hero.svg', OUT), heroSvg(s, avatar)),
  writeFile(new URL('stats.svg', OUT), statsSvg(s)),
  writeFile(new URL('activity.svg', OUT), activitySvg(s)),
  writeFile(new URL('languages.svg', OUT), languagesSvg(s)),
  writeFile(new URL('contributions.svg', OUT), contribSvg(s)),
]);
await updateReadme(s);
console.log(`ok: ${s.publicRepos} public repos, ${s.totalContrib} contributions, ${s.commits} commits sampled, peak hour ${s.hours.indexOf(Math.max(...s.hours))}`);
