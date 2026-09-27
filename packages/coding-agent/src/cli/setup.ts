import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";

/**
 * Whether naming the process is safe. On macOS, renaming a process that runs an app bundle's Electron binary as Node
 * (ELECTRON_RUN_AS_NODE, how the mu desktop app runs pi) registers it with LaunchServices as a foreground app: a Dock
 * icon that bounces until the process exits, one per session.
 */
export function canNameProcess(platform: NodeJS.Platform, electron: string | undefined): boolean {
	return !(platform === "darwin" && electron);
}

export function nameProcess(title: string): void {
	if (canNameProcess(process.platform, process.versions.electron)) process.title = title;
}

export function setupCli(): void {
	nameProcess(APP_NAME);
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	configureHttpDispatcher();
}
