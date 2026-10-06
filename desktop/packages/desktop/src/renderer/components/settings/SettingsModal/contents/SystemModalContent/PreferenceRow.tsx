/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useId } from 'react';
import OneLine from '@/renderer/components/settings/OneLine';

type Nameable = { 'aria-label'?: string; 'aria-labelledby'?: string; children?: React.ReactNode };

/**
 * One row of a settings panel: its title in the body text colour and weight of every settings row (mu's own pages
 * draw theirs the same way), the sentence under it on one line, and its control on the right.
 *
 * A control with nothing to read of its own (a switch) is named by the row's title, so a screen reader says
 * "Notifications, switch, on" rather than "switch, on". A button keeps its own words, and a named control its name.
 */
const PreferenceRow: React.FC<{
  label: string;
  children: React.ReactNode;
  description?: string;
}> = ({ label, children, description }) => {
  const titleId = useId();
  const controls = React.Children.map(children, (child) =>
    React.isValidElement<Nameable>(child) &&
    child.props.children === undefined &&
    !child.props['aria-label'] &&
    !child.props['aria-labelledby']
      ? React.cloneElement(child, { 'aria-labelledby': titleId })
      : child
  );
  return (
    <div className='flex items-center justify-between gap-24px py-12px'>
      <div className='flex-1 min-w-0'>
        <div id={titleId} className='text-14px font-500 leading-22px text-t-primary'>
          {label}
        </div>
        {/* One line; the rest opens from it, its lines balanced. */}
        {description ? <OneLine text={description} /> : null}
      </div>
      <div className='flex-shrink-0'>{controls}</div>
    </div>
  );
};

export default PreferenceRow;
