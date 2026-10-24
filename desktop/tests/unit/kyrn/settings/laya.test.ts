import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLaya, layaInOrder, orderWithoutLaya, within } from '@/process/agent/kyrn/config/laya';

/** Laya, the local judge mu no longer has, as an older mu left it in mu.json, read the way mu moves the file on. */

afterEach(() => {
  vi.useRealTimers();
});

describe('Laya in mu.json', () => {
  it('is the built-in `laya`, or any judge of the `local` type, as the harness tells them', () => {
    expect(isLaya('laya', undefined)).toBe(true);
    expect(isLaya('laya', { type: 'local', baseUrl: 'http://127.0.0.1:47823' })).toBe(true);
    expect(isLaya('my-laya', { type: 'local', baseUrl: 'http://127.0.0.1:47823' })).toBe(true);
    // A judge of a type mu runs that someone named `laya` is theirs, not Laya.
    expect(isLaya('laya', { type: 'http', baseUrl: 'http://127.0.0.1:9000' })).toBe(false);
    expect(isLaya('mude', { type: 'typesafe' })).toBe(false);
    expect(isLaya('jev', undefined)).toBe(false);
  });

  it('says where it stands in the order: first, later, or not at all', () => {
    expect(layaInOrder({ tiers: ['laya'] })).toBe('first');
    expect(layaInOrder({ tiers: ['jev', 'own'], judges: { own: { type: 'local' } } })).toBe('later');
    expect(layaInOrder({ tiers: ['jev'], judges: { laya: { type: 'local' } } })).toBeUndefined();
    expect(layaInOrder({})).toBeUndefined();
  });

  it('leaves the order mude in its place where mude 1.0 is installed, else the judges behind it, else Jev', () => {
    expect(orderWithoutLaya({ tiers: ['laya'] }, false)).toEqual(['jev']);
    expect(orderWithoutLaya({ tiers: ['laya'] }, true)).toEqual(['mude']);
    expect(orderWithoutLaya({ tiers: ['laya', 'jev'] }, false)).toEqual(['jev']);
    expect(orderWithoutLaya({ tiers: ['laya', 'jev'] }, true)).toEqual(['mude', 'jev']);
    // mude asked once, wherever it already was.
    expect(orderWithoutLaya({ tiers: ['jev', 'laya', 'mude'] }, true)).toEqual(['jev', 'mude']);
    expect(orderWithoutLaya({ tiers: ['laya', 'jev', 'mude'] }, true)).toEqual(['mude', 'jev']);
    // An order without Laya, or none at all, as mu reads it.
    expect(orderWithoutLaya({ tiers: ['clm', 'jev'] }, true)).toEqual(['clm', 'jev']);
    expect(orderWithoutLaya({}, true)).toEqual(['jev']);
  });
});

describe('mude’s status, asked for Laya’s sake', () => {
  it('is what mu’s own command says', async () => {
    await expect(within(async () => 'installed', 1000, 'none')).resolves.toBe('installed');
  });

  it('is none when the command fails or does not answer in time, so the settings never wait long', async () => {
    await expect(within(() => Promise.reject(new Error('mu is not installed')), 1000, 'none')).resolves.toBe('none');
    vi.useFakeTimers();
    const asked = within(() => new Promise<string>(() => undefined), 5000, 'none');
    await vi.advanceTimersByTimeAsync(4999);
    let settled = false;
    void asked.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(asked).resolves.toBe('none');
  });
});
