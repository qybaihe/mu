import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from '@arco-design/web-react';
import type { FileRefAnswer } from '@/common/chat/fileRefs/fileRefBridge';
import MarkdownView from '@/renderer/components/Markdown';
import { ReplyFileRefs } from '@/renderer/components/media/FileRefs/ReplyFileRefs';
import { resetFileRefsForTest } from '@/renderer/components/media/FileRefs/fileRefStore';

/**
 * A reply's file references on screen (renderer/components/media/FileRefs/): the reply is drawn as it always was, and
 * the references the main process finds become links: images to the preview panel, which steps through the reply's
 * images, files the panel draws well to the panel too, other files to their app, programs to their folder; a clear path
 * to nothing is greyed out; code stays code.
 */

const mocks = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  resolve: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
  openPreview: vi.fn(),
  openFile: vi.fn(),
}));

vi.mock('@/common/chat/fileRefs/fileRefBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/chat/fileRefs/fileRefBridge')>()),
  fileRefBridge: {
    resolve: { invoke: mocks.resolve },
    open: { invoke: mocks.open },
    reveal: { invoke: mocks.reveal },
    readImage: { invoke: vi.fn() },
  },
}));

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openPreview: mocks.openPreview, openBrowserTab: vi.fn() }),
}));

vi.mock('@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview', () => ({
  useOptionalLocalFilePreview: () => mocks.openFile,
}));

// The reply's markdown is drawn into a shadow root in the app; here, in place, so the screen queries reach it.
vi.mock('@/renderer/components/Markdown/ShadowView', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key),
    i18n: { language: 'en-US' },
  }),
}));

const CWD = '/work/cards';
const image = (name: string): FileRefAnswer => ({
  state: 'found',
  path: `${CWD}/out/${name}`,
  kind: 'image',
  size: 10,
});

const OWNER_REPLY = [
  '重新生成的 5 张「角色 × 场景关系卡」：',
  '',
  '1. `07_角色与场景关系卡_铁匠老秦_雨夜钢铁厂.png`',
  '   - 左侧场景图：雨夜。',
  '2. `08_角色与场景关系卡_百变陆离_黄昏大剧院.png`',
  '3. `09_角色与场景关系卡_零号刺客_雾夜霓虹深巷.png`',
  '4. `10_角色与场景关系卡_全知者_虚空全息竞技场.png`',
  '5. `11_角色与场景关系卡_蜂后嗡嗡_晴天街头公园.png`',
].join('\n');
const OWNER_IMAGES = [
  '07_角色与场景关系卡_铁匠老秦_雨夜钢铁厂.png',
  '08_角色与场景关系卡_百变陆离_黄昏大剧院.png',
  '09_角色与场景关系卡_零号刺客_雾夜霓虹深巷.png',
  '10_角色与场景关系卡_全知者_虚空全息竞技场.png',
  '11_角色与场景关系卡_蜂后嗡嗡_晴天街头公园.png',
];

const reply = (markdown: string, onLocalFileLink?: (path: string) => void) =>
  render(
    <ReplyFileRefs markdown={markdown} cwd={CWD}>
      <MarkdownView onLocalFileLink={onLocalFileLink}>{markdown}</MarkdownView>
    </ReplyFileRefs>
  );

/** Every reference asked about in this test, in order. */
const asked = (): string[] => mocks.resolve.mock.calls.flatMap(([request]) => (request as { refs: string[] }).refs);

beforeEach(() => {
  resetFileRefsForTest();
  mocks.files.clear();
  for (const name of OWNER_IMAGES) mocks.files.set(name, image(name));
  mocks.resolve.mockReset().mockImplementation(async ({ refs }: { refs: string[] }) => ({
    ok: true,
    data: refs.map((ref) => mocks.files.get(ref) ?? { state: 'missing' }),
  }));
  mocks.open.mockReset().mockResolvedValue({ ok: true, data: { action: 'opened' } });
  mocks.reveal.mockReset().mockResolvedValue({ ok: true, data: undefined });
  mocks.openPreview.mockReset();
  mocks.openFile.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a reply naming images', () => {
  it('draws each image name as a link once the main process found it, asking once for the whole reply', async () => {
    reply(OWNER_REPLY);
    // Plain code first: nothing waits on the main process.
    expect(screen.getByText(OWNER_IMAGES[0]).tagName).toBe('CODE');
    expect(screen.queryByRole('button')).toBeNull();

    const links = await Promise.all(
      OWNER_IMAGES.map((name) => screen.findByRole('button', { name: `messages.fileRef.preview:${name}` }))
    );
    expect(links).toHaveLength(OWNER_IMAGES.length);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledWith({ cwd: CWD, refs: OWNER_IMAGES });
    // The link keeps the code look and says where the file is.
    const link = screen.getByRole('button', { name: `messages.fileRef.preview:${OWNER_IMAGES[2]}` });
    expect(link.querySelector('code')).toHaveTextContent(OWNER_IMAGES[2]);
    expect(link.closest('[data-file-ref]')).toHaveAttribute('title', `${CWD}/out/${OWNER_IMAGES[2]}`);
  });

  it('opens a clicked image in the preview with every image of the reply to step through', async () => {
    reply(OWNER_REPLY);
    fireEvent.click(await screen.findByRole('button', { name: `messages.fileRef.preview:${OWNER_IMAGES[2]}` }));
    const gallery = OWNER_IMAGES.map((name) => `${CWD}/out/${name}`);
    expect(mocks.openPreview).toHaveBeenCalledWith(
      '',
      'image',
      expect.objectContaining({ file_path: gallery[2], file_name: OWNER_IMAGES[2], gallery }),
      { replace: true }
    );
  });

  it('opens an image a link points to, and steps through it with the code ones in the reply’s order', async () => {
    mocks.files.set('out/cover.png', image('cover.png'));
    mocks.files.set('back.png', image('back.png'));
    reply(`Here is [the cover](out/cover.png), then \`${OWNER_IMAGES[0]}\` and [the back](back.png).`);
    const link = await screen.findByRole('button', { name: 'the cover' });
    fireEvent.click(link);
    expect(mocks.openPreview).toHaveBeenCalledWith(
      '',
      'image',
      expect.objectContaining({
        file_path: `${CWD}/out/cover.png`,
        gallery: [`${CWD}/out/cover.png`, `${CWD}/out/${OWNER_IMAGES[0]}`, `${CWD}/out/back.png`],
      }),
      { replace: true }
    );
  });
});

describe('a reply naming other files', () => {
  it('opens a file the panel draws well beside the reply, and shows it in its folder from the icon', async () => {
    mocks.files.set('out/report.pdf', { state: 'found', path: `${CWD}/out/report.pdf`, kind: 'file', size: 3 });
    mocks.files.set('src/app.ts', { state: 'found', path: `${CWD}/src/app.ts`, kind: 'file', size: 3 });
    reply('The report is `out/report.pdf`, built by `src/app.ts`.');
    fireEvent.click(await screen.findByRole('button', { name: 'messages.fileRef.preview:out/report.pdf' }));
    expect(mocks.openFile).toHaveBeenCalledWith(`${CWD}/out/report.pdf`);
    fireEvent.click(screen.getByRole('button', { name: 'messages.fileRef.preview:src/app.ts' }));
    expect(mocks.openFile).toHaveBeenCalledWith(`${CWD}/src/app.ts`);
    fireEvent.click(screen.getByRole('button', { name: /^messages\.fileRef\.reveal\.\w+:out\/report\.pdf$/ }));
    expect(mocks.reveal).toHaveBeenCalledWith({ path: `${CWD}/out/report.pdf` });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('opens any other file in its default app', async () => {
    mocks.files.set('out/deck.pptx', { state: 'found', path: `${CWD}/out/deck.pptx`, kind: 'file', size: 3 });
    reply('The deck is `out/deck.pptx`.');
    fireEvent.click(await screen.findByRole('button', { name: 'messages.fileRef.open:out/deck.pptx' }));
    expect(mocks.open).toHaveBeenCalledWith({ path: `${CWD}/out/deck.pptx` });
    expect(mocks.openFile).not.toHaveBeenCalled();
    expect(mocks.openPreview).not.toHaveBeenCalled();
  });

  it('only shows a program in its folder', async () => {
    mocks.files.set('./build.sh', { state: 'found', path: `${CWD}/build.sh`, kind: 'program', size: 3 });
    reply('Run `./build.sh` when you are ready.');
    fireEvent.click(await screen.findByRole('button', { name: /^messages\.fileRef\.reveal\.\w+:\.\/build\.sh$/ }));
    expect(mocks.reveal).toHaveBeenCalledWith({ path: `${CWD}/build.sh` });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('says so, and greys the reference out, when the file went away since', async () => {
    const warning = vi.spyOn(Message, 'warning').mockImplementation(() => () => undefined);
    mocks.files.set('notes.zip', { state: 'found', path: `${CWD}/notes.zip`, kind: 'file', size: 3 });
    mocks.open.mockResolvedValue({ ok: false, error: 'gone', code: 'notFound' });
    reply('See `notes.zip`.');
    fireEvent.click(await screen.findByRole('button', { name: 'messages.fileRef.open:notes.zip' }));
    await waitFor(() => expect(warning).toHaveBeenCalledWith('messages.fileRef.gone:notes.zip'));
    expect(screen.getByText('notes.zip').closest('[data-file-ref]')).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps the app’s own link for a link to a file that is not an image', async () => {
    mocks.files.set('out/report.pdf', { state: 'found', path: `${CWD}/out/report.pdf`, kind: 'file', size: 3 });
    const onLocalFileLink = vi.fn();
    reply('Read [the report](out/report.pdf).', onLocalFileLink);
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'the report' }));
    expect(onLocalFileLink).toHaveBeenCalledWith(
      'out/report.pdf',
      expect.objectContaining({ filePath: 'out/report.pdf' })
    );
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

describe('a reference that names nothing', () => {
  it('greys out a clear path to nothing, with why', async () => {
    mocks.files.set('v1.png', { state: 'ambiguous' });
    reply('Missing `out/missing.png`, twice `v1.png`.');
    await waitFor(() => expect(screen.getByText('out/missing.png').closest('[data-file-ref]')).not.toBeNull());
    const missing = screen.getByText('out/missing.png').closest('[data-file-ref]');
    expect(missing).toHaveAttribute('aria-disabled', 'true');
    expect(missing).toHaveAttribute('title', 'messages.fileRef.missing');
    const ambiguous = screen.getByText('v1.png').closest('[data-file-ref]');
    expect(ambiguous).toHaveAttribute('aria-disabled', 'true');
    expect(ambiguous).toHaveAttribute('title', 'messages.fileRef.ambiguous');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('leaves what may be code plain when it names nothing', async () => {
    reply('Edit `index.ts` or call `console.log`.');
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalled());
    await act(async () => {});
    for (const text of ['index.ts', 'console.log']) {
      expect(screen.getByText(text).tagName).toBe('CODE');
      expect(screen.getByText(text).closest('[data-file-ref]')).toBeNull();
    }
  });
});

describe('ordinary code', () => {
  it('stays plain code, and is never even looked up', async () => {
    reply(
      [
        'Run `npm run build`, then read `x.length`, `foo.bar` and `a/b`.',
        '',
        '```ts',
        'const card = `07.png`;',
        '```',
        '',
        `And \`${OWNER_IMAGES[0]}\`.`,
      ].join('\n')
    );
    await screen.findByRole('button', { name: `messages.fileRef.preview:${OWNER_IMAGES[0]}` });
    expect(asked()).toEqual([OWNER_IMAGES[0]]);
    for (const text of ['npm run build', 'x.length', 'foo.bar', 'a/b']) {
      expect(screen.getByText(text).tagName).toBe('CODE');
      expect(screen.getByText(text).closest('[data-file-ref]')).toBeNull();
    }
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
