import useSWR from 'swr';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { completeSettings } from '@/renderer/pages/settings/KyrnSettings/draft';
import { summarize, type KernelSummary } from './kernelSummary';

/** Saving the settings replaces this entry, so the bar follows a change at once. */
export const KERNEL_SUMMARY_KEY = 'mu.kernelSummary';

const readSummary = async (): Promise<KernelSummary> =>
  summarize(completeSettings(unwrap(await kyrnBridge.settings.invoke())));

/** The judge and the decision points, read once and again when the window comes back to the front. */
export function useKernelSummary(): KernelSummary | undefined {
  const { data } = useSWR(KERNEL_SUMMARY_KEY, readSummary, { revalidateOnFocus: true, shouldRetryOnError: false });
  return data;
}
