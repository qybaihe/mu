import { ipcBridge } from '@/common';
import { LoadingTwo } from '@icon-park/react';
import { Message } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversationContextSafe } from '@renderer/hooks/context/ConversationContext';
import { iconColors } from '@/renderer/styles/colors';
import { downloadFileFromPath } from '@/renderer/utils/file/download';

const TOOL_BUTTON: React.CSSProperties = {
  minWidth: '34px',
  height: '26px',
  padding: '0 8px',
  borderRadius: '6px',
  border: '1px solid rgba(127,127,127,.35)',
  background: 'var(--color-fill-2, rgba(127,127,127,.12))',
  color: 'inherit',
  fontSize: '12px',
  lineHeight: 1,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

/** A local HTML page of a reply: it renders as a live, interactive sandbox — the effect itself,
 *  not a recording of it. Scripts run (`allow-scripts`), the frame has an opaque origin (no
 *  `allow-same-origin`), so it cannot reach the app; the file loads through the fs bridge like
 *  every other local media, and the bar above offers the escapes a recording never had. */
const LocalHtmlView: React.FC<{ src: string; title: string }> = ({ src, title }) => {
  const { t } = useTranslation();
  const conversation = useConversationContextSafe();
  const root = conversation?.workspace ?? '';
  const [url, setUrl] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const failed = url === '';

  useEffect(() => {
    let alive = true;
    ipcBridge.fs.getImageBase64
      .invoke({ path: src, workspace: root || undefined })
      .then((base64) => {
        if (!alive) return;
        // The bridge hands back a data: URL; an HTML page wants to be served as text/html so
        // its scripts run — rewrite the mime whatever the extension produced.
        const html = base64 ? base64.replace(/^data:[^,]*,/, 'data:text/html;base64,') : '';
        setUrl(html || '');
      })
      .catch((error) => {
        console.error('[LocalHtmlView] Failed to load page:', { path: src, error });
        if (alive) setUrl('');
      });
    return () => {
      alive = false;
    };
  }, [src, root]);

  const name = useMemo(() => src.split(/[/\\]/).pop() || 'page.html', [src]);
  const save = useCallback(async (): Promise<void> => {
    try {
      await downloadFileFromPath(src, name, root || undefined);
    } catch (error) {
      console.error('[LocalHtmlView] Failed to download page:', { path: src, error });
      Message.error(t('acp.image.download_error'));
    }
  }, [src, name, root, t]);

  if (failed)
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 0' }}>
        <code>{name}</code>
        <span style={{ color: 'var(--color-text-3, #888)' }}>
          {t('preview.html.loadFailed', { defaultValue: 'could not load' })}
        </span>
      </span>
    );
  if (url === null)
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <LoadingTwo theme='outline' size='14' fill={iconColors.primary} strokeWidth={2} />
        <span>{title}</span>
      </span>
    );

  return (
    <span data-testid='local-html-wrap' style={{ display: 'block', maxWidth: '100%', margin: '6px 0' }}>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '4px 8px',
          borderTopLeftRadius: '8px',
          borderTopRightRadius: '8px',
          border: '1px solid var(--color-border-2, #e5e6eb)',
          borderBottom: 'none',
          background: 'var(--color-fill-1, rgba(127,127,127,.08))',
          fontSize: '12px',
        }}
      >
        <span style={{ fontWeight: 600 }}>{title || name}</span>
        <span style={{ flex: 1 }} />
        <button
          type='button'
          style={TOOL_BUTTON}
          data-testid='local-html-reload'
          onClick={() => setFrameKey((k) => k + 1)}
        >
          ⟳
        </button>
        <button type='button' style={TOOL_BUTTON} data-testid='local-html-save' onClick={() => void save()}>
          ⤓
        </button>
      </span>
      <iframe
        key={frameKey}
        title={title || name}
        src={url}
        data-testid='local-html-frame'
        sandbox='allow-scripts allow-forms allow-pointer-lock allow-popups'
        style={{
          display: 'block',
          width: '100%',
          height: '400px',
          border: '1px solid var(--color-border-2, #e5e6eb)',
          borderRadius: '0 0 8px 8px',
          background: '#fff',
        }}
      />
    </span>
  );
};

export default LocalHtmlView;
