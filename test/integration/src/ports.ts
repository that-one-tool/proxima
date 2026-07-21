import net from 'node:net';

/** Asks the OS for an unused loopback TCP port by binding to port 0 and reading the assignment back. */
export function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address === null || typeof address === 'string') {
				server.close(() => reject(new Error('Failed to acquire a free TCP port')));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

/** Resolves once a TCP connection to host:port succeeds, polling until the deadline. */
export function waitForPort(host: string, port: number, timeoutMs = 15000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const attempt = (): void => {
			const socket = net.connect({ host, port });
			socket.once('connect', () => {
				socket.destroy();
				resolve();
			});
			socket.once('error', () => {
				socket.destroy();
				if (Date.now() > deadline) {
					reject(new Error(`Port ${host}:${port} did not become reachable within ${timeoutMs}ms`));
					return;
				}
				setTimeout(attempt, 100);
			});
		};
		attempt();
	});
}
