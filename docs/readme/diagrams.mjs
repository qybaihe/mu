// Draws the README's diagrams as SVG, one file per theme: node docs/readme/diagrams.mjs
// No dependencies. Text widths are estimated, so keep labels within the room each box gives them.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SANS = `-apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, &quot;Noto Sans&quot;, Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, &quot;SF Mono&quot;, Menlo, Consolas, &quot;Liberation Mono&quot;, monospace`;

/** GitHub's page colours for text and lines, with mu's violet (what acts) and pink (the judge). */
const THEMES = {
  dark: {
    text: '#f0f6fc',
    muted: '#b7bdc8',
    faint: '#8b949e',
    line: '#30363d',
    box: '#151b23',
    boxLine: '#3d444d',
    violet: '#ad9dff',
    violetFill: 'rgba(173, 157, 255, 0.08)',
    violetLine: 'rgba(173, 157, 255, 0.45)',
    pink: '#ff8ad8',
    pinkFill: 'rgba(255, 138, 216, 0.07)',
    pinkLine: 'rgba(255, 138, 216, 0.4)',
    ring: 'rgba(255, 138, 216, 0.25)',
  },
  light: {
    text: '#1f2328',
    muted: '#59636e',
    faint: '#818b98',
    line: '#d1d9e0',
    box: '#f6f8fa',
    boxLine: '#d1d9e0',
    violet: '#5b45db',
    violetFill: 'rgba(91, 69, 219, 0.05)',
    violetLine: 'rgba(91, 69, 219, 0.4)',
    pink: '#d6409f',
    pinkFill: 'rgba(238, 111, 191, 0.07)',
    pinkLine: 'rgba(214, 64, 159, 0.4)',
    ring: 'rgba(238, 111, 191, 0.22)',
  },
};

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function svg({ width, height, title, desc }, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="t d" font-family="${SANS}">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
${body.join('\n')}
</svg>
`;
}

const text = (x, y, value, { size = 13, weight = 400, fill, anchor = 'start', mono = false, spacing } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}"${weight !== 400 ? ` font-weight="${weight}"` : ''}${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${mono ? ` font-family="${MONO}"` : ''}${spacing ? ` letter-spacing="${spacing}"` : ''} fill="${fill}">${esc(value)}</text>`;

/** A mono micro-label, as the app's eyebrows are: small capitals, tracked. */
const label = (x, y, value, fill, anchor = 'start') =>
  text(x, y, value.toUpperCase(), { size: 10.5, weight: 600, fill, anchor, mono: true, spacing: '0.9' });

const rect = (x, y, w, h, { fill = 'none', stroke = 'none', r = 10, dash } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

/** The judge's mark: a small diamond with a faint ring. */
const diamond = (cx, cy, c, size = 6) =>
  `<rect x="${cx - size / 2}" y="${cy - size / 2}" width="${size}" height="${size}" rx="1" fill="${c.pink}" stroke="${c.ring}" stroke-width="2" transform="rotate(45 ${cx} ${cy})"/>`;

const arrowHead = (id, fill) =>
  `<marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="${fill}"/></marker>`;

const path = (d, stroke, { marker, dash, width = 1.4 } = {}) =>
  `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}${marker ? ` marker-end="url(#${marker})"` : ''}/>`;

// ── How a turn works ─────────────────────────────────────────────────────────

const STAGES = [
  {
    n: '01',
    name: 'A message arrives',
    when: 'before the model reads it',
    points: [
      ['input.preflight', 'what kind of task is this?'],
      ['task.frame', 'does the task change?'],
      ['input.interjection', 'interrupt now, or after?'],
      ['skills.disclosure', 'which skills to load?'],
      ['memory.recall', 'which lessons apply?'],
    ],
  },
  {
    n: '02',
    name: 'Before a tool runs',
    when: 'rules first, then the judge',
    points: [
      ['tool.risk', 'flagged: did you ask?'],
      ['tool.constraint', 'crosses your rule?'],
      ['tool.approval', 'does the task need it?'],
    ],
    note: ['Rules catch a risky command', 'first; the judge can only', 'vouch that you asked for it.'],
  },
  {
    n: '03',
    name: 'What comes back',
    when: 'before the model sees it',
    points: [
      ['tool.injection', 'orders aimed at the AI?'],
      ['tool.admission', 'does this chunk matter?'],
      ['context.forget', 'which results are stale?'],
      ['context.compact', 'keep this passage?'],
    ],
  },
  {
    n: '04',
    name: 'The turn ends',
    when: 'before you hear it’s done',
    points: [
      ['turn.completion', 'was it verified?'],
      ['turn.continue', 'did it stop short?'],
      ['turn.drift', 'still on the goal?'],
      ['memory.capture', 'a lesson to keep?'],
      ['cache.warming', 'back before it expires?'],
    ],
  },
];

function turn(c) {
  const W = 880;
  const H = 560;
  const gap = 16;
  const col = (W - gap * 3) / 4;
  const top = 116;
  const rowH = 46;
  const boxTop = top + 64;
  const boxH = 5 * rowH + 18;
  const out = [`<defs>${arrowHead('a', c.faint)}${arrowHead('v', c.violet)}</defs>`];
  out.push(text(0, 22, 'How a turn works', { size: 18, weight: 600, fill: c.text }));
  out.push(
    text(0, 46, 'At each step, a decision point asks the judge one short question. Its answer changes what happens next.', {
      size: 13.5,
      fill: c.muted,
    })
  );
  out.push(`<line x1="0" x2="${W}" y1="66" y2="66" stroke="${c.line}"/>`);

  // The model's loop over stages 02 and 03: call a tool, run it, read what came back, again.
  const x2 = col + gap;
  const x3 = 2 * (col + gap);
  out.push(
    path(`M${x3 + 40},${top - 4} C${x3 + 40},${top - 28} ${x2 + 40},${top - 28} ${x2 + 40},${top - 8}`, c.violet, { marker: 'v' })
  );
  out.push(label((x2 + x3 + 80) / 2, top - 30, 'the model loops: call · run · read', c.violet, 'middle'));

  STAGES.forEach((stage, index) => {
    const x = index * (col + gap);
    // The stage: its number, its name, and when it is asked.
    out.push(label(x, top + 14, stage.n, c.violet));
    out.push(text(x + 26, top + 15, stage.name, { size: 14.5, weight: 600, fill: c.text }));
    out.push(text(x, top + 38, stage.when, { size: 12.5, fill: c.muted }));
    if (index < STAGES.length - 1) {
      out.push(path(`M${x + col - 14},${top + 10} L${x + col + gap - 8},${top + 10}`, c.faint, { marker: 'a' }));
    }
    out.push(rect(x, boxTop, col, boxH, { fill: c.box, stroke: c.boxLine }));
    stage.points.forEach(([id, question], row) => {
      const y = boxTop + 14 + row * rowH;
      if (row > 0) out.push(`<line x1="${x + 12}" x2="${x + col - 12}" y1="${y - 8}" y2="${y - 8}" stroke="${c.line}"/>`);
      out.push(diamond(x + 18, y + 7, c, 5.5));
      out.push(text(x + 30, y + 11, id, { size: 12, fill: c.pink, mono: true }));
      out.push(text(x + 30, y + 29, question, { size: 12.5, fill: c.muted }));
    });
    if (stage.note) {
      stage.note.forEach((line, i) => {
        out.push(text(x + 14, boxTop + boxH - 50 + i * 18, line, { size: 12, fill: c.faint }));
      });
    }
    // Each stage asks the same judge.
    const from = boxTop + boxH;
    out.push(path(`M${x + col / 2},${from + 2} L${x + col / 2},${from + 28}`, c.pinkLine, { dash: '3 4' }));
  });

  const judgeTop = boxTop + boxH + 30;
  out.push(rect(0, judgeTop, W, 64, { fill: c.pinkFill, stroke: c.pinkLine, r: 12 }));
  out.push(diamond(24, judgeTop + 24, c, 8));
  out.push(text(40, judgeTop + 29, 'The judge', { size: 14.5, weight: 600, fill: c.text }));
  out.push(
    text(122, judgeTop + 29, 'Jev (hosted), Laya (local), a classifier or any LLM: one bounded question, about 0.3 s.', {
      size: 13,
      fill: c.muted,
    })
  );
  out.push(
    text(40, judgeTop + 49, 'Every verdict goes to the ledger with its probabilities. Without one, mu does what it would do without a judge.', {
      size: 12.5,
      fill: c.faint,
    })
  );
  out.push(text(0, H - 6, '18 of the 40 decision points. Each one is active, shadow (asked and logged only) or off.', { size: 12, fill: c.faint }));
  const points = STAGES.map((stage) => `${stage.name}, ${stage.when}: ${stage.points.map(([id, q]) => `${id} (${q})`).join(', ')}.`);
  return svg(
    {
      width: W,
      height: H,
      title: 'How a turn works',
      desc: `Four stages of a turn, each with the decision points it asks the judge. ${points.join(' ')} The model loops over stages 2 and 3: call a tool, run it, read what came back. Every stage asks the same judge: Jev, Laya, a classifier or any LLM, one bounded question in about 0.3 seconds, and every verdict goes to the ledger.`,
    },
    out
  );
}

// ── The pieces ───────────────────────────────────────────────────────────────

function pieces(c) {
  const W = 880;
  const H = 470;
  const out = [`<defs>${arrowHead('a', c.faint)}${arrowHead('p', c.pink)}</defs>`];
  out.push(text(0, 22, 'The pieces', { size: 18, weight: 600, fill: c.text }));
  out.push(text(0, 46, 'mu is pi with a judgment kernel loaded as an extension. The desktop app runs the same two.', { size: 13.5, fill: c.muted }));
  out.push(`<line x1="0" x2="${W}" y1="66" y2="66" stroke="${c.line}"/>`);

  // Where you work: the app and the command line.
  const front = 90;
  const frontW = 300;
  const fronts = [
    { x: 0, name: 'Desktop app', path: 'desktop/', note: 'runs pi in a utility process, over pi’s RPC' },
    { x: frontW + 24, name: 'mu command', path: 'kyrn/bin/mu.mjs', note: 'mu’s own commands, then starts pi' },
  ];
  for (const f of fronts) {
    out.push(rect(f.x, front, frontW, 62, { fill: c.box, stroke: c.boxLine }));
    out.push(text(f.x + 16, front + 25, f.name, { size: 14.5, weight: 600, fill: c.text }));
    out.push(text(f.x + frontW - 16, front + 25, f.path, { size: 11.5, fill: c.faint, mono: true, anchor: 'end' }));
    out.push(text(f.x + 16, front + 46, f.note, { size: 12.5, fill: c.muted }));
    out.push(path(`M${f.x + frontW / 2},${front + 64} L${f.x + frontW / 2},${front + 92}`, c.faint, { marker: 'a' }));
  }
  out.push(text(frontW * 2 + 48, front + 25, 'Sessions are pi’s files:', { size: 12.5, fill: c.muted }));
  out.push(text(frontW * 2 + 48, front + 44, 'the app and the command', { size: 12.5, fill: c.muted }));
  out.push(text(frontW * 2 + 48, front + 63, 'line share them.', { size: 12.5, fill: c.muted }));

  // pi, with the kernel inside it.
  const core = front + 98;
  const coreW = frontW * 2 + 24;
  const coreH = 168;
  out.push(rect(0, core, coreW, coreH, { fill: c.box, stroke: c.boxLine, r: 12 }));
  out.push(text(16, core + 26, 'pi', { size: 14.5, weight: 600, fill: c.text }));
  out.push(text(36, core + 26, '· the coding agent', { size: 13, fill: c.muted }));
  out.push(text(coreW - 16, core + 26, 'packages/{ai,agent,coding-agent,tui}', { size: 11.5, fill: c.faint, mono: true, anchor: 'end' }));
  const parts = ['agent loop', 'tools', 'sessions', 'providers'];
  let px = 16;
  for (const part of parts) {
    const w = part.length * 7.4 + 22;
    out.push(rect(px, core + 40, w, 24, { stroke: c.boxLine, r: 6 }));
    out.push(text(px + w / 2, core + 56, part, { size: 12, fill: c.muted, anchor: 'middle' }));
    px += w + 8;
  }
  // The kernel: what mu adds.
  const kx = 16;
  const ky = core + 76;
  const kw = coreW - 32;
  out.push(rect(kx, ky, kw, 78, { fill: c.violetFill, stroke: c.violetLine, r: 10 }));
  out.push(text(kx + 14, ky + 22, 'judgment kernel', { size: 14, weight: 600, fill: c.violet }));
  out.push(text(kx + kw - 14, ky + 22, 'packages/kyrn-judge', { size: 11.5, fill: c.faint, mono: true, anchor: 'end' }));
  const kernel = [
    ['features', 'hooked into pi’s events'],
    ['decision engine', 'modes, judges, fallbacks'],
    ['ledger', 'every verdict, kept'],
  ];
  const kcol = (kw - 28) / 3;
  kernel.forEach(([name, what], i) => {
    const x = kx + 14 + i * kcol;
    out.push(text(x, ky + 46, name, { size: 12.5, weight: 600, fill: c.text }));
    out.push(text(x, ky + 64, what, { size: 12, fill: c.muted }));
  });

  // The main model, to the right of pi.
  const mx = coreW + 48;
  const mw = W - mx;
  out.push(rect(mx, core, mw, 76, { fill: c.box, stroke: c.boxLine }));
  out.push(text(mx + 16, core + 26, 'The main model', { size: 14.5, weight: 600, fill: c.text }));
  out.push(text(mx + 16, core + 46, 'any provider pi supports,', { size: 12.5, fill: c.muted }));
  out.push(text(mx + 16, core + 64, 'by key or subscription', { size: 12.5, fill: c.muted }));
  out.push(path(`M${coreW + 2},${core + 40} L${mx - 4},${core + 40}`, c.faint, { marker: 'a' }));

  // The judges, under the kernel's engine.
  const jy = core + coreH + 34;
  out.push(path(`M${kx + 14 + kcol * 1.5},${ky + 80} L${kx + 14 + kcol * 1.5},${jy - 4}`, c.pink, { marker: 'p', dash: '3 4' }));
  out.push(label(0, jy - 12, 'Judges, by decision point or in tiers', c.faint));
  const judges = [
    ['Jev', 'hosted · probabilities'],
    ['Laya', 'local · offline'],
    ['classifier:', '<provider>/<model>'],
    ['llm:', '<provider>/<model>'],
  ];
  const jw = (W - 3 * 12) / 4;
  judges.forEach(([name, what], i) => {
    const x = i * (jw + 12);
    out.push(rect(x, jy, jw, 52, { fill: c.pinkFill, stroke: c.pinkLine }));
    out.push(diamond(x + 18, jy + 19, c, 6));
    const mono = name.endsWith(':');
    out.push(text(x + 32, jy + 23, name, { size: mono ? 12.5 : 14, weight: mono ? 400 : 600, fill: c.text, mono }));
    out.push(text(x + 32, jy + 41, what, { size: 12, fill: c.muted, mono }));
  });
  return svg(
    {
      width: W,
      height: H,
      title: 'The pieces',
      desc: 'The desktop app (desktop/, which runs pi in a utility process over pi’s RPC protocol) and the mu command (kyrn/bin/mu.mjs) both start pi, the coding agent: its agent loop, tools, sessions and providers. Inside pi runs the judgment kernel (packages/kyrn-judge): features that hook pi’s events and act on verdicts, a decision engine with modes, judges and fallbacks, and a ledger of every verdict in the session. pi calls the main model, any provider it supports. The engine asks the judges: Jev (hosted, with probabilities), Laya (local, offline), any classifier model or any LLM.',
    },
    out
  );
}

// ── A decision, end to end ───────────────────────────────────────────────────

const STEPS = [
  ['A feature hooks an event', 'web_fetch returns a page', 'pi event'],
  ['It asks a decision point', 'small state, bounded question', 'tool.injection'],
  ['The engine picks a judge', 'mode, tiers, a fallback', 'tiers: laya,jev'],
  ['The judge answers', 'yes 0.97 · in 0.3 s', 'verdict'],
  ['The ledger records it', 'answers, latency, usage', 'kyrn.decision'],
  ['The feature acts', 'the passage is withheld', 'active mode'],
];

function decision(c) {
  const W = 880;
  const H = 268;
  const out = [`<defs>${arrowHead('a', c.faint)}</defs>`];
  out.push(text(0, 22, 'A decision, end to end', { size: 18, weight: 600, fill: c.text }));
  out.push(text(0, 46, 'tool.injection screening a web page for instructions aimed at the AI.', { size: 13.5, fill: c.muted }));
  out.push(`<line x1="0" x2="${W}" y1="66" y2="66" stroke="${c.line}"/>`);
  const gap = 18;
  const w = (W - gap * 5) / 6;
  const y = 92;
  STEPS.forEach(([name, what, tag], i) => {
    const x = i * (w + gap);
    const judge = i === 3;
    out.push(rect(x, y, w, 128, { fill: judge ? c.pinkFill : c.box, stroke: judge ? c.pinkLine : c.boxLine }));
    out.push(label(x + 12, y + 22, String(i + 1).padStart(2, '0'), c.violet));
    if (judge) out.push(diamond(x + w - 18, y + 18, c, 6));
    const words = name.split(' ');
    const half = Math.ceil(words.length / 2);
    out.push(text(x + 12, y + 46, words.slice(0, half).join(' '), { size: 13.5, weight: 600, fill: c.text }));
    out.push(text(x + 12, y + 64, words.slice(half).join(' '), { size: 13.5, weight: 600, fill: c.text }));
    out.push(text(x + 12, y + 88, what.length > 20 ? what.slice(0, what.lastIndexOf(' ', 20)) : what, { size: 12, fill: c.muted }));
    if (what.length > 20) out.push(text(x + 12, y + 104, what.slice(what.lastIndexOf(' ', 20) + 1), { size: 12, fill: c.muted }));
    out.push(text(x + 12, y + 120, tag, { size: 11, fill: judge || i === 1 ? c.pink : c.faint, mono: true }));
    if (i < STEPS.length - 1) out.push(path(`M${x + w + 2},${y + 64} L${x + w + gap - 3},${y + 64}`, c.faint, { marker: 'a' }));
  });
  out.push(text(0, H - 24, 'In shadow mode it stops at 05: the verdict is recorded and nothing changes.', { size: 12, fill: c.faint }));
  out.push(text(0, H - 6, 'No verdict (slow, down or unsure): the fallback, what mu would do without a judge, and the ledger says why.', { size: 12, fill: c.faint }));
  return svg(
    {
      width: W,
      height: H,
      title: 'A decision, end to end',
      desc: 'Six steps, with tool.injection screening a web page as the example. 1: a feature hooks a pi event (web_fetch returns a page). 2: it asks a decision point, tool.injection, with a small state and a bounded question. 3: the engine checks the point’s mode and picks a judge from its tiers (for example laya, then jev), with a fallback. 4: the judge answers, for example yes with probability 0.97 in 0.3 seconds. 5: the ledger records the verdict, its answers, latency and usage as a kyrn.decision entry. 6: in active mode the feature acts and the passage is withheld; in shadow mode it stops at step 5. Without a verdict, mu takes the fallback and the ledger says why.',
    },
    out
  );
}

// ── Judges in tiers ──────────────────────────────────────────────────────────

function tiers(c) {
  const W = 880;
  const H = 330;
  const out = [`<defs>${arrowHead('a', c.faint)}${arrowHead('p', c.pink)}</defs>`];
  out.push(text(0, 22, 'Judges in tiers', { size: 18, weight: 600, fill: c.text }));
  out.push(
    text(0, 46, 'A cascade such as laya,jev: each judge only sees the questions the one before it wasn’t sure about.', {
      size: 13.5,
      fill: c.muted,
    })
  );
  out.push(`<line x1="0" x2="${W}" y1="66" y2="66" stroke="${c.line}"/>`);

  const y = 104;
  const h = 84;
  const boxes = [
    { x: 0, w: 150, name: 'Questions', lines: ['one or many,', 'from a decision point'], judge: false },
    { x: 214, w: 190, name: 'Laya', lines: ['local, offline, no cost', 'trusted on classifying'], judge: true },
    { x: 468, w: 190, name: 'Jev', lines: ['hosted, about 0.3 s', 'trusted on every kind'], judge: true },
    { x: 722, w: 158, name: 'The fallback', lines: ['what mu would do', 'without a judge'], judge: false },
  ];
  for (const b of boxes) {
    out.push(rect(b.x, y, b.w, h, { fill: b.judge ? c.pinkFill : c.box, stroke: b.judge ? c.pinkLine : c.boxLine }));
    if (b.judge) out.push(diamond(b.x + 18, y + 24, c, 6));
    out.push(text(b.x + (b.judge ? 32 : 16), y + 29, b.name, { size: 14.5, weight: 600, fill: c.text }));
    b.lines.forEach((line, i) => out.push(text(b.x + 16, y + 52 + i * 18, line, { size: 12.5, fill: c.muted })));
  }
  // Between the boxes: what passes on.
  const pass = [
    [150, 214, 'all'],
    [404, 468, 'unsure'],
    [658, 722, 'unsure'],
  ];
  for (const [from, to, what] of pass) {
    out.push(path(`M${from + 4},${y + h / 2} L${to - 5},${y + h / 2}`, c.faint, { marker: 'a' }));
    out.push(text((from + to) / 2, y + h / 2 - 8, what, { size: 11.5, fill: c.faint, anchor: 'middle', mono: true }));
  }
  // What a judge is sure of is settled there and goes to the ledger.
  const rail = y + h + 64;
  for (const b of boxes.filter((box) => box.judge)) {
    out.push(path(`M${b.x + b.w / 2},${y + h + 4} L${b.x + b.w / 2},${rail - 6}`, c.pink, { marker: 'p' }));
    out.push(text(b.x + b.w / 2 + 8, y + h + 36, 'sure: a verdict', { size: 12, fill: c.pink }));
  }
  out.push(path(`M${722 + 79},${y + h + 4} L${722 + 79},${rail - 6}`, c.faint, { marker: 'a' }));
  out.push(rect(200, rail, W - 200, 34, { fill: c.box, stroke: c.boxLine, r: 8 }));
  out.push(text(216, rail + 22, 'The ledger: every answer, which judge gave it or why the fallback was used, and the time.', { size: 12.5, fill: c.muted }));

  // The probability band a yes/no answer is read with.
  const bx = 0;
  const bw = 170;
  const by = rail + 4;
  out.push(label(bx, by + 2, 'Unsure means', c.faint));
  const x2 = bx + bw * 0.2;
  const x8 = bx + bw * 0.8;
  out.push(rect(bx, by + 12, bw, 8, { fill: c.box, stroke: c.boxLine, r: 4 }));
  out.push(rect(x2, by + 12, x8 - x2, 8, { fill: c.pinkFill, stroke: c.pinkLine, r: 0 }));
  out.push(text(x2, by + 34, '0.2', { size: 11, fill: c.faint, anchor: 'middle', mono: true }));
  out.push(text(x8, by + 34, '0.8', { size: 11, fill: c.faint, anchor: 'middle', mono: true }));
  out.push(
    text(0, H - 6, 'A judge’s known weakness never decides: Laya isn’t trusted on relating, scoring or meta-judgments, so those go on to Jev.', {
      size: 12,
      fill: c.faint,
    })
  );
  return svg(
    {
      width: W,
      height: H,
      title: 'Judges in tiers',
      desc: 'A cascade such as laya,jev. All questions go to Laya first: local, offline and free, trusted on classifying. What Laya is sure of becomes a verdict; a yes/no answer is unsure when its probability is between 0.2 and 0.8, and unsure questions go on to Jev, hosted, about 0.3 seconds. What Jev is sure of becomes a verdict; what is still unsure, or what no judge answered, gets the fallback: what mu would do without a judge. The ledger records every answer, which judge gave it or why the fallback was used, and the time. Laya is not trusted on relating, scoring or meta-judgments, so those questions go on to Jev.',
    },
    out
  );
}

for (const [name, draw] of Object.entries({ turn, pieces, decision, tiers })) {
  for (const [theme, colours] of Object.entries(THEMES)) {
    writeFileSync(join(HERE, `${name}-${theme}.svg`), draw(colours));
  }
}
console.log('wrote turn, pieces, decision and tiers, dark and light');
