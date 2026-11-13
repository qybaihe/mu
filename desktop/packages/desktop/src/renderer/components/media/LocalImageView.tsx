import { ipcBridge } from '@/common';
import { joinPath } from '@/common/chat/chatLib';
import { Download, LoadingTwo } from '@icon-park/react';
import { Image as ArcoImage, Message } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversationContextSafe } from '@renderer/hooks/context/ConversationContext';
import { iconColors } from '@/renderer/styles/colors';
import { downloadFileFromPath } from '@/renderer/utils/file/download';

/** The preview's toolbar, with the per-image extra action (save) at the end. */
const PREVIEW_ACTIONS_LAYOUT = ['zoomIn', 'zoomOut', 'originalSize', 'rotateLeft', 'rotateRight', 'extra'];

const LocalImageView: React.FC<{
  src: string;
  alt: string;
  className?: string;
  /** Open the image preview on click: zoom, step through the conversation's images, save the file. */
  preview?: boolean;
}> = ({ src, alt, className, preview }) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState(src);
  // Resolve relative image paths (e.g. ![](./chart.png)) against the conversation
  // workspace = the agent cwd, and pass it as the fs sandbox workspace. Outside a
  // conversation (settings markdown) there is no workspace, so the src is sent
  // through unchanged — matching the previous default root of ''.
  const root = useConversationContextSafe()?.workspace ?? '';

  const absolutePath = useMemo(() => {
    if (!root) return src;
    if (
      src.startsWith('http') ||
      src.startsWith('data:') ||
      src.startsWith('/') ||
      src.startsWith('file:') ||
      src.startsWith('\\') ||
      /^[A-Za-z]:/.test(src)
    ) {
      return src;
    }
    return joinPath(root, src);
  }, [src, root]);

  useEffect(() => {
    setLoading(true);
    ipcBridge.fs.getImageBase64
      .invoke({ path: absolutePath, workspace: root || undefined })
      .then((base64) => {
        if (base64) {
          setUrl(base64);
        }
        setLoading(false);
      })
      .catch((error) => {
        console.error('[LocalImageView] Failed to load image:', {
          path: absolutePath,
          error,
        });
        setLoading(false);
      });
  }, [absolutePath, root]);

  const save = useCallback(async (): Promise<void> => {
    const name = absolutePath.split(/[/\\]/).pop() || 'image';
    try {
      await downloadFileFromPath(absolutePath, name, root || undefined);
    } catch (error) {
      console.error('[LocalImageView] Failed to download image:', { path: absolutePath, error });
      Message.error(t('acp.image.download_error'));
    }
  }, [absolutePath, root, t]);

  if (loading)
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <LoadingTwo
          className='loading'
          style={{ display: 'flex' }}
          theme='outline'
          size='14'
          fill={iconColors.primary}
          strokeWidth={2}
        />
        <span>{alt}</span>
      </span>
    );

  if (preview)
    return (
      <ArcoImage
        src={url}
        alt={alt}
        className={className ? `${className} cursor-zoom-in` : 'cursor-zoom-in'}
        previewProps={{
          actionsLayout: PREVIEW_ACTIONS_LAYOUT,
          actions: [
            {
              key: 'save',
              name: t('acp.image.download'),
              getContainer: (actionElement: React.ReactNode) => (
                <span data-testid='local-image-save'>{actionElement}</span>
              ),
              content: <Download theme='outline' />,
              onClick: () => void save(),
            },
          ],
        }}
      />
    );

  return <img src={url} alt={alt} className={className} />;
};

export default LocalImageView;
