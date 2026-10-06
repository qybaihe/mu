import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { beeRole, beeWho } from '@/renderer/pages/conversation/KyrnPanel/Hive/HiveToolCard';
import type { HiveBee } from '@/common/kyrn/hive';

const t = ((key: string) => `<${key}>`) as unknown as TFunction;

describe('a sub-agent’s role', () => {
  it('says a role that ships with mu in the reader’s language, and one of the person’s own as it is named', () => {
    expect(beeRole(t, 'investigator')).toBe('<common.kyrn.roles.investigator>');
    expect(beeRole(t, 'worker')).toBe('<common.kyrn.roles.worker>');
    expect(beeRole(t, 'db-migrator')).toBe('db-migrator');
    expect(beeWho(t, { role: 'scout' } as HiveBee)).toBe('<common.kyrn.roles.scout>');
  });
});
