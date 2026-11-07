/**
 * Where the conversations an import would bring come from: each tool's mark, its name and how many it has that are
 * not in the app yet or changed since (common/kyrn/importChats.ts). The first-run guide and the settings show it
 * beside the way into the import dialog.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { IMPORT_TOOL_NAMES, importableByTool, type FoundChat } from '@/common/kyrn/importChats';
import ImportToolMark from '@/renderer/components/brand/ImportToolMark';
import { formatNumber } from '@/renderer/services/i18n/format';

const ImportSources: React.FC<{ chats: readonly FoundChat[] }> = ({ chats }) => {
  const { i18n } = useTranslation();
  const sources = importableByTool(chats);
  if (sources.length === 0) return null;
  return (
    <ul className='m-0 p-0 list-none flex flex-wrap gap-8px' data-testid='import-sources'>
      {sources.map(({ tool, count }) => (
        <li
          key={tool}
          className='flex items-center gap-6px px-10px py-4px rd-full border border-solid border-border-2 bg-fill-1 text-13px leading-20px text-t-primary'
          data-tool={tool}
        >
          <ImportToolMark tool={tool} size={16} />
          <span>{IMPORT_TOOL_NAMES[tool]}</span>
          <span className='text-t-tertiary [font-variant-numeric:tabular-nums]'>
            {formatNumber(count, i18n.language)}
          </span>
        </li>
      ))}
    </ul>
  );
};

export default ImportSources;
