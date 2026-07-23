import net from 'node:net';

const CRLF = '\r\n';
const DEFAULT_QUIET_MS = 300;
const DEFAULT_TIMEOUT_MS = 10000;

/** Encodes a RESP command as a `*N` array of bulk strings (binary-safe over latin1). */
export function respCommand(...args: string[]): Buffer {
	const parts = [`*${args.length}${CRLF}`];
	for (const arg of args) {
		const byteLength = Buffer.byteLength(arg, 'latin1');
		parts.push(`$${byteLength}${CRLF}${arg}${CRLF}`);
	}
	return Buffer.from(parts.join(''), 'latin1');
}

/** A zero-length multibulk (`*0`). Redis ignores it; the prefixer must keep parsing past it (see the regression guards). */
export const EMPTY_ARRAY_FRAME = Buffer.from(`*0${CRLF}`, 'latin1');

/**
 * Opens a raw TCP connection to the proxy, writes the exact bytes given (bypassing any client-library
 * framing), and returns the aggregated response once the socket has been quiet for `quietMs` or the
 * server closed it (a rejected client legitimately receives zero bytes). Rejects when the connection
 * cannot be established, or when nothing settles within `timeoutMs`, so a wedged proxy fails the test
 * instead of hanging the run.
 */
export function sendRaw(
	host: string,
	port: number,
	payload: Buffer,
	quietMs = DEFAULT_QUIET_MS,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host, port });
		const chunks: Buffer[] = [];
		let quietTimer: NodeJS.Timeout | undefined;
		let connected = false;
		let settled = false;

		// `settle` only ever runs asynchronously, after `deadlineTimer` below is initialized.
		const settle = (outcome: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(deadlineTimer);
			clearTimeout(quietTimer);
			socket.destroy();
			outcome();
		};

		const finish = (): void => settle(() => resolve(Buffer.concat(chunks)));

		const deadlineTimer = setTimeout(
			() => settle(() => reject(new Error(`No response outcome from ${host}:${port} within ${timeoutMs}ms`))),
			timeoutMs,
		);

		socket.on('connect', () => {
			connected = true;
			socket.write(payload);
		});
		socket.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
			clearTimeout(quietTimer);
			quietTimer = setTimeout(finish, quietMs);
		});
		// A close — or a reset after connecting (e.g. a whitelist-rejected client) — is a valid outcome:
		// resolve with whatever arrived so the test can assert on it.
		socket.on('close', finish);
		socket.on('error', (error: Error) => {
			if (connected) {
				finish();
				return;
			}
			settle(() => reject(error));
		});
	});
}
