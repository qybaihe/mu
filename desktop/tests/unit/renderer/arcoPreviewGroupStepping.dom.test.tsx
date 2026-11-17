import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Image from '@arco-design/web-react/es/Image/image';
import ImagePreviewGroup from '@arco-design/web-react/es/Image/image-preview-group';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The patched Arco group preview (patches/@arco-design+web-react@2.66.11.patch): a group's image ids come from a
 * counter every Arco image in the app shares, so they are not 0..n-1. Upstream jumpTo treated an id as a dense
 * position, so in a mu conversation — where avatars, tool images and streamed replies consume ids first — clicking
 * a reply's image disabled both arrows and the arrow keys did nothing. With the patch, stepping walks the group's
 * registration order instead.
 */

const SRC = (name: string) => `data:image/png;base64,${name}`;

/** Mount throwaway images outside any group and unmount them: their ids are consumed forever. */
function consumeImageIds(count: number): void {
  const { unmount } = render(
    <div>
      {Array.from({ length: count }, (_, i) => (
        <Image key={i} src={SRC(`gone-${i}`)} />
      ))}
    </div>
  );
  unmount();
}

/** jsdom never fires a real load; trigger it so each thumbnail becomes previewable. */
const markLoaded = () => screen.getAllByRole('img').forEach((img) => fireEvent.load(img));

/** The preview's large image carries no alt: match it by class and src marker. */
const stepped = async (marker: string) => {
  await waitFor(() => {
    expect(document.querySelector('.arco-image-preview-img')?.getAttribute('src')).toContain(marker);
  });
  return document.querySelector('.arco-image-preview-img') as HTMLImageElement;
};

describe('a patched ImagePreviewGroup steps through images whose ids are not 0..n-1', () => {
  afterEach(cleanup);

  it('moves to the next and previous image, arrows enabled at neither end', async () => {
    consumeImageIds(5);
    render(
      <ImagePreviewGroup>
        <Image src={SRC('one')} alt='one' />
        <Image src={SRC('two')} alt='two' />
        <Image src={SRC('three')} alt='three' />
      </ImagePreviewGroup>
    );
    markLoaded();
    fireEvent.click(screen.getByAltText('two'));

    const preview = await stepped('two');
    expect(preview.className).toContain('arco-image-preview-img');
    // Ids here are 5, 6, 7: upstream read 6 as position 6 in a 3-image list and disabled every arrow.
    const left = document.querySelector('.arco-image-preview-arrow-left');
    const right = document.querySelector('.arco-image-preview-arrow-right');
    expect(left?.className).not.toContain('arrow-disabled');
    expect(right?.className).not.toContain('arrow-disabled');

    fireEvent.click(right!);
    expect((await stepped('three')).getAttribute('src')).toContain('three');

    fireEvent.click(left!);
    fireEvent.click(left!);
    expect((await stepped('one')).getAttribute('src')).toContain('one');
    expect(document.querySelector('.arco-image-preview-arrow-left')?.className).toContain('arrow-disabled');
  });
});
