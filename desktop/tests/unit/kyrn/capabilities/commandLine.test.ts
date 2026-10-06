import { describe, expect, it } from 'vitest';
import { readPairLines, splitCommandLine } from '@/renderer/pages/settings/MuCapabilities/commandLine';

describe('the command line of a new MCP server', () => {
  it('splits at spaces as a terminal does, keeping quoted words whole', () => {
    expect(splitCommandLine('npx -y @modelcontextprotocol/server-filesystem ~/Documents')).toEqual([
      'npx',
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '~/Documents',
    ]);
    expect(splitCommandLine('  node  "/Applications/My Tools/server.js"   --name \'a b\' ')).toEqual([
      'node',
      '/Applications/My Tools/server.js',
      '--name',
      'a b',
    ]);
    // A backslash keeps the next character, except inside single quotes; an empty pair of quotes is a word.
    expect(splitCommandLine('run My\\ Folder "say \\"hi\\"" \'C:\\tmp\' ""')).toEqual([
      'run',
      'My Folder',
      'say "hi"',
      'C:\\tmp',
      '',
    ]);
    expect(splitCommandLine('   ')).toEqual([]);
  });

  it('answers nothing for a quote left open', () => {
    expect(splitCommandLine('node "server.js')).toBeUndefined();
    expect(splitCommandLine("echo 'it")).toBeUndefined();
  });
});

describe('the lines of variables and headers', () => {
  it('reads one name and value a line, blank lines skipped, the value as it is after the first separator', () => {
    expect(readPairLines('API_KEY=abc=def\n\n  REGION = eu \r\n', '=')).toEqual({
      pairs: { API_KEY: 'abc=def', REGION: 'eu' },
    });
    expect(readPairLines('Authorization: Bearer x:y\nX-Team:  core', ':')).toEqual({
      pairs: { Authorization: 'Bearer x:y', 'X-Team': 'core' },
    });
    expect(readPairLines('', '=')).toEqual({ pairs: {} });
  });

  it('names the first line that is not a name and a value', () => {
    expect(readPairLines('A=1\nno separator', '=')).toEqual({ badLine: 2 });
    expect(readPairLines('=value', '=')).toEqual({ badLine: 1 });
    expect(readPairLines('A=1\n\nTWO WORDS=2', '=')).toEqual({ badLine: 3 });
  });
});
