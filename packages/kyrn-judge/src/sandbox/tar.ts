/**
 * A POSIX tar writer, enough to carry a project into a sandbox: regular files and symbolic links, with
 * their permission bits and modification times, owned by root. A path or link target longer than the
 * header has room for goes into a PAX extended header, which GNU tar and bsdtar both read.
 *
 * Written here rather than by the system's `tar`: macOS's bsdtar adds extended attributes and AppleDouble
 * files that GNU tar in the sandbox warns about, and the archive should be the same on every platform.
 */
export interface TarEntry {
	/** Relative, with `/` separators. */
	readonly path: string;
	/** Permission bits, e.g. 0o644. */
	readonly mode: number;
	/** Seconds since the epoch. */
	readonly mtime: number;
	/** A regular file's contents. */
	readonly data?: Uint8Array;
	/** A symbolic link's target. */
	readonly linkTarget?: string;
}

const BLOCK = 512;

function writeString(header: Buffer, text: string, offset: number, length: number): void {
	header.write(text, offset, Math.min(length, Buffer.byteLength(text)), "utf8");
}

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
	header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function header(
	name: string,
	entry: { mode: number; mtime: number; size: number; type: string; link: string },
): Buffer {
	const block = Buffer.alloc(BLOCK);
	writeString(block, name, 0, 100);
	writeOctal(block, entry.mode & 0o7777, 100, 8);
	writeOctal(block, 0, 108, 8);
	writeOctal(block, 0, 116, 8);
	writeOctal(block, entry.size, 124, 12);
	writeOctal(block, Math.max(0, Math.floor(entry.mtime)), 136, 12);
	block.write("        ", 148, 8, "ascii");
	block.write(entry.type, 156, 1, "ascii");
	writeString(block, entry.link, 157, 100);
	block.write("ustar\0", 257, 6, "ascii");
	block.write("00", 263, 2, "ascii");
	writeString(block, "root", 265, 32);
	writeString(block, "root", 297, 32);
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	return block;
}

/** One PAX record, `"<length> <key>=<value>\n"`, where the length counts itself. */
function paxRecord(key: string, value: string): string {
	const rest = ` ${key}=${value}\n`;
	const restBytes = Buffer.byteLength(rest);
	let length = restBytes + String(restBytes).length;
	if (String(length).length + restBytes !== length) length = restBytes + String(length).length;
	return `${length}${rest}`;
}

function padding(size: number): Buffer {
	const rest = size % BLOCK;
	return Buffer.alloc(rest === 0 ? 0 : BLOCK - rest);
}

export function createTar(entries: readonly TarEntry[]): Buffer {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		const link = entry.linkTarget ?? "";
		const records =
			(Buffer.byteLength(entry.path) > 100 ? paxRecord("path", entry.path) : "") +
			(Buffer.byteLength(link) > 100 ? paxRecord("linkpath", link) : "");
		if (records) {
			const pax = Buffer.from(records, "utf8");
			parts.push(
				header(`PaxHeader/${entry.path.slice(-80)}`, {
					mode: 0o644,
					mtime: entry.mtime,
					size: pax.length,
					type: "x",
					link: "",
				}),
				pax,
				padding(pax.length),
			);
		}
		const data = entry.linkTarget === undefined ? (entry.data ?? new Uint8Array()) : new Uint8Array();
		parts.push(
			header(entry.path, {
				mode: entry.mode,
				mtime: entry.mtime,
				size: data.length,
				type: entry.linkTarget === undefined ? "0" : "2",
				link,
			}),
			Buffer.from(data.buffer, data.byteOffset, data.byteLength),
			padding(data.length),
		);
	}
	parts.push(Buffer.alloc(BLOCK * 2));
	return Buffer.concat(parts);
}
