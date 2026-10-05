/**
 * What a server inherits from mu's own environment. Not everything: mu's
 * environment holds model keys, and a server has no business reading them.
 * This is the list the reference SDK uses, plus what `npx`-style servers need
 * behind a proxy or a mirror. Anything else a server needs is named in its
 * definition (`env`, or a `${VAR}` placeholder).
 */
const INHERITED: readonly string[] = [
	"HOME",
	"LOGNAME",
	"PATH",
	"SHELL",
	"TERM",
	"USER",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TZ",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"NVM_DIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"NODE_EXTRA_CA_CERTS",
	"NPM_CONFIG_REGISTRY",
	"APPDATA",
	"COMSPEC",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"USERNAME",
	"USERPROFILE",
	"WINDIR",
];

export function serverEnvironment(
	parent: Readonly<Record<string, string | undefined>>,
	own: Readonly<Record<string, string>>,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(parent)) {
		// Case-insensitive, because Windows spells it `Path` and proxies are often set in lower case.
		if (value !== undefined && INHERITED.includes(key.toUpperCase())) env[key] = value;
	}
	return { ...env, ...own };
}
