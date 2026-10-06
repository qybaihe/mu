import React from 'react';

/** How many a group holds: a small grey pill after its title, as the settings tabs count. */
export default function Count({ value }: { value: number }) {
  return (
    <span className='inline-flex h-16px min-w-16px items-center justify-center rounded-999px px-5px text-10px font-500 leading-none bg-fill-2 text-t-tertiary'>
      {value}
    </span>
  );
}
