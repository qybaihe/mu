/**
 * The native host's shared layer (docs/native-host.md): pi's RPC records as the app reads them, the judgment layer's
 * presentation frames, and the reducer that turns either a live stream or a session file into one conversation view.
 * No Node APIs: the main process uses it now, the renderer's conversation surface later.
 */
export * from './presentation.ts';
export * from './records.ts';
export * from './reducer.ts';
export * from './settings.ts';
export * from './view.ts';
export * from './words.ts';
