# Translations

mu's text comes in several languages, depending on where it appears. Corrections from native speakers are especially welcome: open a pull request that changes the strings, or an issue that quotes the wrong text and suggests a better one.

| What | Languages | Where |
| --- | --- | --- |
| The desktop app | 13: English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Español, Français, Português (BR), Русский, Українська, Türkçe, فارسی | `desktop/packages/desktop/src/renderer/services/i18n/locales/<locale>/*.json` |
| The kernel's settings text (decision points, features, options) | Chinese and English in code, 11 more in a catalog | `packages/kyrn-judge/src/manifest.ts`, `packages/kyrn-judge/i18n/manifest.json` |
| The kernel's own messages in a session | Chinese and English | `say({ zh, en })` in `packages/kyrn-judge/src/` |
| Kernel messages shown in the app | The app's 13 | Presentation codes, worded by the app ([codes](../kyrn/docs/features/presentation-codes.md)) |
| The README | English, 简体中文, 繁體中文, 日本語, 한국어 | `README.md`, `docs/readme/README.<lang>.md` |

The rest of the documentation is in English, and the design notes in `kyrn/docs/` are mostly in Chinese. For how mu's English should read, see the [writing style guide](writing-style.md).

## The desktop app

Strings are i18n keys in JSON files, with one folder per locale; `en-US` is the source. If you change a key's English, make the same change in every locale.

```bash
cd desktop
node scripts/generate-i18n-types.js   # after adding or removing keys: regenerates i18n-keys.d.ts
node scripts/check-i18n.js            # every locale has every key, and the types are in sync
```

Guidelines:

- Translate the meaning for someone using the app, not word for word. Keep it short: buttons and labels are narrow.
- Keep placeholders exactly as they are (`{{count}}`, `{{name}}`), along with the plural forms the locale needs (`_one`, `_other`, and `_few` and `_many` for Slavic languages).
- Leave names as they are: mu, Jev, Laya, pi, MCP, and model and provider names.
- Keep commands, paths, keys and code in English (`/permissions`, `mu.json`).

## The kernel's settings text

`src/manifest.ts` holds the Chinese and the English. `i18n/manifest.json` holds the other languages, and each entry stores the English it was translated from, so a changed English string shows which translations are stale. After editing either file:

```bash
node packages/kyrn-judge/scripts/write-manifest.ts   # writes packages/kyrn-judge/manifest.json
node scripts/write-docs-reference.mjs                # regenerates docs/reference/
```

The script warns about entries whose English has changed since they were translated, and those entries show in English until someone translates them again. If you only reworded the English and the meaning is the same, copy the new English into the entry's `en` in `i18n/manifest.json` so the translations stay.

## Adding a language

Open an issue first. A new language needs an entry in the app's language list, a full set of the app's strings and the kernel catalog, and someone willing to keep it up to date.
