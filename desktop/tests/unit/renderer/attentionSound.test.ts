import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The chime for a conversation that finished, asks something or failed (attentionSound.ts): two soft notes made with
 * Web Audio, a different pair for each kind, one chime for several at once, and only when the person turned it on.
 */

const setting = vi.hoisted(() => ({ on: undefined as boolean | undefined }));
vi.mock('@/common/config/configService', () => ({
  configService: { get: (key: string) => (key === 'system.completionSound' ? setting.on : undefined) },
}));

import {
  forgetAttentionSound,
  playAttentionSound,
  soundForAttention,
  SOUND_GAP_MS,
} from '@/renderer/hooks/system/notification/attentionSound';

/** A stand-in for the window's AudioContext that keeps the notes it was asked for. */
class FakeAudio {
  static made = 0;
  static notes: Array<{ frequency: number; at: number; stop: number }> = [];
  state: 'running' | 'suspended' = FakeAudio.suspended ? 'suspended' : 'running';
  static suspended = false;
  currentTime = 10;
  destination = {};
  resumed = 0;
  constructor() {
    FakeAudio.made += 1;
  }
  resume() {
    this.resumed += 1;
    this.state = 'running';
    return Promise.resolve();
  }
  createOscillator() {
    const note = { frequency: 0, at: 0, stop: 0 };
    return {
      type: '',
      frequency: { setValueAtTime: (value: number, at: number) => Object.assign(note, { frequency: value, at }) },
      connect: (next: unknown) => next,
      start: () => FakeAudio.notes.push(note),
      stop: (at: number) => Object.assign(note, { stop: at }),
    };
  }
  createGain() {
    const gain = {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: (next: unknown) => next,
    };
    return gain;
  }
}

beforeEach(() => {
  forgetAttentionSound();
  FakeAudio.made = 0;
  FakeAudio.notes = [];
  FakeAudio.suspended = false;
  setting.on = undefined;
  vi.stubGlobal('AudioContext', FakeAudio);
});
afterEach(() => vi.unstubAllGlobals());

const frequencies = () => FakeAudio.notes.map((note) => Math.round(note.frequency));

describe('the chime', () => {
  it('plays two short notes, up for done, a knock for a question, down for a failure', () => {
    expect(playAttentionSound('done', 0)).toBe(true);
    expect(frequencies()).toEqual([1047, 1319]);
    expect(FakeAudio.notes[1].at).toBeGreaterThan(FakeAudio.notes[0].at);
    expect(FakeAudio.notes[0].stop - FakeAudio.notes[0].at).toBeLessThan(0.2);
    FakeAudio.notes = [];
    playAttentionSound('question', SOUND_GAP_MS);
    expect(frequencies()).toEqual([880, 880]);
    FakeAudio.notes = [];
    playAttentionSound('error', 2 * SOUND_GAP_MS);
    expect(frequencies()).toEqual([659, 523]);
    // One AudioContext for the window, made once.
    expect(FakeAudio.made).toBe(1);
  });

  it('rings once for several at once', () => {
    expect(playAttentionSound('done', 1000)).toBe(true);
    expect(playAttentionSound('done', 1000 + SOUND_GAP_MS - 1)).toBe(false);
    expect(FakeAudio.notes).toHaveLength(2);
    expect(playAttentionSound('done', 1000 + SOUND_GAP_MS)).toBe(true);
  });

  it('wakes a suspended context, and says no where the window cannot make a sound', () => {
    FakeAudio.suspended = true;
    expect(playAttentionSound('done', 0)).toBe(true);
    forgetAttentionSound();
    vi.stubGlobal('AudioContext', undefined);
    expect(playAttentionSound('done', 0)).toBe(false);
  });

  it('plays for something that wants the person only when they turned it on', () => {
    soundForAttention('done');
    expect(FakeAudio.notes).toHaveLength(0);
    setting.on = false;
    soundForAttention('done');
    expect(FakeAudio.notes).toHaveLength(0);
    setting.on = true;
    soundForAttention('question');
    expect(frequencies()).toEqual([880, 880]);
  });
});
