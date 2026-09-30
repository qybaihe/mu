/**
 * The person's own words. A host may put its instructions in front of what the person typed: AionUi's core prefixes the
 * first message of a conversation with `[Assistant Rules] … [/Assistant Rules]`, its skill list, some 1,600 characters.
 * That text is for the main model; the person did not write it and does not see it in AionUi. The same rule as the
 * harness's `userWords`.
 */
const HOST_PREAMBLE = /^\s*\[Assistant Rules\][\s\S]*?\[\/Assistant Rules\]\s*/i;

/** The text without a host's preamble in front of it: '' when the text was nothing else. */
export const withoutHostPreamble = (text: string): string => text.replace(HOST_PREAMBLE, '');

/** What the person said in a message they sent: the text without a host's preamble, or the text itself when that is all it was. */
export const wordsOf = (text: string): string => {
  const said = withoutHostPreamble(text);
  return said.trim() ? said : text;
};
