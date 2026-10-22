import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SelectHandle } from '@arco-design/web-react/es/Select/interface';
import MuSelect from '@/renderer/components/base/MuSelect';

// A multiple select's focus goes to Arco's typing input among its tags, which had no name: the judges page's order
// field read as "text field" alone.

afterEach(cleanup);

const options = [
  { value: 'jev', label: 'Jev' },
  { value: 'laya', label: 'Laya' },
];

describe('a multiple select', () => {
  it('gives its typing input the select’s own name', () => {
    render(<MuSelect mode='multiple' aria-label='Judge order' options={options} value={['jev']} />);
    expect(screen.getByRole('textbox', { name: 'Judge order' })).toBeInTheDocument();
  });

  it('still hands its owner the select itself', () => {
    const ref = React.createRef<SelectHandle>();
    render(<MuSelect ref={ref} aria-label='Language' options={options} value='jev' />);
    expect(ref.current?.dom).toBeInstanceOf(HTMLElement);
    expect(typeof ref.current?.blur).toBe('function');
  });
});
