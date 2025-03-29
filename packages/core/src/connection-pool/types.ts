import net from 'node:net';

export enum ConnectionStatus {
	IDLE = 'idle',
	BUSY = 'busy',
	CLOSED = 'closed',
}

export interface PoolConnection {
	id: string;
	socket: net.Socket;
	status: ConnectionStatus;
	lastUsed: number;
}

export interface ConnectionPoolOptions {
	minConnections?: number;
	maxConnections?: number;
	idleTimeoutMs?: number;
	cleanupIntervalMs?: number;
	acquireTimeoutMs?: number;
}

export interface PoolStats {
	total: number;
	idle: number;
	busy: number;
	waiting: number;
	maxConnections: number;
	minConnections: number;
}
