/**
 * What the model should do after a failure it cannot fix by itself, by the failure's code. The reason says what went
 * wrong; this line says who can fix it and whether trying again helps, so the model neither retries a call that
 * fails the same way each time nor stops the task over a capability it can do without.
 */
export function nextStep(code: string | undefined, params?: Readonly<Record<string, unknown>>): string {
	switch (code) {
		case "project_untrusted":
			return "Next: only the user can trust this project. Tell them the server is defined by the project, and carry on without it.";
		case "needs_approval":
			return "Next: only the user can approve it, by starting mu in this folder interactively and opening it once. Tell them, and carry on without it.";
		case "denied":
			return "Next: the user said no. Do not open it again in this conversation; carry on without it.";
		case "needs_sign_in": {
			const server = typeof params?.server === "string" ? ` ${params.server}` : "";
			return `Next: only the user can sign in. Tell them to run /mcp login${server}, then open it again; until then carry on without it.`;
		}
		case "timeout":
			return "Next: opening it once more may work. If it times out again, carry on without it and tell the user.";
		case "missing_program":
			return "Next: installing a program changes the user's machine, so ask the user before you do; until then carry on with the tools you have.";
		case "sandbox_unavailable":
			return "Next: every command will be refused the same way, so do not run it again. Tell the user the write sandbox cannot start here; they can fix the cause, or turn it off with features.confine: false in ~/.mu/agent/mu.json.";
		default:
			return "Next: opening it again fails the same way until the cause above is fixed. Carry on without it, and tell the user what failed if the task needs it.";
	}
}
