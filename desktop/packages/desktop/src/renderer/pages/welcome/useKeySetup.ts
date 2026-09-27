import { useEffect, useRef, useState } from 'react';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import type { ProviderTestResult } from '@/common/kyrn/models';
import { toMuError, type MuError } from '@/renderer/pages/settings/KyrnSettings/fields/muError';
import { keyOutcome, type KeyOutcome } from './onboarding';
import { namedModel, serviceById, servicesForKey, startModel, type ModelService, type ServiceId } from './services';

/** How long a key stays as it is before it is checked: a key typed by hand is not sent letter by letter. */
export const SETTLE_MS = 400;

/**
 * The id the check names: none a provider can have. The main process looks a saved key up by it when no key is typed
 * (a service on this machine), and the guide adds a provider, it never tests a saved one.
 */
const NO_SAVED_KEY = '';

type Answer = { outcome: KeyOutcome; result: ProviderTestResult; baseUrl: string };

export type KeyCheck =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | ({ phase: 'done' } & Answer)
  | { phase: 'failed'; error: MuError };

/** What Next writes: the service, the address it answered at, the key, and the model to start with. */
export type KeyChoice = { service: ModelService; baseUrl: string; key: string; model: string };

export type KeySetup = {
  key: string;
  setKey: (key: string) => void;
  /** The services the key has the shape of, in the table's order. */
  candidates: ModelService[];
  /** The service the key is for: the one picked, else the one service its shape fits. */
  service?: ModelService;
  /** The service is the one the key's shape fits. */
  recognized: boolean;
  choose: (id: ServiceId) => void;
  check: KeyCheck;
  /** Checks again at once: after the network or the account was put right. */
  recheck: () => void;
  /** The service took the key: Next can write it once a model is chosen. */
  works: boolean;
  /** What the service listed; empty when it listed nothing. */
  models: string[];
  model: string;
  setModel: (model: string) => void;
  /** What Next writes, once the key works and a model is chosen. */
  choice?: KeyChoice;
};

/**
 * The service can be written with this answer: it listed models, or answered without a list, or listed none for a
 * key it took (the model is typed then). A service on this machine without models has nothing to start with yet.
 */
export const usable = (service: ModelService, outcome: KeyOutcome): boolean =>
  outcome === 'ok' || outcome === 'unlisted' || (outcome === 'empty' && !service.keyless);

/**
 * The key to the one service it belongs to: at its first address, then at the vendor's next one when the first turned
 * the key down or could not be reached (a Kimi key made on the .ai site works only there). A key is never tried on
 * another vendor. The first answer that is neither is the one told; when every address said one of the two, a no
 * says more than an address that could not be reached.
 */
async function checkKey(service: ModelService, key: string): Promise<Answer> {
  const answers: Answer[] = [];
  for (const baseUrl of service.baseUrls) {
    // One address after the other: the next one only when this one said no.
    // eslint-disable-next-line no-await-in-loop
    const answer = await kyrnBridge.testProvider.invoke({
      id: NO_SAVED_KEY,
      api: service.api,
      baseUrl,
      authHeader: false,
      // No model: the model list alone, never a request that is billed.
      model: '',
      ...(key ? { apiKey: key } : {}),
    });
    const result = unwrap(answer);
    const outcome = keyOutcome(result);
    if (outcome !== 'wrongKey' && outcome !== 'unreachable') return { outcome, result, baseUrl };
    answers.push({ outcome, result, baseUrl });
  }
  return answers.find((answer) => answer.outcome === 'wrongKey') ?? answers[0];
}

/**
 * The key tile of the first-run guide: the key, the service it belongs to, the check of the key, the model to start
 * with. The service is read from the key's shape; the person picks it when the shape fits several services or none.
 * Once the service is known the key is checked by itself, with one model-list request to that service only.
 */
export function useKeySetup(): KeySetup {
  const [key, setKeyText] = useState('');
  const [picked, setPicked] = useState<ServiceId>();
  const [check, setCheck] = useState<KeyCheck>({ phase: 'idle' });
  const [model, setModel] = useState('');
  const [round, setRound] = useState(0);
  // Only the answer to the latest question counts: a key being typed asks many.
  const asked = useRef(0);

  const typed = key.trim();
  const candidates = servicesForKey(typed);
  const service = picked ? serviceById(picked) : candidates.length === 1 ? candidates[0] : undefined;
  const serviceId = service?.id;
  const sendable = Boolean(service && (typed || service.keyless));

  useEffect(() => {
    const ask = ++asked.current;
    setModel('');
    if (!service || !sendable) {
      setCheck({ phase: 'idle' });
      return undefined;
    }
    setCheck({ phase: 'checking' });
    const timer = setTimeout(() => {
      checkKey(service, typed).then(
        (answer) => {
          if (ask !== asked.current) return;
          setCheck({ phase: 'done', ...answer });
          const listed = answer.result.models;
          if (answer.outcome === 'ok') setModel(startModel(service, listed) ?? '');
          else if (usable(service, answer.outcome)) setModel(namedModel(service) ?? '');
        },
        (error: unknown) => {
          if (ask === asked.current) setCheck({ phase: 'failed', error: toMuError(error) });
        }
      );
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
      asked.current += 1;
    };
    // `service` is the table's entry for `serviceId`: the same object for the same id.
  }, [serviceId, sendable, typed, round]);

  const setKey = (next: string) => {
    setKeyText(next);
    // A new key whose shape names other services drops the pick. A pick stays for a key no shape fits (StepFun's),
    // and for a key of the picked service's shape (a DeepSeek key pasted again after DeepSeek was picked).
    const fits = servicesForKey(next);
    if (next.trim() !== typed && fits.length && !fits.some((entry) => entry.id === picked)) setPicked(undefined);
  };

  const works = service !== undefined && check.phase === 'done' && usable(service, check.outcome);
  return {
    key,
    setKey,
    candidates,
    service,
    recognized: Boolean(service) && candidates.length === 1 && candidates[0] === service,
    choose: setPicked,
    check,
    recheck: () => setRound((now) => now + 1),
    works,
    models: check.phase === 'done' ? check.result.models : [],
    model,
    setModel,
    choice:
      service && works && check.phase === 'done' && model.trim()
        ? { service, baseUrl: check.baseUrl, key: typed, model: model.trim() }
        : undefined,
  };
}
