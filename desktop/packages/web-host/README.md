# @mu/web-host

WebUI host package for mu - zero Electron dependency.

## Responsibilities

- **backend-launcher**: spawn or reuse an existing backend process
- **static-server**: serve out/renderer SPA + reverse proxy /api and /ws to backend
- **auth**: password reset, change, verify, config I/O (bcrypt + session)

## Usage

```ts
import { startWebHost } from '@mu/web-host';

const handle = await startWebHost({
  app: {
    version: '1.0.0',
    isPackaged: false,
    resourcesPath: '/path/to/resources',
    userDataPath: '/path/to/userData',
  },
  staticDir: '/path/to/out/renderer',
  backend: {
    kind: 'ownBackend',
    resolveBackend: () => '/path/to/backend-binary',
  },
});

console.log(`WebUI running at ${handle.url}`);

await handle.stop();
```

## Status

M3: skeleton + type definitions + placeholder implementations (all throw `not implemented yet`)
