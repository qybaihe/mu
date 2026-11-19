/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The position roster, pure: parsing the user's position library
 * (`~/.mu/agent/agents/*.md`, read-only — the library is the user's,
 * desktop never writes it), the ownership-gate text injected into a position
 * conversation's workspace (the task-ownership gate, plus the wrap-up
 * fallback rules — append this task's lessons to the position's project-root
 * HANDOFF.md — and the new-project/new-position dedup gate), and finding a
 * position's persistent conversation by its `extra.position` marker. All IO
 * lives in the service and the roster hook; everything here is data in,
 * data out.
 *
 * A position's optional frontmatter `display_name` is the user-facing alias
 * (Chinese, say); every internal key — the `extra.position` marker, the
 * workspace folder, TEAMS.md — stays the frontmatter `name`, and matching
 * texts spell both (`货代`).
 */

/** One position of the user's position library, as the roster shows it. */
export type PositionInfo = {
  /** Frontmatter `name`, also the roster key and the workspace folder name. */
  name: string;
  /**
   * Frontmatter `display_name`, falling back to `name`: what every
   * user-facing surface shows, while `name` stays the internal identity
   * (`extra.position`, workspace folder, TEAMS.md keys).
   */
  displayName: string;
  /** Frontmatter `description`; the gate's ownership-matching reference. */
  description: string;
  /** The position's project root, from the body's `项目根：` line, when present. */
  projectRoot?: string;
  /** The body below the frontmatter: the position's own instructions. */
  body: string;
};

/** The conversation-extra key that binds a conversation to one position. */
export const POSITION_EXTRA_KEY = 'position';

/** Files that are never positions, whatever their frontmatter says. */
const NON_POSITION_FILES = new Set(['readme.md']);

/** Frontmatter delimiters: `---\n…\n---` at the very start of the file. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** A frontmatter line: `key: value`. */
const FRONTMATTER_LINE_RE = /^([A-Za-z_-]+):\s*(.*)$/;

/** The body line naming the project root: 「项目根：`E:/x/y`（注释）」. */
const PROJECT_ROOT_RE = /项目根[：:]\s*`([^`]+)`/;

const asTrimmedString = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * One library file as a position, or undefined when the file is not one: a
 * position must carry a `name` and a `description` in its frontmatter (the
 * worker/planner subagent stubs do; a stray note usually does not), and
 * `README.md` is documentation, not a position.
 */
export function parsePositionDocument(fileName: string, content: string): PositionInfo | undefined {
  if (NON_POSITION_FILES.has(fileName.toLowerCase())) return undefined;
  const frontmatter = FRONTMATTER_RE.exec(content);
  if (!frontmatter) return undefined;

  const fields = new Map<string, string>();
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = FRONTMATTER_LINE_RE.exec(line);
    if (match) fields.set(match[1], match[2]);
  }

  const name = asTrimmedString(fields.get('name'));
  const description = asTrimmedString(fields.get('description'));
  if (!name || !description) return undefined;

  const body = content.slice(frontmatter[0].length).trim();
  const projectRoot = asTrimmedString(PROJECT_ROOT_RE.exec(content)?.[1]);
  const displayName = asTrimmedString(fields.get('display_name')) ?? name;
  return { name, displayName, description, projectRoot, body };
}

/**
 * The position's name as matching texts spell it: the display name with the
 * id beside it when the two differ (`货代`), so a model matches the task
 * either way; the bare id when they do not.
 */
export const positionLabel = (position: Pick<PositionInfo, 'name' | 'displayName'>): string =>
  position.displayName === position.name ? position.name : `${position.displayName}(${position.name})`;

/** The roster line for one position: labeled name plus description, the gate's reference. */
const rosterLine = (position: PositionInfo): string => `- ${positionLabel(position)} — ${position.description}`;

/** The paragraph every position conversation opens with: who this bot is, and the gate. */
export function buildPositionOverrideContent(position: PositionInfo, roster: readonly PositionInfo[]): string {
  const lines = [
    '<!-- mu-desktop position workspace (generated). This file is rewritten by the app; edits are lost. -->',
    `# 岗位：${positionLabel(position)}`,
    '',
    `你是「${position.displayName}」岗位的一对一负责 Bot。本会话由 mu 桌面版岗位名册开启，你的身份与任务归属规则如下。`,
    '',
    '## 任务归属判定（硬规则，优先于其他一切指示）',
    '收到任何任务时，先依据「本岗说明书」与下方「全岗名册」判定该任务是否属于本岗职责：',
    '1. **属于本岗** → 先过下方「按需组队前置判定」，再按本岗说明书开工。',
    `2. **不属于本岗** → 立即停止，不执行任何实际工作、不读写文件、不调用工具；只回复一句话：此任务不属于本岗（${positionLabel(position)}），建议交给 X 岗，并附一句理由（X 从名册中按描述匹配最相关的岗位）。`,
    '3. **归属不明** → 优先按名册描述匹配最接近的岗位并按第 2 条回复；名册中确实没有匹配岗位时，才询问用户要不要仍由本岗处理。',
    '',
    '## 按需组队前置判定（硬规则，优先于本岗说明书中任何跨岗分工/派发条款）',
    '**规则 0（无条件第一个动作）**：任务判定属于本岗后、开始任何实际工作（读文件/write/bash 业务命令/delegate/subagent 一律算）之前，先做一次协作判定：本任务是否**点名其他岗位**（如「由评审岗复核」「交给视频实验室岗」），或**需要其他岗位的技能/项目上下文**（单岗做不了或明显做差）？',
    '- **是（涉及其他岗位）** → 本会话的第一个动作必须是 `node teams.cjs match --positions <岗位英文id列表，含本岗>`（如 forwarder,reviewer；传中文名也会自动对齐），在 match 运行之前禁止调用任何其他工具。输出 `MATCH <队名>` → 复用：把任务原文写入 `task.txt`，运行 `node teams.cjs send --team <队名> --file task.txt`（send 自动刷新 7 天生命周期）。输出 `NONE` → 建队：`node teams.cjs add --name <中文短语队名> --positions <岗位英文id列表，本岗排第一>`（第一岗位任 lead），成功后按上条 send 发任务。派出后只回复用户：已交给团队 <队名>（成员岗位），进展与分工可点侧栏「<队名>（群聊）」会话查看，不在本会话重复汇报团队内细节。脚本输出 `ERROR …`：原样贴出并停下等用户指示，禁止手工编辑 TEAMS.md、禁止自己拼 curl 重试。',
    '- **否（本岗可独立完成）** → 按本岗说明书正常执行，不建队；能单岗干完且未点名其他岗位的任务建队＝违规。',
    '**禁止绕道（硬规则）**：本岗说明书里若有「跨岗派发/分工，用 subagent/delegate 派给其他岗位」类指引，一律改按本节执行：凡要把工作交给**其他岗位**，只能用 teams.cjs 组队/复用，不得用 subagent/delegate 工具直接派给其他岗位——那是不可见通道，用户看不到岗位间真实分工。subagent/delegate 只用于本岗内部的通用辅助角色（worker 类），不是任何名册岗位的替身。',
    'teams.cjs 与 TEAMS.md 由桌面版维护，只能通过脚本读写；全岗与主管共享同一团队索引。',
    '',
    '## 本岗说明书（用户岗位库原文）',
    position.body || '（本岗未提供说明书正文）',
    '',
    '## 任务收尾回落（硬规则）',
    '任务完成、向用户回报结果之前，必须把本任务产生的经验/教训/可复用资产落账，不许只留在对话里：',
    '1. 本岗说明书含「项目根」→ 把一条记录**追加**写入该项目根的 `HANDOFF.md`（文件不存在则创建）。格式：一行标题 `## <YYYY-MM-DD> · <任务一句话>`，随后 2-5 行要点，末行 `LESSON: <一句可复用教训或坑>`（确实无可提炼时写 `LESSON: 无`）。**只追加，禁止删改该文件既有内容**。',
    '2. 本岗无「项目根」→ 落账到本次任务的工作目录（产出所在目录）的 `HANDOFF.md`（同格式）；任务没有明确工作目录时，在回报中说明不落账的原因。',
    '3. 可复用技术资产（脚本/报告/样张等文件）放项目约定目录：项目已有 `tmp/`、`docs/` 等结构则随项目结构；否则在项目根建 `tmp/` 存放，不散落。',
    '',
    '## 新项目与新岗位去重（硬规则，宁少勿滥）',
    '收到「新建一个 XX 项目」「注册一个新岗位」类要求时，先对照下方「全岗名册」逐岗比对任务域与职责描述，再行动：',
    '- 与既有岗职责重合 → **不新建**：任务归入该岗既有项目承接（或建议用户转交该岗），回复中说明归并理由（点名重合的岗位与重合点）。',
    '- 确属名册都覆盖不了的新领域 → 才可新建项目目录；完成时必须在新项目目录内写 `AGENTS.md`（项目说明+本次任务记忆+经验教训三节）与 `HANDOFF.md`（首条记录，用上节格式），让项目自带上下文。',
    '- 「项目即岗位」的注册同样先过此去重；本会话**不得创建或改写任何岗位库文件**，只做判定与建议，建不建由用户决定。',
    '',
    '## 全岗名册（归属判定与转交建议的参照）',
    ...roster.map(rosterLine),
    '',
    '名册仅用于归属判定、转交建议与新建去重：只读、不得自行创建新岗位，也不得在本会话中改写任何岗位库文件。',
    '',
  ];
  return lines.join('\n');
}

/** The conversation a position's 1:1 session lives in, by `extra.position`; newest wins on duplicates. */
export function findPositionConversationId(
  conversations: ReadonlyArray<{ id: string; modified_at?: number; extra?: unknown }>,
  positionName: string
): string | undefined {
  let found: { id: string; modified: number } | undefined;
  for (const conversation of conversations) {
    const extra = conversation.extra as Record<string, unknown> | null | undefined;
    if (extra?.[POSITION_EXTRA_KEY] !== positionName) continue;
    if (!found || (conversation.modified_at ?? 0) >= found.modified) {
      found = { id: conversation.id, modified: conversation.modified_at ?? 0 };
    }
  }
  return found?.id;
}
