'use strict';

const net = require('net');
const EventEmitter = require('events');

const {WebSocketConnection} = require('./WebSocketConnection.js');

const STATE_READY = 0;
const STATE_STARTING = 1;
const STATE_RUNNING = 2;
const STATE_STOPPING = 3;

function socketName(socket) {
	return socket.remoteAddress + ':' + socket.remotePort;
}

class WebSocketServer extends EventEmitter {
	constructor() {
		super();
		this.state = STATE_READY;
		this.handlers = [];
		this.maxQueueSize = 128;
		this.server = net.createServer(this._handleConnection.bind(this));
		this.log = this.log.bind(this);
		this.logTarget = process.stdout;
		this.connections = new Set();
		this._findTarget = this._findTarget.bind(this);
		this.close = this.close.bind(this);
	}

	addHandler(handler) {
		this.handlers.push(handler);
		return this;
	}

	log(message) {
		this.logTarget.write(new Date().toISOString() + ' ' + message + '\n');
	}

	_findTarget(url, headers, protocols) {
		for(const handler of this.handlers) {
			const result = handler.test(url, headers, protocols);
			if(result) {
				return result;
			}
		}
		return {protocol: null, acceptor: null};
	}

	_handleConnection(socket) {
		const connection = new WebSocketConnection(socket, this._findTarget);
		this.connections.add(connection);
		connection.on('error', ({status, message, error}) => this.log(
			'Closed socket ' + socketName(socket) +
			' with ' + status + ' "' + message + '"' +
			(error ? ' due to: ' + error : '')
		));
		connection.once('close', () => this.connections.delete(connection));
	}

	baseurl() {
		return 'ws://' + this.hostname + ':' + this.port + '/';
	}

	listen(port, hostname) {
		if(this.state !== STATE_READY) {
			throw new Error('Already listening');
		}
		this.state = STATE_STARTING;
		const env = {
			hostname,
			log: this.log,
			port,
		};
		return Promise.all(this.handlers.map((h) => h.begin(env)))
			.then(() => new Promise((resolve, reject) => {
				this.server.listen(port, hostname, this.maxQueueSize, (err) => {
					if (err) {
						this.state = STATE_READY;
						reject(err);
						return;
					}
					this.state = STATE_RUNNING;
					this.port = port;
					this.hostname = hostname;
					process.on('SIGINT', this.close);
					resolve(this);
				});
			}));
	}

	close() {
		if(this.state === STATE_READY) {
			return Promise.resolve(this);
		}
		if(this.state === STATE_STARTING) {
			throw new Error('Still starting up');
		}
		if(this.state === STATE_STOPPING) {
			throw new Error('Already stopping');
		}
		this.state = STATE_STOPPING;
		const env = {
			log: this.log,
		};
		this.logTarget.write('\n'); // Skip line containing Ctrl+C indicator
		this.log('Shutting down...');
		for (const connection of this.connections) {
			connection.close(1001, 'Shutting down');
		}
		return new Promise((resolve) => this.server.close(() => resolve()))
			.then(() => Promise.all(this.handlers.map((h) => h.close(env))))
			.then(() => {
				process.removeListener('SIGINT', this.close);
				this.log('Shutdown');
				this.state = STATE_READY;
				this.emit('shutdown', this);
				return this;
			});
	}

	printListeningInfo(target) {
		target.write('Available at ' + this.baseurl() + '\n\n');
	}
}

module.exports = {WebSocketServer};
