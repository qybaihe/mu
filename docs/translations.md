# Translations

mu speaks several languages in different places. Corrections from native speakers are especially welcome: open a pull request that changes the strings, or an issue that quotes the wrong text and suggests a better one.

| What | Languages | Where |
| --- | --- | --- |
| The desktop app | 13: English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Español, Français, Português (BR), Русский, Українська, Türkçe, فارسی | `desktop/packages/desktop/src/renderer/services/i18n/locales/<locale>/*.json` |
| Settings text of the kernel (decision points, features, options) | Chinese and English in code, 11 more in a catalog | `packages/kyrn-judge/src/manifest.ts`, `packages/kyrn-judge/i18n/manifest.json` |
| The kernel's own messages in a session | Chinese and English | `say({ zh, en })` in `packages/kyrn-judge/src/` |
| Messages the app shows from the kernel | The app's 13 | Presentation codes, worded by the app ([codes](../kyrn/docs/features/presentation-codes.md)) |
| The README | English, 简体中文, 繁體中文, 日本語, 한국어 | `README.md`, `docs/readme/README.<lang>.md` |

The rest of the documentation is in English, and the design notes in `kyrn/docs/` are mostly in Chinese.

## The desktop app

Strings are i18n keys in JSON files, one folder per locale; `en-US` is the source. A change to a key's English needs the same change in every locale.

```bash
cd desktop
node scripts/generate-i18n-types.js   # after adding or removing keys: regenerates i18n-keys.d.ts
node scripts/check-i18n.js            # every locale has every key, and the types are in sync
```

Guidelines:

- Translate the meaning for a person using the app, not word for word. Keep it short: buttons and labels are narrow.
- Keep placeholders exactly as they are (`{{count}}`, `{{name}}`), and the plural forms the locale needs (`_one`, `_other`, and for Slavic languages `_few` and `_many`).
- Names stay as they are: mu, Jev, Laya, pi, MCP, and model and provider names.
- Commands, paths, keys and code stay in English (`/permissions`, `mu.json`).

## The kernel's settings text

`src/manifest.ts` holds the Chinese and the English; `i18n/manifest.json` holds the other languages, each entry with the English it was translated from, so a changed English shows which translations are stale. After editing either:

```bash
node packages/kyrn-judge/scripts/write-manifest.ts   # writes packages/kyrn-judge/manifest.json
node scripts/write-docs-reference.mjs                # regenerates docs/reference/
```

The script warns about entries whose English changed since they were translated.

## Adding a language

Open an issue first: a new language needs the app's language list, a full set of the app's strings and of the kernel catalog, and someone willing to keep it current.
