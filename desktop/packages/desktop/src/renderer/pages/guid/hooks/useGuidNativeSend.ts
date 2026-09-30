/**
 * The home page's send while the native host is on (docs/native-host-ui.md): the message starts a conversation on the
 * native host, with no AionCore in its path, and the page opens it once pi took the message. The home page lists mu's
 * assistants only (initializeKyrn keeps mu's), so every send is mu's; the folder, the permission mode picked on the
 * page, the model the pill picked and the thinking level, when one was picked, go with it. A send that cannot start
 * one says why, in the native screens' words, and keeps what was typed. GuidPage uses useGuidSend instead while the
 * host is off.
 */
import { Message } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import { useCallback, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { ipcBridge } from '@/common';
import type { ChatFileRef } from '@/common/types/chatFile';
import { errorKey } from '@/renderer/pages/native/utils/errorWords';
import { useNativeClient } from '@/renderer/pages/native/utils/nativeClient';
import { nativeConversationPath } from '@/renderer/pages/native/utils/paths';
import { startNativeConversation, type ReadImage } from '../utils/nativeStart';
import type { GuidSendResult } from './useGuidSend';

/** Permission modes are words (`full`, `jev`, `ask`), as mu names them; anything else is not sent. */
const MODE_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** Thinking levels are words too (`off`, `low`, `high`, ...); pi refuses one it does not know. */
const LEVEL_ID = /^[a-z][a-z0-9-]{0,15}$/;

export type GuidNativeSendDeps = {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  files: ChatFileRef[];
  setFiles: React.Dispatch<React.SetStateAction<ChatFileRef[]>>;
  /** The folder mu works in; '' when none was chosen. */
  dir: string;
  setDir: React.Dispatch<React.SetStateAction<string>>;
  loading: boolean;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  /** The permission mode picked on the page; '' leaves mu's own default. */
  selectedMode: string;
  /** The model the pill picked, `<provider>/<model id>`; null leaves mu's default. */
  selectedAcpModel: string | null;
  /** The thinking level the person picked with it; '' when none was picked (the pill's shown level is not a pick). */
  pickedThoughtLevel?: string;
  navigate: NavigateFunction;
  t: TFunction;
  /** Reads an attached image; the backend's file reader by default. */
  readImage?: ReadImage;
};

const readWithBackend: ReadImage = (file) =>
  ipcBridge.fs.readContent.invoke({ file, encoding: 'dataurl' }).catch((): undefined => undefined);

export const useGuidNativeSend = (deps: GuidNativeSendDeps): GuidSendResult => {
  const {
    input,
    setInput,
    files,
    setFiles,
    dir,
    setDir,
    loading,
    setLoading,
    selectedMode,
    selectedAcpModel,
    pickedThoughtLevel = '',
    navigate,
    t,
    readImage = readWithBackend,
  } = deps;
  const client = useNativeClient();
  const sendingRef = useRef(false);

  /** Whether the conversation started; it says why when it did not. */
  const start = useCallback(async (): Promise<boolean> => {
    // pi works in a project folder: there is no conversation without one.
    if (!dir) {
      Message.warning(t('mu.native.home.noFolder'));
      return false;
    }
    const started = await startNativeConversation(
      client,
      {
        cwd: dir,
        ...(MODE_ID.test(selectedMode) ? { permissions: selectedMode } : {}),
        ...(selectedAcpModel ? { model: selectedAcpModel } : {}),
        ...(LEVEL_ID.test(pickedThoughtLevel) ? { level: pickedThoughtLevel } : {}),
        input,
        files,
      },
      readImage
    );
    if (started.ok === false) {
      Message.error(`${t(errorKey(started.kind))} ${started.message}`.trim());
      return false;
    }
    await navigate(nativeConversationPath(started.id));
    return true;
  }, [client, dir, files, input, navigate, pickedThoughtLevel, readImage, selectedAcpModel, selectedMode, t]);

  const handleSend = useCallback(async () => {
    await start();
  }, [start]);

  const sendMessageHandler = useCallback(() => {
    if (loading || sendingRef.current) return;
    sendingRef.current = true;
    setLoading(true);
    start()
      .then((started) => {
        if (!started) return;
        setInput('');
        setFiles([]);
        setDir('');
      })
      .catch((error: unknown) => {
        Message.error(`${t(errorKey('failed'))} ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        sendingRef.current = false;
        setLoading(false);
      });
  }, [loading, setDir, setFiles, setInput, setLoading, start, t]);

  // No assistant needed: the native host runs mu itself. Empty input is allowed, as on the classic page ("start chat").
  return { handleSend, sendMessageHandler, isButtonDisabled: loading };
};
