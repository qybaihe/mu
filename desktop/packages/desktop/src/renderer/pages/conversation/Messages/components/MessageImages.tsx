/**
 * The images a person sent as themselves, not as files: a native conversation's message keeps them as pi's image
 * blocks (their data and type), with no path a file chip could read them by. Shown as a sent image file shows in the
 * person's bubble (`FilePreview`): a 60 px picture, whole on a click.
 */
import { Image } from '@arco-design/web-react';
import classNames from 'classnames';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { IMessageText } from '@/common/chat/chatLib';
import HorizontalFileList from '@renderer/components/media/HorizontalFileList';

type SentImage = NonNullable<IMessageText['content']['images']>[number];

const Picture: React.FC<{ image: SentImage; label: string }> = ({ image, label }) => {
  const src = useMemo(() => `data:${image.mimeType};base64,${image.data}`, [image]);
  return (
    <div className='relative inline-block' data-testid='native-message-image' data-mime={image.mimeType}>
      <div className='rd-8px overflow-hidden border-1 border-solid b-color-border-2'>
        <Image src={src} alt={label} width={60} height={60} className='object-cover cursor-pointer block' preview />
      </div>
    </div>
  );
};

const MessageImages: React.FC<{ images: SentImage[]; end?: boolean }> = ({ images, end }) => {
  const { t } = useTranslation();
  const pictures = images.map((image, index) => (
    <Picture key={index} image={image} label={t('mu.native.sentImage', { index: index + 1 })} />
  ));
  return (
    <div className={classNames('mt-6px min-w-0 max-w-full', { 'self-end': end })}>
      {pictures.length === 1 ? (
        <div className='flex items-center'>{pictures}</div>
      ) : (
        <HorizontalFileList>{pictures}</HorizontalFileList>
      )}
    </div>
  );
};

export default MessageImages;
