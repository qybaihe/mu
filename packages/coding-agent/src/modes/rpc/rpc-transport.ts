import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { attachJsonlLineReader } from "./jsonl.ts";

/**
 * The channel RPC mode speaks over: commands and extension UI responses in; responses, events and extension UI
 * requests out, one JSON record each. By default that is stdin and stdout, one line per record. An application that
 * runs pi inside a process of its own (an Electron utility process, a worker) passes a transport over its own
 * channel, such as a message port, and keeps the same protocol without a pipe.
 */
export interface RpcTransport {
	/** Called once, before the first record is written. */
	start(): void;
	/** Sends one record: its JSON text, without framing. */
	write(json: string): void;
	/** Resolves when the other side has taken what was written, so a fast stream does not pile up. */
	drained(): Promise<void>;
	/** Delivers whatever is still queued. Called before the process exits. */
	flush(): Promise<void>;
	/**
	 * Hands each incoming record's JSON text to `onRecord`, and calls `onEnd` once the other side has closed.
	 * Returns a function that stops listening.
	 */
	listen(onRecord: (json: string) => void, onEnd: () => void): () => void;
	/** Stops taking input. Called when RPC mode shuts down. */
	close(): void;
}

/** stdin and stdout, one JSON line per record: the transport of `pi --mode rpc`. */
export function stdioRpcTransport(): RpcTransport {
	return {
		start: takeOverStdout,
		write: (json) => writeRawStdout(`${json}\n`),
		drained: waitForRawStdoutBackpressure,
		flush: flushRawStdout,
		listen(onRecord, onEnd) {
			process.stdin.on("end", onEnd);
			const detach = attachJsonlLineReader(process.stdin, onRecord);
			return () => {
				detach();
				process.stdin.off("end", onEnd);
			};
		},
		close() {
			process.stdin.pause();
		},
	};
}
