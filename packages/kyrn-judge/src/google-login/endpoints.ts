/**
 * Google's Cloud Code Assist API, which Gemini CLI and Antigravity talk to,
 * and where it lives. Kept apart from the stream so the providers can be built
 * without loading the Google message conversion (and the SDK behind it).
 */
export const CLOUD_CODE_API = "google-cloud-code";
export const GEMINI_CLI_PROVIDER = "google-gemini-cli";
export const ANTIGRAVITY_PROVIDER = "google-antigravity";

export const CLOUD_CODE_ENDPOINT = "https://cloudcode-pa.googleapis.com";
/** Antigravity's endpoints, in the order its client tries them. */
export const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://autopush-cloudcode-pa.sandbox.googleapis.com",
	CLOUD_CODE_ENDPOINT,
] as const;

/** The Antigravity command line's version mu gives: the lowest that is served Gemini 4 Argon is 1.3.0. */
export const ANTIGRAVITY_CLI_VERSION = "1.4.0";

/**
 * Who mu says it is to Antigravity's backend: its command line. The backend lists and serves a client the models of
 * its kind and version. As the IDE (`antigravity/1.107.0 darwin/arm64`, what mu said before) an account is listed
 * neither Gemini 4 Argon nor the Gemini 3.8 Flash tiers, and a request for one is answered 404. As the command line
 * from 1.3.0 both are listed and served, with every model the IDE has. Raise the version with MU_ANTIGRAVITY_VERSION
 * when Google raises the minimum.
 */
export const antigravityUserAgent = (env: (name: string) => string | undefined = (name) => process.env[name]) =>
	`antigravity/cli/${env("MU_ANTIGRAVITY_VERSION") || env("PI_AI_ANTIGRAVITY_VERSION") || ANTIGRAVITY_CLI_VERSION}`;
