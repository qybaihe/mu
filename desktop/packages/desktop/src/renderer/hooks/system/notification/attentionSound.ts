/**
 * The chime mu plays when a conversation finishes, needs its person, or fails (`system.completionSound`; off unless
 * the person turns it on in the system settings). It is made in the window with Web Audio, two short soft notes, so
 * there is no file to load or ship. It plays whether or not the window is in front: that is what it is for, to tell a
 * person who isn't looking. While it is on, the system notification stays silent, so they hear one sound, not two
 * (process/bridge/notificationBridge.ts).
 */
import { configService } from '@/common/config/configService';

export type AttentionSound = 'done' | 'question' | 'error';

export const COMPLETION_SOUND_SETTING = 'system.completionSound';

/** Each kind's two notes, in Hz: up for done (C6, E6), a knock for a question (A5 twice), down for a failure (E5, C5). */
const NOTES: Readonly<Record<AttentionSound, readonly number[]>> = {
  done: [1046.5, 1318.51],
  question: [880, 880],
  error: [659.26, 523.25],
};

/** One note's length and the gap after it, in seconds. */
const NOTE_S = 0.12;
const GAP_S = 0.05;
/** How loud a note gets: soft, under whatever else is playing. */
const VOLUME = 0.12;
/** Chimes this close together are one: several conversations ending at once ring once. */
export const SOUND_GAP_MS = 1500;

type AudioContextClass = typeof AudioContext;

let context: AudioContext | undefined;
let lastAt = Number.NEGATIVE_INFINITY;

/** Whether the person turned the chime on. */
export const completionSoundOn = (): boolean => configService.get(COMPLETION_SOUND_SETTING) === true;

/**
 * Plays the chime for `kind`, the setting aside (the settings page plays it as a preview). False when the window
 * cannot make a sound, or a chime was just played.
 */
export function playAttentionSound(kind: AttentionSound, now = Date.now()): boolean {
  if (now - lastAt < SOUND_GAP_MS) return false;
  const Audio = (globalThis as { AudioContext?: AudioContextClass }).AudioContext;
  if (!Audio) return false;
  try {
    const audio = (context ??= new Audio());
    if (audio.state === 'suspended') void audio.resume();
    const start = audio.currentTime + 0.01;
    NOTES[kind].forEach((frequency, index) => {
      const at = start + index * (NOTE_S + GAP_S);
      const tone = audio.createOscillator();
      tone.type = 'sine';
      tone.frequency.setValueAtTime(frequency, at);
      const gain = audio.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(VOLUME, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_S);
      tone.connect(gain).connect(audio.destination);
      tone.start(at);
      tone.stop(at + NOTE_S + 0.02);
    });
    lastAt = now;
    return true;
  } catch {
    return false;
  }
}

/** The chime for something that wants the person, if they turned it on. */
export function soundForAttention(kind: AttentionSound): void {
  if (completionSoundOn()) playAttentionSound(kind);
}

/** Starts over: no window's sound made yet, no chime just played (tests). */
export function forgetAttentionSound(): void {
  context = undefined;
  lastAt = Number.NEGATIVE_INFINITY;
}
