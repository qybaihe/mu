import React from 'react';

/**
 * A model as a settings picker offers it: by the name its provider gives it ("GPT-5.6 Terra"), with its id in the
 * tooltip, or by its id when it has no name. `tag` follows the name ("recommended"). The value stays the id.
 */
export const modelOption = (id: string, name: string, tag?: string) => {
  const shown = name.trim() || id;
  return { value: id, label: <span title={id}>{tag ? `${shown} · ${tag}` : shown}</span>, extra: name };
};

/** A model picker's search: a typed word finds a model by its name or by its id. */
export function filterModelOption(input: string, option: React.ReactElement): boolean {
  const { value, extra } = option.props as { value?: unknown; extra?: unknown };
  const query = input.trim().toLowerCase();
  return [value, extra].some((text) => typeof text === 'string' && text.toLowerCase().includes(query));
}

/** The names of a provider's models, by id, from whichever list has them. */
export const modelNamesOf = (models: readonly { id: string; name: string }[]): Map<string, string> =>
  new Map(models.map((model) => [model.id, model.name]));
