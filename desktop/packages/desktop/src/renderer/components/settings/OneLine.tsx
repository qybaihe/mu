import React, { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@arco-design/web-react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import styles from './OneLine.module.css';

/**
 * Where the line has no width to measure (a page drawn while hidden, or a test without layout), how many columns a
 * sentence may take before it is taken to be cut: a CJK character takes two, anything else one.
 */
const ESTIMATED_COLUMNS = 96;
const columns = (text: string): number => {
  let count = 0;
  for (const character of text) count += /[⺀-鿿가-힯＀-￯]/.test(character) ? 2 : 1;
  return count;
};

type OneLineProps = {
  text: string;
  className?: string;
  testId?: string;
};

/**
 * The sentence under a setting, on one line: whatever does not fit is cut with an ellipsis, the whole sentence is in
 * the tooltip, and a small "Learn more" after it opens the rest, its lines balanced. A sentence that fits has nothing to
 * open.
 */
export default function OneLine({ text, className, testId }: OneLineProps) {
  const { t } = useTranslation();
  const line = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    const element = line.current;
    if (!element || open) return undefined;
    const measure = () =>
      setCut(
        element.clientWidth > 0 ? element.scrollWidth > element.clientWidth + 1 : columns(text) > ESTIMATED_COLUMNS
      );
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);

  if (!text) return null;
  return (
    <div className={classNames(styles.line, open && styles.lineOpen, className)} data-testid={testId}>
      <span ref={line} className={open ? styles.open : styles.text} title={open ? undefined : text}>
        {text}
      </span>
      {cut || open ? (
        <Button
          type='text'
          size='mini'
          className={styles.more}
          aria-expanded={open}
          onClick={() => setOpen((now) => !now)}
        >
          {open ? t('settings.showLess') : t('settings.learnMore')}
        </Button>
      ) : null}
    </div>
  );
}
