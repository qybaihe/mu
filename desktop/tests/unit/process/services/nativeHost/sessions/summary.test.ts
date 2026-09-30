import { describe, expect, it } from 'vitest';
import {
  TITLE_LENGTH,
  clip,
  maskSecrets,
} from '../../../../../../packages/desktop/src/process/services/nativeHost/sessions/summary.ts';

/**
 * A conversation's title from the start of its first message: the person's own words, one line, not too long, with no
 * token in it (a title is shown in the sidebar, the palette, a notification and a screenshot).
 */

const PREAMBLE =
  '[Assistant Rules]\n## Available Skills\n\n- **cron**: Scheduled task management\n\nTo get a skill, run `cat`.\n[/Assistant Rules]\n\n';

describe('clip', () => {
  it('takes the first line with text, spaces collapsed, at most TITLE_LENGTH characters', () => {
    expect(clip('  \n  Why does\tthe build   fail?\nIt says ENOENT')).toBe('Why does the build fail?');
    expect(clip('é'.repeat(TITLE_LENGTH + 20))).toBe('é'.repeat(TITLE_LENGTH));
    expect(clip('   \n  ')).toBe('');
  });

  it('leaves AionUi’s rules preamble out: the words after it are the title', () => {
    expect(clip(`${PREAMBLE}Refactor the parser`)).toBe('Refactor the parser');
    expect(clip(`  [assistant rules]\nx\n[/assistant rules]\r\n\r\n先看一下这个服务`)).toBe('先看一下这个服务');
    // A message that is the preamble and nothing else has no words to title it by.
    expect(clip(PREAMBLE)).toBe('');
  });

  it('leaves the files attached in front of a message out, unless they are all there is', () => {
    expect(clip('@"/Users/a b/c.pdf" 你看一下这个')).toBe('你看一下这个');
    expect(clip("@'/tmp/x y.txt' @src/App.tsx @notes.md fix it")).toBe('fix it');
    expect(clip(`${PREAMBLE}@"/Users/a/b.pdf" summarize it`)).toBe('summarize it');
    // A handle is not a file, and a message of attachments only is titled by them.
    expect(clip('@claude fix it')).toBe('@claude fix it');
    expect(clip('@"/Users/a/b.pdf"')).toBe('@"/Users/a/b.pdf"');
    // Only at the start.
    expect(clip('look at @src/App.tsx please')).toBe('look at @src/App.tsx please');
  });

  it('masks a token before it clips, so a token cut short by the clip is not shown either', () => {
    const token = `ghp_${'A1b2'.repeat(9)}`;
    expect(clip(token)).toBe('ghp_••••');
    const late = clip(`${'x'.repeat(TITLE_LENGTH - 10)} ${token}`);
    expect(late).toBe(`${'x'.repeat(TITLE_LENGTH - 10)} ghp_••••`);
    expect(late).not.toContain('A1b2');
  });
});

describe('maskSecrets', () => {
  it('masks the tokens tools hand out, keeping what they start with', () => {
    const body = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
    expect(maskSecrets(`ghp_${body}`)).toBe('ghp_••••');
    // Copied out of markdown, where the underscore is escaped.
    expect(maskSecrets(`ghp\\_${body} 新pr`)).toBe('ghp\\_•••• 新pr');
    expect(maskSecrets(`github_pat_11${body}_zz`)).toBe('github_pat_••••');
    expect(maskSecrets(`use sk-ant-api03-${body}-x please`)).toBe('use sk-ant-•••• please');
    expect(maskSecrets(`sk-proj-${body}`)).toBe('sk-proj-••••');
    expect(maskSecrets(`AIza${body}${body.slice(0, 8)}`)).toBe('AIza••••');
    expect(maskSecrets('AKIAABCDEFGHIJKLMNOP is the id')).toBe('AKIA•••• is the id');
    expect(maskSecrets(`xoxb-1234567890-${body}`)).toBe('xoxb-••••');
    expect(maskSecrets(`Authorization: Bearer ${body}`)).toBe('Authorization: Bearer ••••');
    expect(maskSecrets(`eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${body}`)).toBe('eyJ••••');
  });

  it('masks a private key from its header to its end line, or to the end of the text', () => {
    const body = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA${body}\n${body}\n-----END OPENSSH PRIVATE KEY-----`;
    expect(maskSecrets(pem)).toBe('-----BEGIN OPENSSH PRIVATE KEY-----••••');
    expect(maskSecrets(`use this: ${pem} thanks`)).toBe('use this: -----BEGIN OPENSSH PRIVATE KEY-----•••• thanks');
    // Pasted on one line, escaped by markdown, or with no end line: all after the header goes.
    expect(maskSecrets(`-----BEGIN RSA PRIVATE KEY----- ${body} ${body}`)).toBe('-----BEGIN RSA PRIVATE KEY-----••••');
    expect(maskSecrets(`\\${pem}`)).toBe('\\-----BEGIN OPENSSH PRIVATE KEY-----••••');
    expect(maskSecrets(`-----BEGIN PRIVATE KEY-----\n${body}`)).toBe('-----BEGIN PRIVATE KEY-----••••');
    // A public key is not secret.
    expect(maskSecrets(`-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`)).toContain(body);
  });

  it('gives a message that opens with a private key the header as its title, and nothing of the key', () => {
    const body = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
    const title = clip(`-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEAAAAABG5v${body} ${body}`);
    expect(title).toBe('-----BEGIN OPENSSH PRIVATE KEY-----••••');
  });

  it('leaves ordinary text alone', () => {
    for (const text of [
      'Fix the login page',
      'sk-learn-tutorial-cross-validation-notes',
      'ghp_short',
      'task-manager-prototype-something-long',
      'the AKIA prefix is for access key ids',
      'Bearer of bad news',
    ])
      expect(maskSecrets(text)).toBe(text);
  });
});
