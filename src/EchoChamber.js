'use strict';

const EventEmitter = require('events');

const {HttpError} = require('./HttpError.js');

const MAX_QUEUE_ITEMS = 1024;
const MAX_QUEUE_DATA = 128 * 1024;

function queueDataBytes(queue) {
	let size = 0;
	for (const item of queue) {
		size += item.data.length;
	}
	return size;
}

class OutputQueue {
	constructor(connection) {
		this.queue = [];
		this.activeSender = null;
		this.connection = connection;
	}

	_handle(sender, {data, opcode, continuation, fin}) {
		const hadActive = (this.activeSender !== null);
		if (!hadActive && continuation) {
			// Part of a message which was aborted due to queue size or
			// started before we arrived; skip
			return false;
		}
		this.activeSender = sender;
		this.connection.sendFrame(continuation ? 0x00 : opcode, data, fin);
		if (fin) {
			this.activeSender = null;
			return hadActive;
		}
		return false;
	}

	_canSendFrom(sender) {
		return (this.activeSender === null || this.activeSender === sender);
	}

	_consumeQueue() {
		// Process queue first-come-first-served, but only allow a single
		// message to be in-flight at a time. Once a message is complete,
		// rewind the queue and look for the next message (which may have
		// started while the previous was still in-flight)
		while (true) {
			let del = 0;
			let skip = false;
			for (let i = 0; i < this.queue.length; ++ i) {
				const item = this.queue[i];
				if (!skip && this._canSendFrom(item.sender)) {
					skip = this._handle(item.sender, item.info);
					if (skip && del === i) {
						skip = false; // no need to rewind
					}
					++ del;
				} else if (del) {
					this.queue[i - del] = item;
				}
			}
			this.queue.length -= del;
			if (!skip) {
				return;
			}
		}
	}

	addFrame(sender, info) {
		// TODO: multiplexing would be much more efficient (and safer) than
		// queueing data, but the extension is still in draft status and not
		// implemented in any browsers.
		if (this._canSendFrom(sender)) {
			if (this._handle(sender, info)) {
				this._consumeQueue();
			}
		} else {
			this.queue.push({sender, info});
			while (this.queue.length > MAX_QUEUE_ITEMS || queueDataBytes(this.queue) > MAX_QUEUE_DATA) {
				this.abortCurrent();
			}
		}
	}

	add(sender, message) {
		this.addFrame(sender, {data: message, opcode: 0x01, continuation: false, fin: true});
	}

	abortCurrent() {
		if (this.activeSender === null) {
			return;
		}
		this.connection.sendFrame(0x00, null, true);
		this.connection.send('PREVIOUS MESSAGE TRUNCATED');
		this.activeSender = null;
		this._consumeQueue();
	}

	removeSender(sender) {
		if (sender === this.activeSender) {
			this.abortCurrent();
		} else {
			let del = 0;
			for (let i = 0; i < this.queue.length; ++ i) {
				const item = this.queue[i];
				if (item.sender === sender) {
					++ del;
				} else if (del) {
					this.queue[i - del] = item;
				}
			}
			this.queue.length -= del;
		}
	}

	closeSender(sender) {
		let endsOpen = (sender === this.activeSender);
		for (const item of this.queue) {
			if (item.sender === sender) {
				endsOpen = !item.fin;
			}
		}
		if (endsOpen) {
			this.removeSender(sender);
		}
	}
}

class Chamber extends EventEmitter {
	constructor(name, log) {
		super();
		this.name = name;
		this.log = ((m) => log('[chamber ' + name + ']: ' + m));
		this.connections = new Map();
		this.idCounter = 0;
	}

	add(wsc) {
		const newID = (this.idCounter ++);
		const newQueue = new OutputQueue(wsc);
		this.log('Added ' + wsc.socket.remoteAddress + ':' + wsc.socket.remotePort + ' as ' + newID);
		this.connections.set(wsc, {queue: newQueue, id: newID});

		wsc.once('close', this.remove.bind(this, wsc));
		wsc.on('message-part', this.receive.bind(this, wsc));

		let welcomeMessage = 'I' + newID;
		for (const [connection, {queue, id}] of this.connections) {
			if (connection !== wsc) {
				queue.add(this, 'H' + newID);
				welcomeMessage += ':H' + id;
			}
		}
		newQueue.add(this, welcomeMessage);
	}

	receive(sender, {data, opcode, continuation, fin}) {
		const details = this.connections.get(sender);
		if (!details) {
			return;
		}
		for (const [connection, {queue}] of this.connections) {
			if (connection !== sender) {
				if (!continuation) {
					queue.addFrame(sender, {data: 'F' + details.id + '\n', opcode, continuation: false, fin: false});
				}
				queue.addFrame(sender, {data, opcode, continuation: true, fin});
			}
		}
	}

	remove(wsc) {
		const details = this.connections.get(wsc);
		if (!details) {
			return;
		}
		for (const [connection, {queue}] of this.connections) {
			queue.closeSender(wsc);
			if (connection !== wsc) {
				queue.add(this, 'B' + details.id);
			}
		}
		this.connections.delete(wsc);
		this.log('Removed ' + details.id);
		if (this.connections.size === 0) {
			this.emit('close');
		}
	}
}

class EchoChamber {
	constructor(baseURL, permittedOrigins = []) {
		this.baseURL = baseURL;
		this.permittedOrigins = permittedOrigins;
		this.chambers = new Map();
		this.log = null;
	}

	begin({hostname, log, port}) {
		this.log = log;
		this.log('Echo Chamber bound at ' + this.baseURL);
	}

	close({log}) {
	}

	test(url, headers, protocols) {
		if (!protocols.includes('echo')) {
			return null;
		}
		if (!url.startsWith(this.baseURL)) {
			return null;
		}
		if (this.permittedOrigins.length > 0) {
			const origin = headers.get('Origin') || '';
			if (!this.permittedOrigins.includes(origin)) {
				throw new HttpError(403, 'Origin ' + origin + ' not permitted');
			}
		}
		return {protocol: 'echo', acceptor: (wsc) => this.accept(wsc, url)};
	}

	accept(wsc, url) {
		let chamber = this.chambers.get(url);
		if (!chamber) {
			chamber = new Chamber(url, this.log);
			this.chambers.set(url, chamber);
			this.log('Created chamber ' + url);
			chamber.once('close', () => {
				this.chambers.delete(url);
				this.log('Removed chamber ' + url);
			});
		}
		chamber.add(wsc);
	}
}

module.exports = {EchoChamber};
