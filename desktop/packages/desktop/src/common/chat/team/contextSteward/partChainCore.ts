/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The part chain's pure half (SPEC-P6 M2/M3): which conversations are one
 * position's part chain, and where each part sits in it.
 *
 * CHOICE — name parsing over a separate index file: the steward itself names
 * every switch (`(part N)`, contextStewardCore.partNamingFor), the name lives
 * server-side so it survives localStorage eviction and machine switches, and
 * no second source of truth can drift out of sync with the conversations it
 * describes. The exact edge between two adjacent parts comes from the ⚡
 * notes' `counterpartId` when present (contextStewardNotes.contextStewardChainLinks).
 * The honest weaknesses, accepted: a conversation that merely shares the base
 * name joins the chain's dropdown (kept rare by scoping to one position
 * marker — only the steward's constituency has chains at all), a user rename
 * drops a part from the dropdown, and an index file would fix both — at the
 * cost of main-process file state that a lost write silently corrupts. Every
 * failure mode here degrades to a shorter dropdown; a jump only ever follows
 * a listed conversation id.
 */

/** One conversation as the chain reads it — the history list's rows. */
export type ChainConversation = { id: string; name: string; modified_at?: number; extra?: unknown };

/** One exact adjacency a switch/continuation note recorded: `from` is the part renamed `(part N)`, `to` the fresh one. */
export type PartChainLink = { fromConversationId: string; toConversationId: string; part: number };

/** One member of a chain, as the badge's dropdown lists it. */
export type PartChainEntry = {
  conversationId: string;
  title: string;
  part: number;
  modifiedAt: number;
  isCurrent: boolean;
};

/** A conversation's chain: the base name, which part this conversation is, and every member in order. */
export type PartChain = { baseName: string; ownPart: number; entries: PartChainEntry[] };

const positionOf = (conversation: ChainConversation): string | undefined => {
  const extra = conversation.extra as Record<string, unknown> | null | undefined;
  return typeof extra?.position === 'string' && extra.position ? extra.position : undefined;
};

/**
 * The chain one conversation belongs to, or undefined when it has no part
 * history the app can prove: no `(part N)` in its own title and no note
 * saying where it continued from. Members are the same-position,
 * same-base-name conversations (the title's suffix is the claim), plus
 * anything the notes' exact links connect — the fresh part carries the clean
 * name, so only a link can vouch for it.
 */
export function partChainOf(input: {
  conversations: ReadonlyArray<ChainConversation>;
  conversationId: string;
  links?: ReadonlyArray<PartChainLink>;
}): PartChain | undefined {
  const current = input.conversations.find((item) => item.id === input.conversationId);
  if (!current) return undefined;
  const position = positionOf(current);
  if (!position) return undefined; // Only the steward's constituency — position conversations — has chains.

  const suffix = parseSuffix(current.name);
  const base = suffix?.base ?? current.name.trim();
  if (!base) return undefined;

  // The clean-named part is part N+1 of what its continuation note names; a
  // titled part is what its own suffix says.
  let ownPart = suffix?.part;
  if (ownPart === undefined) {
    let continuedFrom: number | undefined;
    for (const link of input.links ?? []) {
      if (link.toConversationId === input.conversationId) {
        continuedFrom = Math.max(continuedFrom ?? 0, link.part);
      }
    }
    if (continuedFrom === undefined) return undefined;
    ownPart = continuedFrom + 1;
  }

  const members = new Map<string, { title: string; part: number; modifiedAt: number }>();
  members.set(current.id, { title: current.name, part: ownPart, modifiedAt: current.modified_at ?? 0 });

  for (const conversation of input.conversations) {
    if (conversation.id === current.id) continue;
    if (positionOf(conversation) !== position) continue;
    const claimed = parseSuffix(conversation.name);
    if (claimed?.base !== base) continue; // A different base name is a different chain (or no chain at all).
    members.set(conversation.id, {
      title: conversation.name,
      part: claimed.part,
      modifiedAt: conversation.modified_at ?? 0,
    });
  }

  // The exact edges can vouch for members the titles cannot: the fresh part
  // (clean name, maybe renamed since) and a renamed predecessor.
  for (const link of input.links ?? []) {
    const edges: Array<[string, number]> = [
      [link.fromConversationId, link.part],
      [link.toConversationId, link.part + 1],
    ];
    const touchesCurrent = edges.some(([id]) => id === current.id);
    if (!touchesCurrent) continue; // A link between two other chains says nothing about this one.
    for (const [id, part] of edges) {
      if (id === current.id || members.has(id)) continue;
      const found = input.conversations.find((item) => item.id === id);
      if (!found || positionOf(found) !== position) continue;
      members.set(id, { title: found.name, part, modifiedAt: found.modified_at ?? 0 });
    }
  }

  const entries = [...members.entries()]
    .map<PartChainEntry>(([id, member]) => ({
      conversationId: id,
      title: member.title,
      part: member.part,
      modifiedAt: member.modifiedAt,
      isCurrent: id === current.id,
    }))
    .toSorted((a, b) => a.part - b.part || b.modifiedAt - a.modifiedAt);

  // A lone `part 1` with nothing to navigate to is not a chain worth a badge:
  // its successor is gone and the row itself is already the archive.
  if (entries.length < 2 && ownPart < 2) return undefined;
  return { baseName: base, ownPart, entries };
}

/** Same suffix rule as the steward's naming — kept here so the chain and the renamer can never disagree. */
const parseSuffix = (name: string): { base: string; part: number } | undefined => {
  const trimmed = name.trim();
  const found = /\s*\(part (\d+)\)\s*$/.exec(trimmed);
  if (!found) return undefined;
  const base = trimmed.slice(0, found.index).trim();
  return base ? { base, part: Number.parseInt(found[1], 10) } : undefined;
};
