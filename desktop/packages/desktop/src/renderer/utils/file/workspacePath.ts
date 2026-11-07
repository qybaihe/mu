/** An absolute path on either platform: a POSIX root, a UNC share or a drive letter. */
export const isAbsoluteFilePath = (path: string): boolean =>
  path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path);

/**
 * 把一个路径按写它的人的意思解析：绝对路径原样保留，其余的相对于 `base`（会话的工作区，或者带这个链接的文档所在
 * 目录）。`.` 和 `..` 段被折叠，结果是后端能直接读的一条普通路径。没有 base 时相对路径原样返回。
 *
 * Resolve a path the way its writer meant it: an absolute path stays, anything else is relative to `base` (the
 * conversation's workspace, or the directory of the document that carries the link). `.` and `..` segments are
 * folded so the result is one plain path the backend can read. Without a base a relative path is returned as it is.
 */
export const resolveWorkspacePath = (path: string, base?: string): string => {
  if (!path || isAbsoluteFilePath(path) || !base) return path;
  const root = base.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = root.split('/');
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // The root itself (the leading '' of a POSIX path, or the drive) is never popped.
      if (segments.length > 1) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
};
