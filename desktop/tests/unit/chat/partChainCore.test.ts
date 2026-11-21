/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The part chain as the name-parsing + note-links choice proves it
 * (SPEC-P6 M2/M3): membership by position marker and claimed `(part N)`
 * suffix, the clean-named live part only via a note's exact edge, and every
 * ambiguous shape degrading to no badge rather than a wrong row.
 */
import { describe, expect, it } from 'vitest';
import {
  partChainOf,
  type ChainConversation,
  type PartChainLink,
} from '@/common/chat/team/contextSteward/partChainCore';

const conv = (id: string, name: string, position: string | undefined, modified = 1): ChainConversation => ({
  id,
  name,
  modified_at: modified,
  extra: position ? { position } : undefined,
});

// The canonical after-one-switch shape: old renamed '(part 1)', fresh part clean-named.
const ONE_SWITCH: ChainConversation[] = [
  conv('old', '货代 (part 1)', 'forwarder', 10),
  conv('fresh', '货代', 'forwarder', 20),
  conv('other', '别的岗', 'video-lab', 30),
  conv('plain', '普通会话', undefined, 40),
];
const LINK_1: PartChainLink[] = [{ fromConversationId: 'old', toConversationId: 'fresh', part: 1 }];

describe('partChainOf', () => {
  it('proves the fresh part part 2 from the note edge, and lists both parts in order', () => {
    const chain = partChainOf({ conversations: ONE_SWITCH, conversationId: 'fresh', links: LINK_1 });
    expect(chain).toBeDefined();
    expect(chain?.ownPart).toBe(2);
    expect(chain?.entries.map((entry) => [entry.conversationId, entry.part])).toEqual([
      ['old', 1],
      ['fresh', 2],
    ]);
    expect(chain?.entries.find((entry) => entry.conversationId === 'fresh')?.isCurrent).toBe(true);
  });

  it('proves the old part part 1 from its own suffix, with the link adding the clean-named successor', () => {
    const chain = partChainOf({ conversations: ONE_SWITCH, conversationId: 'old', links: LINK_1 });
    expect(chain?.ownPart).toBe(1);
    expect(chain?.entries.map((entry) => entry.conversationId)).toEqual(['old', 'fresh']);
  });

  it('a titled part keeps its own badge even with no notes left, but the clean-named sibling needs its edge', () => {
    // Evicted receipts: viewing the old part, its title still proves part 1;
    // the fresh part's clean name proves nothing without the note edge.
    expect(partChainOf({ conversations: ONE_SWITCH, conversationId: 'old' })).toBeUndefined();
    const family: ChainConversation[] = [
      conv('p1', '货代 (part 1)', 'forwarder', 10),
      conv('p2', '货代 (part 2)', 'forwarder', 20),
    ];
    expect(partChainOf({ conversations: family, conversationId: 'p1' })?.entries.map((e) => e.part)).toEqual([1, 2]);
  });

  it('answers undefined for a clean-named part with no note — nothing proves its history', () => {
    expect(partChainOf({ conversations: ONE_SWITCH, conversationId: 'fresh' })).toBeUndefined();
  });

  it('answers undefined outside the steward constituency and for unknown ids', () => {
    expect(partChainOf({ conversations: ONE_SWITCH, conversationId: 'plain', links: LINK_1 })).toBeUndefined();
    expect(partChainOf({ conversations: ONE_SWITCH, conversationId: 'missing' })).toBeUndefined();
  });

  it('scopes the chain to one position marker — a same-name other-position part never joins', () => {
    const scoped = [
      ...ONE_SWITCH,
      conv('elsewhere', '货代 (part 1)', 'video-lab', 50),
      conv('elsewhere-2', '货代', 'video-lab', 60),
    ];
    const chain = partChainOf({ conversations: scoped, conversationId: 'old', links: LINK_1 });
    expect(chain?.entries.map((entry) => entry.conversationId)).toEqual(['old', 'fresh']);
  });

  it('excludes a same-position different-base suffix and a different base name', () => {
    const noise = [
      ...ONE_SWITCH,
      conv('noise-1', '货代·报表 (part 1)', 'forwarder', 70),
      conv('noise-2', '完全不同', 'forwarder', 80),
    ];
    const chain = partChainOf({ conversations: noise, conversationId: 'old', links: LINK_1 });
    expect(chain?.baseName).toBe('货代');
    expect(chain?.entries.map((entry) => entry.conversationId)).toEqual(['old', 'fresh']);
  });

  it('a lone part 1 with nothing to navigate to is not a chain worth a badge', () => {
    const lone = [conv('old', '货代 (part 1)', 'forwarder'), conv('plain', '普通', undefined)];
    expect(partChainOf({ conversations: lone, conversationId: 'old' })).toBeUndefined();
  });

  it('a lone successor-less part 2 still badges — the chain says where history lives', () => {
    const lone = [conv('only', '货代', 'forwarder')];
    const chain = partChainOf({
      conversations: lone,
      conversationId: 'only',
      links: [{ fromConversationId: 'gone', toConversationId: 'only', part: 1 }],
    });
    expect(chain?.ownPart).toBe(2);
    expect(chain?.entries).toHaveLength(1);
  });

  it('chains a titled family across several switches (1, 2, 3) without any notes', () => {
    const family = [
      conv('p1', '货代 (part 1)', 'forwarder', 10),
      conv('p2', '货代 (part 2)', 'forwarder', 20),
      conv('p3', '货代', 'forwarder', 30),
    ];
    // Viewing the titled parts: title claims suffice; the clean p3 needs its edge.
    expect(partChainOf({ conversations: family, conversationId: 'p2' })?.entries.map((e) => e.part)).toEqual([1, 2]);
    const withLinks: PartChainLink[] = [
      { fromConversationId: 'p1', toConversationId: 'p2', part: 1 },
      { fromConversationId: 'p2', toConversationId: 'p3', part: 2 },
    ];
    const chain = partChainOf({ conversations: family, conversationId: 'p3', links: withLinks });
    expect(chain?.ownPart).toBe(3);
    expect(chain?.entries.map((e) => e.part)).toEqual([1, 2, 3]);
  });

  it('links of other chains say nothing about this one', () => {
    const links: PartChainLink[] = [{ fromConversationId: 'a', toConversationId: 'b', part: 5 }];
    expect(partChainOf({ conversations: ONE_SWITCH, conversationId: 'old', links })).toBeUndefined();
    expect(partChainOf({ conversations: ONE_SWITCH, conversationId: 'fresh', links })).toBeUndefined();
  });
});
