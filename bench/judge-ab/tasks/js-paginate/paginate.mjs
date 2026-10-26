/** Page `page` (1-based) of `items`, `size` per page. */
export function paginate(items, page, size) {
	const start = page * size;
	return items.slice(start, start + size);
}
