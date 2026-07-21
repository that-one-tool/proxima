import net from 'node:net';

const CRLF = '\r\n';
const DEFAULT_QUIET_MS = 300;

/** Encodes a RESP command as a `*N` array of bulk strings (binary-safe over latin1). */
export function respCommand(...args: string[]): Buffer {
	const parts = [`*${args.length}${CRLF}`];
	for (const arg of args) {
		const byteLength = Buffer.byteLength(arg, 'latin1');
		parts.push(`$${byteLength}${CRLF}${arg}${CRLF}`);
	}
	return Buffer.from(parts.join(''), 'latin1');
}

/** A zero-length multibulk (`*0`). Redis treats it as a no-op; the transform's null-parse path mishandles it. */
export const EMPTY_ARRAY_FRAME = Buffer.from(`*0${CRLF}`, 'latin1');

/**
 * Opens a raw TCP connection to the proxy, writes the exact bytes given (bypassing any client-library
 * framing), and returns the aggregated response once the socket has been quiet for `quietMs`.
 */
export function sendRaw(host: string, port: number, payload: Buffer, quietMs = DEFAULT_QUIET_MS): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host, port });
		const chunks: Buffer[] = [];
		let quietTimer: NodeJS.Timeout | undefined;

		const finish = (): void => {
			if (quietTimer) {
				clearTimeout(quietTimer);
			}
			socket.destroy();
			resolve(Buffer.concat(chunks));
		};

		socket.on('connect', () => socket.write(payload));
		socket.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
			if (quietTimer) {
				clearTimeout(quietTimer);
			}
			quietTimer = setTimeout(finish, quietMs);
		});
		socket.on('error', reject);
	});
}
