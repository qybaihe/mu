import useSWR from 'swr';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';

async function readMode(): Promise<string> {
  try {
    return unwrap(await kyrnBridge.settings.invoke()).permissions?.mode ?? '';
  } catch {
    return '';
  }
}

/**
 * The permission mode mu starts a conversation in that has none of its own: mu's last pick, else the settings'
 * default. Undefined until it is read, and when it cannot be. Every send box shares one read.
 */
export function useMuDefaultPermission(): string | undefined {
  const { data } = useSWR('mu.defaultPermission', readMode, { revalidateOnFocus: true });
  return data || undefined;
}
