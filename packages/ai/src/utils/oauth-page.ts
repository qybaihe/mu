/**
 * The page a sign-in ends on in the browser: mu's mark, one line saying whether it worked, and the
 * provider's own sentence. Every OAuth flow here (ChatGPT, Claude, OpenRouter, Radius) and mu's own
 * Google sign-ins render it, so a person sees the same page whichever account they connect.
 */

// The mu glyph and its tile, as the desktop draws them (components/brand/glyph.ts): three round-capped
// strokes in a 100x100 box over the icon's diagonal gradient. Fixed brand colours on purpose.
const MU_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" aria-hidden="true"><defs><linearGradient id="mu-tile" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#F3C6FA"/><stop offset="0.5" stop-color="#B79CF7"/><stop offset="1" stop-color="#8680EB"/></linearGradient></defs><rect width="100" height="100" rx="27" fill="url(#mu-tile)"/><path d="M41 32 L35 74.4 M38.9 47 C37.77 55 41 59.4 47.6 59.4 C54.8 59.4 61.05 54.5 61.9 48.5 M64.25 32 L61.35 52.5 C60.6 58 62.3 61.2 66.4 60.4" stroke="#FFFFFF" stroke-width="9.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// The same mark as the tab icon, so the browser tab shows mu rather than a blank page icon.
const MU_FAVICON = `data:image/svg+xml,${encodeURIComponent(MU_MARK_SVG)}`;

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderPage(options: { heading: string; message: string; details?: string }): string {
	const title = escapeHtml(`${options.heading} · mu`);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;

	// White in light mode, black in dark mode; colour only on the mark itself.
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>${title}</title>
  <link rel="icon" type="image/svg+xml" href="${MU_FAVICON}" />
  <style>
    :root {
      color-scheme: light dark;
      --text: #111111;
      --text-dim: #6b6b70;
      --page-bg: #ffffff;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --text: #f4f4f5;
        --text-dim: #9a9aa1;
        --page-bg: #000000;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 520px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .mark {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 28px;
    }
    .mark svg { display: block; width: 100%; height: 100%; }
    h1 {
      margin: 0 0 10px;
      font-size: 26px;
      line-height: 1.2;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="mark">${MU_MARK_SVG}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string): string {
	return renderPage({ heading: "Signed in", message });
}

export function oauthErrorHtml(message: string, details?: string): string {
	return renderPage({ heading: "Sign-in did not complete", message, details });
}
