import { describe, expect, it } from 'vitest';
import { truncateMenuLabel } from '@/process/utils/tray';
import i18n, { changeLanguage } from '@/process/services/i18n';

describe('truncateMenuLabel', () => {
  it('leaves a short title alone', () => {
    expect(truncateMenuLabel('Fix the login bug', 32)).toBe('Fix the login bug');
  });

  it('cuts a long title and ends it with a single ellipsis character', () => {
    const label = truncateMenuLabel('Refactor the conversation history loader for speed', 20);
    expect(label.endsWith('…')).toBe(true);
    expect(label.endsWith('...')).toBe(false);
    expect(Array.from(label)).toHaveLength(20);
  });

  it('counts wide characters double, so a Chinese title is not twice as wide', () => {
    const label = truncateMenuLabel('重构会话历史加载器以提升启动速度并减少内存', 20);
    // Nine two-column characters plus the one-column ellipsis fit in 20 columns.
    expect(label).toBe('重构会话历史加载器…');
  });

  it('never cuts inside an emoji or a surrogate pair', () => {
    const family = '👨‍👩‍👧';
    const label = truncateMenuLabel(`${family}${family}${family}${family}`, 5);
    expect(label).toBe(`${family}${family}…`);
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('tray running-tasks label', () => {
  it('is one sentence with the language’s own punctuation', async () => {
    await changeLanguage('zh-CN');
    expect(i18n.t('common.trayMenu.runningTasks', { count: 3 })).toBe('运行中的任务：3');
    await changeLanguage('en-US');
    expect(i18n.t('common.trayMenu.runningTasks', { count: 3 })).toBe('Running tasks: 3');
  });
});
