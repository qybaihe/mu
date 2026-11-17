/**
 * Which texts are about the same thing, by the terms they share: a rule that picks the few candidates worth a judge's
 * question each, where asking about all of them costs one question per candidate on every call. The lessons a new one
 * is held against (memory/store.ts) and the hidden skills a message may need (extension/features/skills.ts) are
 * picked this way.
 */

/** Words that say nothing about what a text is about. */
const FILLER = new Set([
	"the",
	"and",
	"for",
	"with",
	"when",
	"this",
	"that",
	"from",
	"into",
	"are",
	"was",
	"were",
	"you",
	"your",
	"its",
	"has",
	"have",
	"will",
	"then",
	"than",
	"there",
	"which",
	"what",
	"should",
	"would",
	"could",
	"been",
	"about",
]);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/**
 * The terms two texts can share: words of three letters or more, and pairs of neighbouring
 * characters in Chinese, Japanese or Korean, which are written without spaces.
 */
export function terms(text: string): Set<string> {
	const lower = text.toLowerCase();
	const found = new Set<string>();
	for (const run of lower.match(CJK) ?? []) {
		if (run.length === 1) found.add(run);
		for (let index = 0; index + 1 < run.length; index++) found.add(run.slice(index, index + 2));
	}
	for (const raw of lower.replace(CJK, " ").match(/[\p{L}\p{N}_./-]+/gu) ?? []) {
		const word = raw.replace(/^[._/-]+|[._/-]+$/g, "");
		if (word.length >= 3 && !FILLER.has(word)) found.add(word);
	}
	return found;
}

/**
 * The `items` whose text shares a term with `text`, at most `limit`: those that share the most first, relative to the
 * shorter of the two. An item that shares none is left out, so a text about something else finds nothing.
 */
export function sharingTerms<T>(text: string, items: readonly T[], textOf: (item: T) => string, limit: number): T[] {
	const mine = terms(text);
	if (mine.size === 0 || limit <= 0) return [];
	const scored: { item: T; overlap: number }[] = [];
	for (const item of items) {
		const theirs = terms(textOf(item));
		let shared = 0;
		for (const term of mine) if (theirs.has(term)) shared++;
		if (shared > 0) scored.push({ item, overlap: shared / Math.min(mine.size, theirs.size) });
	}
	return scored
		.sort((a, b) => b.overlap - a.overlap)
		.slice(0, limit)
		.map((entry) => entry.item);
}
