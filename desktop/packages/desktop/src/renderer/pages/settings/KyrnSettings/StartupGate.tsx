import React from 'react';
import useSWR, { mutate } from 'swr';
import { Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import MuMark from '@renderer/components/brand/MuMark';
import WindowControls from '@renderer/components/layout/WindowControls';
import '@renderer/components/layout/Titlebar/titlebar.css';
import { isElectronDesktop, isMacOS } from '@renderer/utils/platform';
import styles from '@renderer/components/brand/Brand.module.css';
import { muErrorText, toMuError } from './fields/muError';

/**
 * Holds the app back until mu's catalog has loaded, and says why when it cannot. `open` lets the app through without
 * asking. It is a prop, not a gate left out of the tree, so the element around the app is the same on every page and
 * what it holds stays mounted when the gate opens or closes.
 */
export default function StartupGate({ children, open = false }: { children: React.ReactNode; open?: boolean }) {
  const { t, i18n } = useTranslation();
  const {
    data,
    error,
    isValidating,
    mutate: retry,
  } = useSWR(
    open ? null : 'kyrn.catalog',
    async () => {
      const catalog = unwrap(await kyrnBridge.catalog.invoke());
      await mutate('assistants.list', catalog.assistants, { revalidate: false });
      return catalog;
    },
    { shouldRetryOnError: false, revalidateOnFocus: false }
  );
  if (open) return <>{children}</>;
  const titlebar = isElectronDesktop() ? (
    <div className={styles.gateTitlebar}>{!isMacOS() && <WindowControls />}</div>
  ) : null;
  if (error) {
    // What went wrong in the app language; the raw message only as the detail under it.
    const { text, detail } = muErrorText(t, i18n.language, toMuError(error));
    return (
      <div className={styles.gate} data-testid='mu-startup-error'>
        {titlebar}
        <MuMark size={56} halo />
        <div className={styles.gateError} role='alert'>
          <h2 className={styles.gateErrorTitle}>{t('common.kyrn.startupError')}</h2>
          <p className='m-0 mb-10px text-13px leading-20px text-t-primary'>{text}</p>
          {detail ? (
            <pre className={styles.gateErrorText} dir='ltr' data-testid='mu-error-detail'>
              {detail}
            </pre>
          ) : null}
          <Button type='primary' loading={isValidating} onClick={() => void retry().catch((): undefined => undefined)}>
            {t('common.kyrn.reload')}
          </Button>
        </div>
      </div>
    );
  }
  if (!data)
    return (
      <div className={styles.gate} data-testid='mu-startup' role='status' aria-live='polite'>
        {titlebar}
        <MuMark size={64} halo />
        <h2 className={styles.gateTitle}>{t('common.kyrn.starting')}</h2>
        <p className={styles.gateHint}>{t('common.kyrn.startingHint')}</p>
        <div className={styles.gateBar} aria-hidden='true' />
      </div>
    );
  return <>{children}</>;
}
