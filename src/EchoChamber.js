'use strict';

const EventEmitter = require('events');

const {HttpError} = require('./HttpError.js');
const {OnDemmandBuffer} = require('./AppendableBuffer.js');

const MAX_QUEUE_ITEMS = 1024;
const MAX_QUEUE_DATA = 128 * 1024;
const HEADERS_MAX_LENGTH = 256;

function queueDataBytes(queue) {
	let size = 0;
	for (const item of queue) {
		size += item.data.length;
	}
	return size;
}

function shuffle(list) {
	// thanks, https://stackoverflow.com/a/6274381/1180785
	for (let i = list.length; (i --) > 0;) {
		const j = Math.floor(Math.random() * (i + 1));
		const t = list[i];
		list[i] = list[j];
		list[j] = t;
	}
}

function targetComparator(a, b) {
	const tm = Date.now() - 30000;
	const aEstablished = (a.joined < tm);
	const bEstablished = (b.joined < tm);
	if (aEstablished !== bEstablished) {
		return aEstablished ? -1 : 1;
	}

	const aAvailable = (a.queue.queue.length === 0);
	const bAvailable = (b.queue.queue.length === 0);
	if (aAvailable !== bAvailable) {
		return aAvailable ? -1 : 1;
	}

	const aSending = (a.headerLength > 0);
	const bSending = (a.headerLength > 0);
	if (aSending !== bSending) {
		return aSending ? 1 : -1;
	}

	return 0;
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
		this.connection.send('X');
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

function socketName(socket) {
	return socket.remoteAddress + ':' + socket.remotePort;
}

class Chamber extends EventEmitter {
	constructor(name, log) {
		super();
		this.name = name;
		this.log = ((m) => log('[chamber ' + name + ']: ' + m));
		this.connections = new Map();
		this.idCounter = 0;
	}

	add(newConnection) {
		const details = {
			connection: newConnection,
			queue: new OutputQueue(newConnection),
			joined: Date.now(),
			id: String(this.idCounter ++),
			headerBuffer: new OnDemmandBuffer(HEADERS_MAX_LENGTH),
			headerLength: 0,
			currentTargets: new Set(),
		};
		this.log('Added ' + socketName(newConnection.socket) + ' as ' + details.id);
		this.connections.set(details.id, details);

		newConnection.once('close', this.remove.bind(this, details));
		newConnection.on('message-start', this.receiveStart.bind(this, details));
		newConnection.on('message-part', this.receivePart.bind(this, details));

		let welcomeMessage = 'I' + details.id;
		for (const [id, {queue}] of this.connections) {
			if (id !== details.id) {
				queue.add(this, 'H' + details.id);
				welcomeMessage += ':H' + id;
			}
		}
		details.queue.add(this, welcomeMessage);
	}

	receiveStart(senderDetails, {opcode}) {
		senderDetails.headerBuffer.clear();
		senderDetails.headerLength = 0;
	}

	_pickOneTarget(exclude) {
		const available = [];
		for (const details of this.connections.values()) {
			if (!exclude.has(details.id)) {
				available.push(details);
			}
		}
		if (available.length === 0) {
			return null;
		}
		shuffle(available); // ensure we don't pick on a particular connection
		available.sort(targetComparator);
		return available[0].id;
	}

	_parseHeader(details, data) {
		const p = data.indexOf('\n');
		if (p === -1) {
			return false;
		}

		const currentTargets = details.currentTargets;
		currentTargets.clear();
		for (const header of data.toString('utf8', 0, p).split(':')) {
			if (header.startsWith('T')) {
				for (const target of header.substr(1).split(',')) {
					currentTargets.add(target);
				}
			}
		}

		if (currentTargets.size === 0) {
			// send to all except self
			for (const id of this.connections.keys()) {
				if (id !== details.id) {
					currentTargets.add(id);
				}
			}
		} else if (currentTargets.has('**')) {
			// send to all including self
			currentTargets.clear();
			for (const id of this.connections.keys()) {
				currentTargets.add(id);
			}
		} else if (currentTargets.has('*')) {
			// pick long-lived connection to include excluding self
			currentTargets.delete('*');
			const hadSelf = currentTargets.has(details.id);
			currentTargets.add(details.id);
			const target = this._pickOneTarget(currentTargets);
			if (target) {
				currentTargets.add(target);
			}
			if (!hadSelf) {
				currentTargets.delete(details.id);
			}
		}

		details.headerLength = p + 1;
		return true;
	}

	_sendToTargets(sender, targetIDs, frame) {
		for (const id of targetIDs) {
			const targetDetails = this.connections.get(id);
			if (targetDetails) {
				targetDetails.queue.addFrame(sender, frame);
			}
		}
	}

	receivePart(details, {data, opcode, fin}) {
		if (details.headerLength === 0) {
			const headerBuffer = details.headerBuffer;
			const existingBufferData = headerBuffer.size();
			const headerParsed = headerBuffer.addAndTest(
				data,
				this._parseHeader.bind(this, details)
			);
			if (!headerParsed) {
				if (headerBuffer.size() >= headerBuffer.capacity()) {
					throw new HttpError(4000, 'Header too large');
				}
				return; // wait for more data
			}

			this._sendToTargets(details.connection, details.currentTargets, {
				data: 'F' + details.id + '\n',
				opcode,
				continuation: false,
				fin: false,
			});

			data = data.slice(details.headerLength - existingBufferData);
		}

		if (data.length > 0 || fin) {
			this._sendToTargets(details.connection, details.currentTargets, {
				data,
				opcode,
				continuation: true,
				fin,
			});

			if (fin) {
				details.headerLength = 0;
			}
		}
	}

	remove(details) {
		for (const [id, {queue}] of this.connections) {
			queue.closeSender(details.connection);
			if (id !== details.id) {
				queue.add(this, 'B' + details.id);
			}
		}
		this.connections.delete(details.id);
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
		return {protocol: 'echo', acceptor: this.accept.bind(this, url)};
	}

	accept(url, connection) {
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
		chamber.add(connection);
	}
}

module.exports = {EchoChamber};
