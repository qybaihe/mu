/** The defaults with the overrides on top; nested objects are merged, not replaced. */
export function mergeConfig(defaults, overrides) {
	return { ...defaults, ...overrides };
}
