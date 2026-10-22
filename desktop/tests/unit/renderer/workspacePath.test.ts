import { describe, expect, it } from 'vitest';
import { isAbsoluteFilePath, resolveWorkspacePath } from '@/renderer/utils/file/workspacePath';

describe('resolveWorkspacePath', () => {
  it('puts a relative path under the workspace', () => {
    expect(resolveWorkspacePath('index.html', '/workspace/demo')).toBe('/workspace/demo/index.html');
    expect(resolveWorkspacePath('./src/a.ts', '/workspace/demo/')).toBe('/workspace/demo/src/a.ts');
  });

  it('folds parent segments without leaving the root', () => {
    expect(resolveWorkspacePath('../shared/x.md', '/workspace/demo')).toBe('/workspace/shared/x.md');
    expect(resolveWorkspacePath('../../../x', '/a')).toBe('/x');
  });

  it('keeps absolute paths on either platform', () => {
    expect(resolveWorkspacePath('/tmp/out.html', '/workspace/demo')).toBe('/tmp/out.html');
    expect(resolveWorkspacePath('C:\\out\\a.html', '/workspace/demo')).toBe('C:\\out\\a.html');
    expect(resolveWorkspacePath('\\\\share\\a.html', '/workspace/demo')).toBe('\\\\share\\a.html');
  });

  it('resolves against a Windows workspace', () => {
    expect(resolveWorkspacePath('docs\\a.md', 'C:\\proj')).toBe('C:/proj/docs/a.md');
    expect(resolveWorkspacePath('../a.md', 'C:/proj')).toBe('C:/a.md');
  });

  it('returns a relative path as it is without a base', () => {
    expect(resolveWorkspacePath('index.html')).toBe('index.html');
    expect(resolveWorkspacePath('', '/workspace')).toBe('');
  });

  it('recognizes absolute paths', () => {
    expect(isAbsoluteFilePath('/Users/demo')).toBe(true);
    expect(isAbsoluteFilePath('D:/x')).toBe(true);
    expect(isAbsoluteFilePath('\\\\host\\share')).toBe(true);
    expect(isAbsoluteFilePath('index.html')).toBe(false);
    expect(isAbsoluteFilePath('./index.html')).toBe(false);
  });
});
