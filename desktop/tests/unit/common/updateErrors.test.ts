import { describe, expect, it } from 'vitest';
import { classifyUpdateError, UpdateError, updateErrorDetail } from '@/common/update/updateErrors';

describe('classifyUpdateError', () => {
  it('keeps the code of our own UpdateError', () => {
    const error = new UpdateError({ code: 'downloadFailed' }, 'Download host is not allowed: evil.test');
    expect(classifyUpdateError(error, 'checkFailed')).toEqual({ code: 'downloadFailed' });
    expect(updateErrorDetail(error)).toBe('Download host is not allowed: evil.test');
  });

  it('finds a network failure in the cause Node fetch hides it in', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND updates.example.com'), { code: 'ENOTFOUND' });
    expect(classifyUpdateError(new TypeError('fetch failed', { cause }), 'checkFailed')).toEqual({ code: 'network' });
  });

  it('recognizes Chromium network errors from electron-updater', () => {
    expect(classifyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'), 'checkFailed')).toEqual({
      code: 'network',
    });
    expect(
      classifyUpdateError(
        new Error('Cannot find channel "latest-mac.yml" update info: net::ERR_NAME_NOT_RESOLVED'),
        'checkFailed'
      )
    ).toEqual({ code: 'network' });
  });

  it('tells a timeout apart', () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(classifyUpdateError(abort, 'checkFailed')).toEqual({ code: 'timeout' });
    expect(classifyUpdateError(new Error('net::ERR_TIMED_OUT'), 'checkFailed')).toEqual({ code: 'timeout' });
    expect(classifyUpdateError(new Error('net::ERR_CONNECTION_TIMED_OUT'), 'checkFailed')).toEqual({ code: 'timeout' });
  });

  it('reports a missing update file as no update information', () => {
    expect(
      classifyUpdateError(
        new Error('Cannot find latest-mac.yml in the latest release artifacts (https://x): HttpError: 404'),
        'checkFailed'
      )
    ).toEqual({ code: 'noUpdateInfo' });
  });

  it('keeps the HTTP status of other server errors', () => {
    expect(classifyUpdateError(new Error('HttpError: 503 Service Unavailable'), 'checkFailed')).toEqual({
      code: 'serverError',
      status: 503,
    });
  });

  it('falls back to the step that failed', () => {
    expect(classifyUpdateError(new Error('something odd'), 'checkFailed')).toEqual({ code: 'checkFailed' });
    expect(classifyUpdateError('plain string', 'downloadFailed')).toEqual({ code: 'downloadFailed' });
  });
});
