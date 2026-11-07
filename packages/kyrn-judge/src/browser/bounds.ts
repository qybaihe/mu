import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type AddressClass, classifyAddress } from "../web/ssrf.ts";

/** Every address a host name has. */
export type ResolveHost = (host: string) => Promise<readonly string[]>;

/** How long a name may take to resolve before it counts as somewhere on the web. */
const RESOLVE_MS = 2_000;

async function systemResolve(host: string): Promise<readonly string[]> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			lookup(host, { all: true }).then((answers) => answers.map((answer) => answer.address)),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${host} did not resolve in time`)), RESOLVE_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Pages that are nowhere: a blank tab, and Chrome's own page for an address that would not load. */
const NOWHERE = /^(?:about:(?:blank|srcdoc)|chrome-error:\/\/chromewebdata\/)(?:[?#]|$)/i;

const WHAT: Readonly<Record<Exclude<AddressClass, "public">, string>> = {
	loopback: "this computer",
	private: "the local network",
	"link-local": "a link-local address, such as a cloud machine's metadata service",
	reserved: "a reserved address",
};

/** Least public first: a name with one public and one private address is a way in, not a site. */
const NOT_PUBLIC: readonly Exclude<AddressClass, "public">[] = ["loopback", "link-local", "private", "reserved"];

export interface Refusal {
	/** The page's origin, or its scheme when it has none. Never its path or query, which can carry what is there. */
	readonly where: string;
	/** What kind of place that is, in English. */
	readonly what: string;
}

/** A refusal as the model and the log read it. */
export function refusalReason(refused: Refusal): string {
	return `a page sent the browser to ${refused.where} (${refused.what}), which it opens only when asked to directly; nothing from that page was read`;
}

/**
 * Where the built-in browser may be, given where it was asked to go. What it
 * reads goes to the judge and back to the model, so a page must not be able to
 * send it where the model could not have gone by asking: this computer (a dev
 * server's admin page, the judge's sidecar), the local network (a router), a
 * cloud machine's metadata address, a file, a browser page. A run opened on
 * one of those places may stay in that kind of place; any run may go anywhere
 * on the public web.
 */
export class Bounds {
	private readonly start: URL | undefined;
	private readonly resolve: ResolveHost;
	private readonly places = new Map<string, Promise<AddressClass>>();

	constructor(start: string, resolve: ResolveHost = systemResolve) {
		this.resolve = resolve;
		let parsed: URL | undefined;
		try {
			parsed = new URL(start);
		} catch {
			// Nothing was asked for by name, so only the public web is in bounds.
		}
		this.start = parsed;
	}

	/** Why the browser may not be at `url`, or undefined when it may. */
	async refuse(url: string): Promise<Refusal | undefined> {
		if (NOWHERE.test(url)) return undefined;
		let now: URL;
		try {
			now = new URL(url);
		} catch {
			return { where: "an address that is not a URL", what: "not a web page" };
		}
		// A page's own blob: address is that page's origin.
		if (now.protocol === "blob:")
			return now.origin === "null" ? { where: "blob:", what: "not a web page" } : this.refuse(now.origin);
		if (now.protocol !== "http:" && now.protocol !== "https:") return { where: now.protocol, what: "not a web page" };
		if (this.start && now.hostname === this.start.hostname) return undefined;
		const place = await this.place(now.hostname);
		if (place === "public") return undefined;
		const asked = this.start ? await this.place(this.start.hostname) : "public";
		return place === asked ? undefined : { where: now.origin, what: WHAT[place] };
	}

	private place(hostname: string): Promise<AddressClass> {
		let known = this.places.get(hostname);
		if (!known) {
			known = this.classify(hostname);
			this.places.set(hostname, known);
		}
		return known;
	}

	private async classify(hostname: string): Promise<AddressClass> {
		const host = hostname
			.replace(/^\[|\]$/g, "")
			.replace(/\.$/, "")
			.toLowerCase();
		// Chrome answers these itself, whatever DNS says.
		if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
		if (isIP(host)) return classifyAddress(host);
		let addresses: readonly string[];
		try {
			addresses = await this.resolve(host);
		} catch {
			// A name this computer cannot resolve, where the browser could (through a proxy), is somewhere on the web.
			return "public";
		}
		const places = addresses.map(classifyAddress);
		return NOT_PUBLIC.find((place) => places.includes(place)) ?? "public";
	}
}
