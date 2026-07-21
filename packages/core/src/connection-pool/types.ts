import net from 'node:net';
import type { LeasedConnection } from './leased-connection';

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
	leaseId: number;
	/** The wrapper handed to the current lease holder, if any. Torn down by the pool on release. */
	lease?: LeasedConnection;
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
	connectionTimeoutMs?: number;
	maxWaitingQueueSize?: number;
	maxRetries?: number;
}

export interface PoolStats {
	total: number;
	idle: number;
	busy: number;
	waiting: number;
	maxConnections: number;
	minConnections: number;
}
