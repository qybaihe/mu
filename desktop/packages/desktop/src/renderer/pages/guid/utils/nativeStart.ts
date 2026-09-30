/**
 * The home page's send while the native host is on (docs/native-host-ui.md): a conversation on the native host in the
 * chosen folder and permission mode, the model the pill picked, then the message. Files go the way the classic path
 * sends them: an image as pi's `images`, every other file as its path under the message (the `[[AION_FILES]]` block
 * the message list shows as chips).
 */
import { AIONUI_FILES_MARKER } from '@/common/config/constants';
import type { NativeFailure } from '@/common/kyrn/nativeBridge';
import { chatFileRefPath, type ChatFileRef } from '@/common/types/chatFile';
import type { PiImage } from '@/common/utils/nativeHost';
import type { NativeClient } from '@/renderer/pages/native/utils/nativeClient';

/** The images pi takes, as the ACP adapter lets them through (KyrnAgent.prompt), and how large one may be. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
const IMAGE_LIMIT = 16 * 1024 * 1024;

export type NativeStart = {
  cwd: string;
  /** A permission mode as mu names them (`full`, `jev`, `ask`); mu's own default when left out. */
  permissions?: string;
  /** The model the pill picked, as mu names its models to the pickers: `<provider>/<model id>`. */
  model?: string;
  /**
   * The thinking level the person picked (`high`, `low`, ...), for the model picked or the one shown. Only a level
   * picked is sent: the one the pill shows without a pick is not, mu keeps its own.
   */
  level?: string;
  input: string;
  files: readonly ChatFileRef[];
};

/** An attached file read as a data URL (`data:image/png;base64,…`); undefined when it cannot be read. */
export type ReadImage = (file: ChatFileRef) => Promise<string | undefined>;

export type NativeStarted = { ok: true; id: string } | NativeFailure;

/** The IPC itself failed: said as a host that could not start. */
const broken = (error: unknown): NativeFailure => ({
  ok: false,
  kind: 'failed',
  message: error instanceof Error ? error.message : String(error),
});

/** An image pi takes, from a data URL of a type it takes. */
function imageOf(dataUrl: string | undefined): PiImage | undefined {
  const found = dataUrl ? /^data:([^;,]+);base64,([\s\S]+)$/.exec(dataUrl) : null;
  if (!found || !Object.values(IMAGE_TYPES).includes(found[1]) || found[2].length > IMAGE_LIMIT) return undefined;
  return { type: 'image', mimeType: found[1], data: found[2] };
}

/** The message and images pi gets for what the person typed and attached. An image that cannot be read goes as a path. */
export async function promptOf(
  input: string,
  files: readonly ChatFileRef[],
  readImage: ReadImage
): Promise<{ message: string; images: PiImage[] }> {
  const read = await Promise.all(
    files.map(async (file) => {
      const path = chatFileRefPath(file);
      const image = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? '']
        ? imageOf(await readImage(file).catch((): undefined => undefined))
        : undefined;
      return { path, image };
    })
  );
  const images = read.flatMap(({ image }) => (image ? [image] : []));
  const paths = read.flatMap(({ path, image }) => (image ? [] : [path]));
  return { message: paths.length > 0 ? `${input}\n\n${AIONUI_FILES_MARKER}\n${paths.join('\n')}` : input, images };
}

/**
 * Makes the conversation and sends its first message; resolves with the id to open once pi took the message. With
 * nothing typed it only makes the conversation, as the classic "start chat" does. A start that fails on the way leaves
 * no conversation behind: what was typed stays on the home page, to send again.
 */
export async function startNativeConversation(
  client: NativeClient,
  start: NativeStart,
  readImage: ReadImage
): Promise<NativeStarted> {
  const created = await client.create(start.cwd, start.permissions).catch(broken);
  if (created.ok === false) return created;
  let id = created.data.id;
  // The draft takes its session's id once its host starts: the page opens under the id it has then.
  const stop = client.onChanged((event) => {
    if (!('removed' in event) && event.replaces === id) id = event.conversation.id;
  });
  const giveUp = async (failure: NativeFailure): Promise<NativeFailure> => {
    await client.remove(id).catch((): undefined => undefined);
    return failure;
  };
  try {
    const slash = start.model?.indexOf('/') ?? -1;
    if (start.model && slash > 0) {
      const provider = start.model.slice(0, slash);
      const set = await client.request(id, { type: 'set_model', provider, modelId: start.model.slice(slash + 1) });
      if (set.ok === false) return await giveUp(set);
    }
    // After the model: `set_model` sets the level back.
    if (start.level) {
      const thought = await client.request(id, { type: 'set_thinking_level', level: start.level });
      if (thought.ok === false) return await giveUp(thought);
    }
    if (start.input.trim()) {
      const { message, images } = await promptOf(start.input, start.files, readImage);
      const sent = await client.request(id, { type: 'prompt', message, ...(images.length > 0 ? { images } : {}) });
      if (sent.ok === false) return await giveUp(sent);
    }
    return { ok: true, id };
  } catch (error) {
    return giveUp(broken(error));
  } finally {
    stop();
  }
}
