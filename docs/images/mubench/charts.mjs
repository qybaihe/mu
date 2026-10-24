// Draws the mubench 1.0 charts as SVG for the README and usemu.dev/mubench/: node docs/images/mubench/charts.mjs
//
// The numbers come from site/content/mubench.json, the page's own data; the names of the capabilities and models
// and the footnotes from site/i18n/{en,zh-CN}.json, so the charts say what the page says. One file per chart,
// language (en, zh), theme (light, dark) and width: 880 for the README and wide screens, -narrow (360) for phones.
// No dependencies. Text widths are estimated, so keep labels within the room each part gives them.
// png/ holds 2x renders of the wide charts for places that take no SVG: Chromium, on each theme's page colour
// (#ffffff, #0e0e10), reduced to 256 colours. Render them again after a change here.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '../../../site');
const bench = JSON.parse(readFileSync(join(SITE, 'content/mubench.json'), 'utf8'));
const I18N = {
  en: JSON.parse(readFileSync(join(SITE, 'i18n/en.json'), 'utf8')).mubench,
  zh: JSON.parse(readFileSync(join(SITE, 'i18n/zh-CN.json'), 'utf8')).mubench,
};

const SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif`;
const MONO = `"SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, "Liberation Mono", monospace`;

/** usemu.dev's text and line tokens (site/static/site.base.css), and one colour per model from mu's pink and violet
 * ramps (the desktop app's mu-color-scheme.css), stepped per theme so each clears its background. */
const THEMES = {
  light: {
    surface: '#ffffff', text: '#1d1b22', muted: '#5f5f6b', faint: '#8e8e99', line: '#e5e6eb', lineStrong: '#d5d6dc',
    box: '#f5f5f7', mark: '#a23bb2',
    models: { 'mude-1.0': '#b42d86', 'jev-1.14': '#5b45db', 'jev-1.13': '#a99bf7', 'd3-nano': '#6a6a73' },
  },
  dark: {
    surface: '#0e0e10', text: '#f2f2f4', muted: '#a6a6b0', faint: '#777782', line: '#26262c', lineStrong: '#34343c',
    box: '#141417', mark: '#e29bee',
    models: { 'mude-1.0': '#d63fa2', 'jev-1.14': '#8f7cf7', 'jev-1.13': '#5f52b8', 'd3-nano': '#8b8b96' },
  },
};
/** The site's accent: pink to lavender. */
const ACCENT = ['#f8d3ef', '#dccdfd', '#cdc5fb'];

const WORDS = {
  en: {
    composite_title: 'mubench 1.0 · main board: overall score',
    composite_sub: '{items} requests mu sent to decision models in real coding sessions on open-source repositories, from {tasks} tasks. The thin lines are 95% intervals.',
    constructed_title: 'mubench 1.0 · sub-board: constructed scenarios',
    constructed_sub: '{items} scenarios written for mubench, scored the same way and never added to the main board. The thin lines are 95% intervals.',
    axis: '0 = mu with no decision model · 100 = all of the cost it pays removed',
    caps_title: 'mubench 1.0 · main board: eight capabilities',
    caps_sub: 'The score in each capability, on {items} requests from real coding sessions on open-source repositories. 0 = mu with no decision model; 100 = all of the cost it pays removed.',
    threat_cell: 'Mostly constructed items; not scored yet.',
    clipped: 'Bars below −25 are cut short; the number on the right is the score.',
    acc_title: 'mubench 1.0 · decision accuracy',
    acc_sub: 'The share of checks each model gets right, next to mu with no decision model. Every check counts the same, whatever its mistakes cost. The small numbers are the gain in points; the thin lines are 95% intervals.',
    acc_real: 'Main board · {items} requests from real coding sessions',
    acc_constructed: 'Sub-board · {items} constructed scenarios',
    scoring_title: 'How mubench scores a decision model',
    steps: [
      ['A real request', 'What mu asked a decision model in a real coding session on an open-source repository, kept word for word as an item.'],
      ['The decision', 'The model under test answers it: run a command or ask first, keep a result or drop it, call a turn done or not.'],
      ['Its consequences', 'The answer is scored by the cost of what it leads to. A costly mistake weighs more than a cheap one.'],
      ['Against no decision model', 'That cost is compared with what mu does with no decision model: 0 is no better, 100 removes all of it.'],
    ],
  },
  zh: {
    composite_title: 'mubench 1.0 主榜：综合分',
    composite_sub: '{items} 道请求，都是 mu 在开源仓库上的真实编程会话里发给决策模型的，来自 {tasks} 个任务。细线是 95% 区间。',
    constructed_title: 'mubench 1.0 副榜：构造场景',
    constructed_sub: '{items} 个为 mubench 编写的场景，计分方法相同，不并入主榜。细线是 95% 区间。',
    axis: '0 = 不用决策模型的 mu · 100 = 它付出的代价全部消除',
    caps_title: 'mubench 1.0 主榜：八项能力',
    caps_sub: '每项能力的分数，来自开源仓库上真实编程会话里的 {items} 道请求。0 = 不用决策模型的 mu；100 = 它付出的代价全部消除。',
    threat_cell: '以构造题为主，目前还不出分。',
    clipped: '低于 −25 的柱子截断显示，右侧数字是实际分数。',
    acc_title: 'mubench 1.0 决策正确率',
    acc_sub: '每个模型答对的检查项占比，和不用决策模型的 mu 对比。每个检查项分量相同，不管答错的代价多大。小字是提高的百分点，细线是 95% 区间。',
    acc_real: '主榜 · 真实编程会话里的 {items} 道请求',
    acc_constructed: '副榜 · {items} 个构造场景',
    scoring_title: 'mubench 怎么给决策模型打分',
    steps: [
      ['真实请求', 'mu 在开源仓库上的真实编程会话里问决策模型的问题，一字不改，收作一道题。'],
      ['决策', '被测模型作答：命令直接跑还是先问，结果留下还是丢掉，这一轮算不算完成。'],
      ['后果', '答案按它带来的后果的代价计分，代价大的错误分量更重。'],
      ['对照不用决策模型', '这份代价和不用决策模型时的 mu 相比：0 分是一样，100 分是全部消除。'],
    ],
  },
};

// ── Drawing helpers ──────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (n) => Math.round(n * 10) / 10;
const fmt = (v) => v.toFixed(1).replace('-', '−');
const fill = (s, values) => s.replace(/\{(\w+)\}/g, (_, k) => values[k]);

/** An estimate of a string's width in pixels, a little over what Chromium measures with the system fonts; wide
 * (CJK) characters count a full em. */
function width(s, size, weight = 400) {
  let em = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x2e80 && c <= 0xffef && !(c >= 0x2010 && c <= 0x2027)) em += 1;
    else if (/[0-9]/.test(ch)) em += 0.58;
    else if (/[A-Z]/.test(ch)) em += 0.66;
    else if (/[mw]/.test(ch)) em += 0.82;
    else if (/[ijlft.,:;'|!]/.test(ch)) em += 0.28;
    else if (ch === ' ') em += 0.28;
    else if (ch === '—' || ch === '%') em += 0.88;
    else if (ch === '−' || ch === '–' || ch === '=') em += 0.58;
    else em += 0.54;
  }
  return em * size * (weight >= 600 ? 1.1 : 1.06);
}

/** Lines of at most maxWidth: Latin words stay whole, CJK breaks between characters, and closing punctuation
 * never starts a line. */
function wrap(s, maxWidth, size, weight = 400) {
  const tokens = s.match(/[⺀-￯]|[^\s⺀-￯]+|\s+/g) || [];
  const lines = [];
  let line = '';
  for (const t of tokens) {
    const next = line + t;
    const closing = /^[，。；：、）」』！？,.;:)]/.test(t);
    if (line && !closing && width(next.trimEnd(), size, weight) > maxWidth) {
      lines.push(line.trimEnd());
      line = /^\s+$/.test(t) ? '' : t;
    } else line = next;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

/** A line of text. halo draws a ring of the background under it, so it stays readable across grid lines; mark
 * adds a raised footnote mark after it. */
function text(x, y, value, { size = 13, weight = 400, fill: color, anchor = 'start', mono = false, nums = false, spacing, halo, mark } = {}) {
  const tail = mark ? `<tspan dx="2" dy="-4" font-size="${size - 1}" font-weight="700" fill="${mark.color}">${esc(mark.text)}</tspan>` : '';
  return `<text x="${r1(x)}" y="${r1(y)}" font-size="${size}"${weight !== 400 ? ` font-weight="${weight}"` : ''}${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${mono ? ` font-family='${MONO}'` : ''}${spacing ? ` letter-spacing="${spacing}"` : ''}${nums ? ' style="font-variant-numeric: tabular-nums"' : ''}${halo ? ` stroke="${halo}" stroke-width="4" stroke-linejoin="round" paint-order="stroke"` : ''} fill="${color}">${esc(value)}${tail}</text>`;
}

/** Wrapped text, one <text> per line; returns [svg, the baseline of the last line]. */
function para(x, y, s, maxWidth, opts, lineHeight) {
  const lines = wrap(s, maxWidth, opts.size, opts.weight);
  return [lines.map((l, i) => text(x, y + i * lineHeight, l, opts)).join('\n'), y + (lines.length - 1) * lineHeight];
}

const line = (x1, y1, x2, y2, stroke, w = 1, extra = '') =>
  `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="${stroke}" stroke-width="${w}"${extra}/>`;

/** A bar from the zero line to x, 4px round at the data end and square at the baseline. */
function bar(x0, x, y, h, color) {
  const r = Math.min(4, Math.abs(x - x0) / 2, h / 2);
  if (Math.abs(x - x0) < 0.5) return '';
  const d = x >= x0
    ? `M${r1(x0)},${r1(y)} H${r1(x - r)} Q${r1(x)},${r1(y)} ${r1(x)},${r1(y + r)} V${r1(y + h - r)} Q${r1(x)},${r1(y + h)} ${r1(x - r)},${r1(y + h)} H${r1(x0)} Z`
    : `M${r1(x0)},${r1(y)} H${r1(x + r)} Q${r1(x)},${r1(y)} ${r1(x)},${r1(y + r)} V${r1(y + h - r)} Q${r1(x)},${r1(y + h)} ${r1(x + r)},${r1(y + h)} H${r1(x0)} Z`;
  return `<path d="${d}" fill="${color}"/>`;
}

/** The judge's mark on usemu.dev: a small diamond. */
const diamond = (cx, cy, color, size = 7) =>
  `<rect x="${r1(cx - size / 2)}" y="${r1(cy - size / 2)}" width="${size}" height="${size}" rx="1.2" fill="${color}" transform="rotate(45 ${r1(cx)} ${r1(cy)})"/>`;

function svg(w, h, title, desc, body, defs = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${Math.ceil(h)}" viewBox="0 0 ${w} ${Math.ceil(h)}" role="img" aria-labelledby="t d" font-family='${SANS}'>
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
${defs ? `<defs>${defs}</defs>\n` : ''}${body.filter(Boolean).join('\n')}
</svg>
`;
}

/** Each model's name on the page (d3-nano (original)), and a short one for tight rows (d3-nano). */
const models = (lang) => bench.models.map((m) => ({ id: m.id, name: I18N[lang].names[m.id] || m.name, short: m.name }));
const nf = (n) => n.toLocaleString('en-US');

// ── Overall score, with 95% intervals ────────────────────────────────────────

function composite(key, lang, theme, narrow) {
  const c = THEMES[theme];
  const W = WORDS[lang];
  const B = I18N[lang];
  const board = bench.boards[key].overall;
  const rows = models(lang).sort((a, b) => board.scores[b.id] - board.scores[a.id]);
  const title = W[`${key === 'real' ? 'composite' : 'constructed'}_title`];
  const sub = fill(W[`${key === 'real' ? 'composite' : 'constructed'}_sub`], { items: nf(board.items), tasks: board.tasks });
  const Wd = narrow ? 360 : 880;
  const body = [];
  let [t, y] = para(0, 22, title, Wd, { size: narrow ? 15 : 17, weight: 650, fill: c.text }, narrow ? 21 : 24);
  body.push(t);
  [t, y] = para(0, y + (narrow ? 24 : 26), sub, Wd, { size: narrow ? 12.5 : 13, fill: c.muted }, 19);
  body.push(t);

  const x0 = narrow ? 6 : 168;
  const plot = narrow ? 222 : 540;
  const sx = (v) => x0 + (v / 100) * plot;
  const pitch = narrow ? 50 : 40;
  const barH = 18;
  const top = y + (narrow ? 26 : 30);
  const count = rows.length + 1;
  const bottom = top + count * pitch - (pitch - barH) + 6;
  for (const v of [0, 25, 50, 75, 100]) body.push(line(sx(v), top - 8, sx(v), bottom, v === 0 ? c.lineStrong : c.line));
  rows.forEach((m, i) => {
    const by = top + i * pitch + (narrow ? 8 : 0);
    const v = board.scores[m.id];
    const [lo, hi] = board.ci[m.id];
    if (narrow) body.push(text(0, by - 6, m.name, { size: 13, weight: 600, fill: c.text, halo: c.surface }));
    else body.push(text(x0 - 14, by + barH / 2 + 4.5, m.name, { size: 14, weight: 600, fill: c.text, anchor: 'end' }));
    body.push(bar(x0, sx(v), by, barH, c.models[m.id]));
    const cy = by + barH / 2;
    body.push(line(sx(lo), cy, sx(hi), cy, c.text, 1.5, ' stroke-linecap="round" opacity="0.8"'));
    body.push(line(sx(lo), cy - 5, sx(lo), cy + 5, c.text, 1.5, ' stroke-linecap="round" opacity="0.8"'));
    body.push(line(sx(hi), cy - 5, sx(hi), cy + 5, c.text, 1.5, ' stroke-linecap="round" opacity="0.8"'));
    const vx = Math.max(sx(hi), sx(v)) + 12;
    body.push(text(vx, cy + 5, fmt(v), { size: narrow ? 14 : 15, weight: 650, fill: c.text, nums: true }));
    body.push(text(vx + width(fmt(v), narrow ? 14 : 15, 650) + 8, cy + 4.5, `${fmt(lo)}–${fmt(hi)}`, { size: narrow ? 11.5 : 12.5, fill: c.faint, nums: true }));
  });
  // The floor: mu with no decision model scores 0 by definition.
  const fy = top + rows.length * pitch + (narrow ? 8 : 0);
  if (narrow) body.push(text(0, fy - 6, B.zero_row, { size: 13, weight: 500, fill: c.muted, halo: c.surface }));
  else body.push(text(x0 - 14, fy + barH / 2 + 4.5, B.zero_row, { size: 14, weight: 500, fill: c.muted, anchor: 'end' }));
  body.push(diamond(x0, fy + barH / 2, c.faint, 8));
  body.push(text(x0 + 14, fy + barH / 2 + 5, '0', { size: narrow ? 14 : 15, weight: 650, fill: c.muted, nums: true }));
  const ty = bottom + 18;
  for (const v of narrow ? [0, 50, 100] : [0, 25, 50, 75, 100]) {
    body.push(text(sx(v), ty, String(v), { size: 11.5, fill: c.faint, anchor: 'middle', nums: true }));
  }
  [t, y] = para(narrow ? 0 : x0, ty + 22, W.axis, narrow ? Wd : Wd - x0, { size: 12.5, fill: c.muted }, 18);
  body.push(t);
  const desc = `${sub} ${rows.map((m) => `${m.name}: ${fmt(board.scores[m.id])} (95% ${fmt(board.ci[m.id][0])}–${fmt(board.ci[m.id][1])})`).join('; ')}; ${B.zero_row}: 0. ${W.axis}`;
  return svg(Wd, y + 10, title, desc, body);
}

// ── Eight capabilities ───────────────────────────────────────────────────────

function capabilities(lang, theme, narrow) {
  const c = THEMES[theme];
  const W = WORDS[lang];
  const B = I18N[lang];
  const board = bench.boards.real;
  const few = bench.few;
  const order = models(lang).sort((a, b) => board.overall.scores[b.id] - board.overall.scores[a.id]);
  const Wd = narrow ? 360 : 880;
  const body = [];
  let [t, y] = para(0, 22, W.caps_title, Wd, { size: narrow ? 15 : 17, weight: 650, fill: c.text }, narrow ? 21 : 24);
  body.push(t);
  [t, y] = para(0, y + (narrow ? 24 : 26), fill(W.caps_sub, { items: nf(board.overall.items) }), Wd, { size: narrow ? 12.5 : 13, fill: c.muted }, 19);
  body.push(t);

  // The legend: every model by its colour, with its name.
  let lx = 0;
  let ly = y + 30;
  for (const m of order) {
    const w = 16 + width(m.name, 12.5) + 18;
    if (lx + w > Wd) { lx = 0; ly += 22; }
    body.push(`<rect x="${lx}" y="${r1(ly - 9.5)}" width="10" height="10" rx="3" fill="${c.models[m.id]}"/>`);
    body.push(text(lx + 16, ly, m.name, { size: 12.5, fill: c.text }));
    lx += w;
  }

  const cols = narrow ? 1 : 2;
  const gap = 56;
  const PW = narrow ? Wd : (Wd - gap) / 2;
  const labelW = narrow ? 64 : 76;
  const valueW = narrow ? 52 : 56;
  const plot = PW - labelW - 10 - valueW;
  const lo = -25;
  const pitch = narrow ? 20 : 21;
  const barH = 12;
  const headH = 28;
  const PH = headH + order.length * pitch + 20;
  const top = ly + 30;
  const caps = Object.keys(bench.capabilities);
  let maxY = top;
  let ny = top;
  let clipped = false;
  const isFew = (cell) => cell.scores && (cell.items < few.items || (cell.tasks ?? few.tasks) < few.tasks || (cell.baseline ?? 0) > few.baseline);
  caps.forEach((cap, i) => {
    const cell = board[cap];
    // Two columns of panels on a wide chart, one on a narrow one, where a capability with no score takes less room.
    const px = narrow ? 0 : (i % cols) * (PW + gap);
    const py = narrow ? ny : top + Math.floor(i / cols) * (PH + 18);
    ny += (cell.scores ? PH : headH + 44) + 14;
    const mark = cap === 'threat' ? '†' : isFew(cell) ? '*' : '';
    body.push(text(px, py + 14, B.caps[cap], { size: 13.5, weight: 650, fill: c.text, mark: mark && { text: mark, color: c.mark } }));
    const x0 = px + labelW + 10 + ((0 - lo) / (100 - lo)) * plot;
    const sx = (v) => px + labelW + 10 + ((Math.max(v, lo) - lo) / (100 - lo)) * plot;
    const ry = py + headH;
    const rowsH = order.length * pitch;
    if (!cell.scores) {
      body.push(line(px, ry - 4, px + PW, ry - 4, c.line));
      const [nt] = para(px, narrow ? ry + 18 : ry + rowsH / 2 - 2, `—   ${W.threat_cell}`, PW, { size: 12.5, fill: c.muted }, 18);
      body.push(nt);
      maxY = Math.max(maxY, narrow ? py + headH + 44 : py + PH);
      return;
    }
    for (const v of [0, 50, 100]) body.push(line(sx(v), ry - 4, sx(v), ry + rowsH - 4, v === 0 ? c.lineStrong : c.line));
    order.forEach((m, k) => {
      const by = ry + k * pitch;
      const v = cell.scores[m.id];
      body.push(text(px + labelW, by + barH - 1.5, m.short, { size: 11.5, fill: c.muted, anchor: 'end' }));
      body.push(bar(x0, sx(v), by, barH, c.models[m.id]));
      if (v < lo) {
        clipped = true;
        // A cut bar: two slashes in the background colour near its end.
        const ex = sx(v);
        for (const dx of [7, 12]) body.push(line(ex + dx, by + barH + 1, ex + dx + 4, by - 1, c.surface, 2));
      }
      body.push(text(px + PW, by + barH - 1.5, fmt(v), { size: 12, weight: 600, fill: c.text, anchor: 'end', nums: true }));
    });
    const ty = ry + rowsH + 10;
    for (const v of [0, 50, 100]) body.push(text(sx(v), ty, String(v), { size: 10, fill: c.faint, anchor: 'middle', nums: true }));
    maxY = Math.max(maxY, py + PH);
  });
  const notes = [
    `* ${fill(B.note_few, { items: few.items, tasks: few.tasks, baseline: few.baseline })}`,
    `† ${B.note_threat}`,
    ...(clipped ? [W.clipped] : []),
  ];
  y = maxY;
  for (const n of notes) {
    [t, y] = para(0, y + 22, n, Wd, { size: 12, fill: c.muted }, 17);
    body.push(t);
  }
  const desc = `${fill(W.caps_sub, { items: nf(board.overall.items) })} ${caps.map((cap) => `${B.caps[cap]}: ${board[cap].scores ? order.map((m) => `${m.name} ${fmt(board[cap].scores[m.id])}`).join(', ') : W.threat_cell}`).join('. ')}.`;
  return svg(Wd, y + 6, W.caps_title, desc, body);
}

// ── Decision accuracy, against mu with no decision model ─────────────────────

function accuracy(lang, theme, narrow) {
  const c = THEMES[theme];
  const W = WORDS[lang];
  const B = I18N[lang];
  const Wd = narrow ? 360 : 880;
  const body = [];
  let [t, y] = para(0, 22, W.acc_title, Wd, { size: narrow ? 15 : 17, weight: 650, fill: c.text }, narrow ? 21 : 24);
  body.push(t);
  [t, y] = para(0, y + (narrow ? 24 : 26), W.acc_sub, Wd, { size: narrow ? 12.5 : 13, fill: c.muted }, 19);
  body.push(t);
  const gap = 56;
  const PW = narrow ? Wd : (Wd - gap) / 2;
  const pct = (v) => `${v.toFixed(1)}%`;
  const gain = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
  const descParts = [];
  let bottom = y;
  ['real', 'constructed'].forEach((key, i) => {
    const o = bench.boards[key].overall;
    const order = models(lang).sort((a, b) => o.scores[b.id] - o.scores[a.id]);
    // The first row is mu with no decision model; the bars under it are what a decision model adds.
    const rows = [{ id: 'baseline', name: B.zero_row, v: o.baseline, ci: o.acc_ci.baseline }, ...order.map((m) => ({ ...m, v: o.acc[m.id], ci: o.acc_ci[m.id] }))];
    const px = narrow ? 0 : i * (PW + gap);
    let py = narrow ? bottom + (i ? 30 : 30) : y + 30;
    const [ht, hy] = para(px, py + 14, fill(W[`acc_${key}`], { items: nf(o.items) }), PW, { size: 13.5, weight: 650, fill: c.text }, 19);
    body.push(ht);
    py = hy + 18;
    const labelW = Math.min(narrow ? 120 : 132, Math.max(...rows.map((r) => width(r.name, 12.5, r.id === 'baseline' ? 400 : 600))));
    const valueW = narrow ? 96 : 104;
    const x0 = px + labelW + 10;
    const plot = PW - labelW - 10 - valueW;
    const sx = (v) => x0 + (v / 100) * plot;
    const pitch = 30;
    const barH = 16;
    const rowsH = rows.length * pitch - (pitch - barH);
    for (const v of [0, 50, 100]) body.push(line(sx(v), py - 6, sx(v), py + rowsH + 6, v === 0 ? c.lineStrong : c.line));
    rows.forEach((r, k) => {
      const by = py + k * pitch;
      const cy = by + barH / 2;
      const base = r.id === 'baseline';
      body.push(text(x0 - 10, cy + 4.5, r.name, { size: 12.5, weight: base ? 400 : 600, fill: base ? c.muted : c.text, anchor: 'end' }));
      if (base) {
        body.push(`<rect x="${r1(x0)}" y="${r1(by + 0.75)}" width="${r1(sx(r.v) - x0 - 0.75)}" height="${barH - 1.5}" rx="3" fill="${c.box}" stroke="${c.faint}" stroke-width="1.5"/>`);
      } else {
        body.push(bar(x0, sx(r.v), by, barH, c.models[r.id]));
      }
      const [lo, hi] = r.ci;
      for (const [a, b2, d] of [[lo, hi, 0], [lo, lo, 4], [hi, hi, 4]]) {
        body.push(line(sx(a), cy - d, sx(b2), cy + d, c.text, 1.5, ' stroke-linecap="round" opacity="0.8"'));
      }
      const vx = Math.max(sx(hi), sx(r.v)) + 9;
      body.push(text(vx, cy + 4.5, pct(r.v), { size: 13, weight: 650, fill: base ? c.muted : c.text, nums: true }));
      if (!base) body.push(text(vx + width(pct(r.v), 13, 650) + 6, cy + 4, gain(r.v - o.baseline), { size: 11.5, fill: c.faint, nums: true }));
      descParts.push(`${r.name} ${pct(r.v)} (95% ${pct(lo)}–${pct(hi)})`);
    });
    const ty = py + rowsH + 22;
    for (const v of [0, 50, 100]) body.push(text(sx(v), ty, `${v}%`, { size: 10.5, fill: c.faint, anchor: 'middle', nums: true }));
    bottom = Math.max(bottom, ty);
  });
  const desc = `${W.acc_sub} ${descParts.join('; ')}.`;
  return svg(Wd, bottom + 10, W.acc_title, desc, body);
}

// ── How it scores ────────────────────────────────────────────────────────────

function glyph(i, x, y, c, gid) {
  // Each step's small picture, about 64 x 36, top-left at (x, y).
  if (i === 0) {
    return [
      `<rect x="${x}" y="${y}" width="64" height="34" rx="9" fill="none" stroke="${c.lineStrong}" stroke-width="1.2"/>`,
      line(x + 11, y + 12, x + 50, y + 12, c.faint, 2.5, ' stroke-linecap="round"'),
      line(x + 11, y + 22, x + 38, y + 22, c.faint, 2.5, ' stroke-linecap="round"'),
    ].join('\n');
  }
  if (i === 1) {
    return [
      diamond(x + 10, y + 17, c.mark, 10),
      `<rect x="${x + 26}" y="${y + 3}" width="38" height="12" rx="6" fill="url(#${gid})"/>`,
      `<rect x="${x + 26}" y="${y + 20}" width="38" height="12" rx="6" fill="none" stroke="${c.lineStrong}" stroke-width="1.2"/>`,
    ].join('\n');
  }
  if (i === 2) {
    return [
      bar(x, x + 22, y + 4, 8, c.faint),
      bar(x, x + 60, y + 20, 8, c.mark),
      line(x, y, x, y + 32, c.lineStrong, 1.2),
    ].join('\n');
  }
  return [
    line(x, y + 22, x + 64, y + 22, c.lineStrong, 1.2),
    line(x, y + 16, x, y + 28, c.lineStrong, 1.2),
    line(x + 64, y + 16, x + 64, y + 28, c.lineStrong, 1.2),
    diamond(x, y + 22, c.faint, 7),
    `<circle cx="${x + 46}" cy="${y + 22}" r="5" fill="${c.mark}" stroke="${c.surface}" stroke-width="2"/>`,
    text(x, y + 8, '0', { size: 10, fill: c.faint, anchor: 'middle', mono: true }),
    text(x + 64, y + 8, '100', { size: 10, fill: c.faint, anchor: 'middle', mono: true }),
  ].join('\n');
}

function scoring(lang, theme, narrow) {
  const c = THEMES[theme];
  const W = WORDS[lang];
  const Wd = narrow ? 360 : 880;
  const gid = `accent-${theme}`;
  const defs = `<linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">${ACCENT.map((s, i) => `<stop offset="${[0, 0.55, 1][i]}" stop-color="${s}"/>`).join('')}</linearGradient>`;
  const body = [];
  let [t, y] = para(0, 22, W.scoring_title, Wd, { size: narrow ? 15 : 17, weight: 650, fill: c.text }, 21);
  body.push(t);
  const top = y + 22;
  const arrow = (x1, y1, x2, y2) => [
    line(x1, y1, x2, y2, c.faint, 1.4),
    x2 > x1
      ? `<path d="M${r1(x2 - 6)},${r1(y2 - 4.5)} L${r1(x2)},${r1(y2)} L${r1(x2 - 6)},${r1(y2 + 4.5)}" fill="none" stroke="${c.faint}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="M${r1(x2 - 4.5)},${r1(y2 - 6)} L${r1(x2)},${r1(y2)} L${r1(x2 + 4.5)},${r1(y2 - 6)}" fill="none" stroke="${c.faint}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  ].join('\n');
  if (!narrow) {
    const gap = 36;
    const BW = (Wd - gap * 3) / 4;
    // Every box starts its text at the same height: below the longest title.
    const titleLines = Math.max(...W.steps.map(([h]) => wrap(h, BW - 36, 15, 650).length));
    const descTop = 136 + (titleLines - 1) * 20;
    const BH = descTop + (Math.max(...W.steps.map(([, p]) => wrap(p, BW - 34, 12.5).length)) - 1) * 18 + 24;
    W.steps.forEach(([h, p], i) => {
      const x = i * (BW + gap);
      const last = i === W.steps.length - 1;
      body.push(`<rect x="${r1(x + 0.75)}" y="${r1(top + 0.75)}" width="${r1(BW - 1.5)}" height="${BH - 1.5}" rx="14" fill="${c.box}" stroke="${last ? `url(#${gid})` : c.line}" stroke-width="1.5"/>`);
      body.push(text(x + 18, top + 28, `0${i + 1}`, { size: 11, fill: c.faint, mono: true, spacing: '0.5' }));
      body.push(glyph(i, x + 18, top + 44, c, gid));
      body.push(para(x + 18, top + 112, h, BW - 36, { size: 15, weight: 650, fill: c.text }, 20)[0]);
      const [pt] = para(x + 18, top + descTop, p, BW - 34, { size: 12.5, fill: c.muted }, 18);
      body.push(pt);
      if (!last) body.push(arrow(x + BW + 8, top + BH / 2, x + BW + gap - 8, top + BH / 2));
    });
    y = top + BH;
  } else {
    const gap = 30;
    let by = top;
    W.steps.forEach(([h, p], i) => {
      const last = i === W.steps.length - 1;
      const lines = wrap(p, Wd - 36 - 90, 12.5);
      const BH = Math.max(96, 54 + lines.length * 18 + 14);
      body.push(`<rect x="0.75" y="${r1(by + 0.75)}" width="${Wd - 1.5}" height="${r1(BH - 1.5)}" rx="14" fill="${c.box}" stroke="${last ? `url(#${gid})` : c.line}" stroke-width="1.5"/>`);
      body.push(text(18, by + 26, `0${i + 1}`, { size: 11, fill: c.faint, mono: true, spacing: '0.5' }));
      body.push(text(48, by + 27, h, { size: 15, weight: 650, fill: c.text }));
      body.push(lines.map((l, k) => text(18, by + 52 + k * 18, l, { size: 12.5, fill: c.muted })).join('\n'));
      body.push(glyph(i, Wd - 18 - 64, by + 46, c, gid));
      if (!last) body.push(arrow(Wd / 2, by + BH + 6, Wd / 2, by + BH + gap - 6));
      by += BH + gap;
    });
    y = by - gap;
  }
  const desc = W.steps.map(([h, p], i) => `${i + 1}. ${h}: ${p}`).join(' ');
  return svg(Wd, y + 4, W.scoring_title, desc, body, defs);
}

// ── Write ────────────────────────────────────────────────────────────────────

const written = [];
for (const lang of ['en', 'zh']) {
  for (const theme of ['light', 'dark']) {
    for (const narrow of [false, true]) {
      const end = `${lang}-${theme}${narrow ? '-narrow' : ''}.svg`;
      const files = {
        [`composite-${end}`]: composite('real', lang, theme, narrow),
        [`constructed-${end}`]: composite('constructed', lang, theme, narrow),
        [`capabilities-${end}`]: capabilities(lang, theme, narrow),
        [`accuracy-${end}`]: accuracy(lang, theme, narrow),
        [`scoring-${end}`]: scoring(lang, theme, narrow),
      };
      for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(HERE, name), body);
        written.push(name);
      }
    }
  }
}
console.log(`${written.length} charts in ${HERE}`);
