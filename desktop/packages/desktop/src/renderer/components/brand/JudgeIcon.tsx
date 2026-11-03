import React from 'react';
import { IconWrapper } from '@icon-park/react/es/runtime';

/**
 * The judge's mark as an icon: the diamond of a conversation's judge lines (◆), an outline with a solid core. It is
 * drawn on IconPark's 48-unit grid with IconWrapper, so it takes the same props (size, strokeWidth, fill, theme) as the
 * icons beside it in the work panel's tabs and the settings rail.
 */
const JudgeIcon = IconWrapper('mu-judge', false, (props) => (
  <svg width={props.size} height={props.size} viewBox='0 0 48 48' fill='none'>
    <path
      d='M24 5L43 24L24 43L5 24Z'
      fill={props.colors[1]}
      stroke={props.colors[0]}
      strokeWidth={props.strokeWidth}
      strokeLinejoin={props.strokeLinejoin}
    />
    <path d='M24 17L31 24L24 31L17 24Z' fill={props.colors[0]} />
  </svg>
));

export default JudgeIcon;
