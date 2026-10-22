import React, { useId } from 'react';
import type { SubscriptionProvider } from '@/common/kyrn/login';

/**
 * The marks of the services a person signs in to, so a sign-in button looks like the service it opens. Drawn inline
 * (no image request, crisp at any size). OpenAI's, Grok's and Antigravity's marks follow the text colour; Claude's
 * keeps its own orange, Gemini CLI's its gradient frame.
 */
// The OpenAI mark as simple-icons 13 draws it (CC0), 24 x 24.
const OPENAI_PATH =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';

// The Claude mark as the vscode-icons set (MIT, installed with the app) draws it, 32 x 32.
const CLAUDE_PATH =
  'm7.5 20.61l5.5-3.08l.1-.27l-.1-.15h-.27l-.92-.06a234 234 0 0 1-8.51-.34l-.67-.14l-.62-.82l.06-.41l.56-.38l.8.07c3.08.2 6.15.4 9.21.72h.46l.06-.19l-.16-.1l-.12-.12l-2.74-1.86c-2.04-1.3-3.55-2.43-5.38-3.68l-.43-.54l-.18-1.18l.76-.84l1.03.07l.26.07c2.03 1.6 4.1 3.14 6.17 4.66l.43.36l.17-.12l.02-.09l-.2-.32c-1.43-2.6-2.55-4.62-4-6.96l-.2-.72c-.08-.3-.13-.55-.13-.85l.87-1.18l.49-.16l1.16.16l.49.42c1.4 3.31 2.76 5.93 4.23 8.83l.29.97l.1.3h.19v-.17c.65-3.42 0-6.57 1.22-9.53l.87-.57l.68.33l.56.8l-.08.51c-.37 2.62-.92 5.22-1.4 7.82h.24l.29-.29a69 69 0 0 1 4.91-5.94l.64-.5h1.2l.89 1.32l-.4 1.36a53.5 53.5 0 0 0-4.66 6.47l.09.13l.22-.02c2.4-.57 4.84-.99 7.27-1.4l.97.45l.1.46l-.37.94c-3 .72-6 1.34-9 2.05l-.05.04l.06.07c2.7.26 5.62.3 7.99.47l.92.61l.55.75l-.1.56l-1.4.73c-2.93-.7-5.19-1.22-7.91-1.9h-.22v.13c2.18 2.12 4.6 4.27 6.54 6.07l.15.68l-.38.53l-.4-.06c-2.04-1.43-3.9-3.09-5.8-4.7h-.15v.2l.52.76c1.14 1.79 2.64 3.25 2.87 5.37l-.2.41l-.7.25l-.78-.14a73 73 0 0 1-4.58-7.04l-.17.09l-.78 8.46l-.37.43l-.85.33l-.71-.54l-.38-.87a114 114 0 0 0 1.53-7.97l.2-.73l-.01-.05l-.16.02a77 77 0 0 1-6.23 7.88l-.48.2l-.84-.44l.08-.77l.47-.69c2.07-2.57 3.54-4.66 5.54-7v-.19h-.07l-7.4 4.8l-1.31.17l-.57-.53l.07-.87l.27-.28l2.23-1.53z';

// Grok, Gemini CLI and Antigravity as LobeHub's icons draw them (@lobehub/icons 5.16, MIT), 24 x 24.
const GROK_PATH =
  'M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815';
const GEMINI_CLI_FRAME =
  'M0 4.391A4.391 4.391 0 014.391 0h15.217A4.391 4.391 0 0124 4.391v15.217A4.391 4.391 0 0119.608 24H4.391A4.391 4.391 0 010 19.608V4.391z';
const GEMINI_CLI_FACE =
  'M19.74 1.444a2.816 2.816 0 012.816 2.816v15.48a2.816 2.816 0 01-2.816 2.816H4.26a2.816 2.816 0 01-2.816-2.816V4.26A2.816 2.816 0 014.26 1.444h15.48zM7.236 8.564l7.752 3.728-7.752 3.727v2.802l9.557-4.596v-3.866L7.236 5.763v2.801z';
const ANTIGRAVITY_PATH =
  'M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z';

/** Gemini CLI's mark: a gradient frame round a dark terminal prompt. Its gradient needs an id of its own per mark. */
function GeminiCliMark({ size }: { size: number }) {
  const id = `mu-gemini-cli-${useId().replace(/:/g, '')}`;
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' focusable='false'>
      <defs>
        <linearGradient id={id} gradientUnits='userSpaceOnUse' x1='24' x2='0' y1='6.587' y2='16.494'>
          <stop stopColor='#EE4D5D' />
          <stop offset='.328' stopColor='#B381DD' />
          <stop offset='.476' stopColor='#207CFE' />
        </linearGradient>
      </defs>
      <path d={GEMINI_CLI_FRAME} fill={`url(#${id})`} />
      <path d={GEMINI_CLI_FACE} fill='#1E1E2E' fillRule='evenodd' clipRule='evenodd' />
    </svg>
  );
}

/** A one-colour mark in the text colour. simple-icons draws with the default fill rule, LobeHub's with even-odd. */
const mono = (path: string, size: number, fillRule?: 'evenodd') => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='currentColor' aria-hidden='true' focusable='false'>
    <path d={path} fillRule={fillRule} />
  </svg>
);

export default function ProviderMark({ provider, size = 20 }: { provider: SubscriptionProvider; size?: number }) {
  if (provider === 'openai' || provider === 'openai-codex') return mono(OPENAI_PATH, size);
  if (provider === 'xai') return mono(GROK_PATH, size, 'evenodd');
  if (provider === 'google-gemini-cli') return <GeminiCliMark size={size} />;
  if (provider === 'google-antigravity') return mono(ANTIGRAVITY_PATH, size, 'evenodd');
  return (
    <svg width={size} height={size} viewBox='0 0 32 32' aria-hidden='true' focusable='false'>
      <path fill='#d97757' d={CLAUDE_PATH} />
    </svg>
  );
}
