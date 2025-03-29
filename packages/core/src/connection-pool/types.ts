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

export interface ForwardServiceOptions {
	host: string;
	port: number;
	name: string;
	minPoolConnections?: number;
	maxPoolConnections?: number;
	idleConnectionTimeoutMs?: number;
	connectionCleanupIntervalMs?: number;
	acquireConnectionTimeoutMs?: number;
}

export interface PoolStats {
	total: number;
	idle: number;
	busy: number;
	waiting: number;
	maxConnections: number;
	minConnections: number;
}
