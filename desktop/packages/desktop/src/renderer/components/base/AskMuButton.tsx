/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import MuMark from '@/renderer/components/brand/MuMark';
import { globalNavigate } from '@/renderer/utils/navigation';
import { Button } from '@arco-design/web-react';
import classNames from 'classnames';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

type AskMuButtonProps = {
  /** The error, as the person would paste it into a message. */
  errorText: string;
  /** Additional classes for the chip. */
  className?: string;
};

/**
 * The "Ask mu about this" chip on a conversation's errors. It opens a new mu conversation on the home page with a
 * message that quotes the error and asks for the cause and a fix, ready to send. It picks no assistant: the
 * conversation starts the way any new one does.
 */
const AskMuButton: React.FC<AskMuButtonProps> = ({ errorText, className }) => {
  const { t } = useTranslation();

  const handleClick = useCallback(
    (event: Event) => {
      event.stopPropagation();
      const prompt = t('conversation.askMu.prompt', { error: errorText.trim() });
      globalNavigate('/guid', { state: { resetAssistant: true, prefillPrompt: prompt, focusPrefill: true } });
    },
    [errorText, t]
  );

  return (
    <Button
      type='text'
      size='mini'
      shape='round'
      className={classNames('inline-flex items-center gap-4px', className)}
      icon={<MuMark size={14} variant='glyph' />}
      onClick={handleClick}
    >
      {t('conversation.askMu.label')}
    </Button>
  );
};

export default AskMuButton;
