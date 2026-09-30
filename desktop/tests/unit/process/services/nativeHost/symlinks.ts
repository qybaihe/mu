import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Whether this system lets a test make a link. Windows does only to an account with the privilege (a developer's
 * machine with Developer Mode on, an administrator); a test of how a link is read is skipped where it cannot be made.
 */
export function canSymlink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'mu-link-'));
  try {
    symlinkSync(dir, join(dir, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
