'use strict';

const EventEmitter = require('events');

const {HttpError} = require('./HttpError.js');
const {OnDemmandBuffer} = require('./AppendableBuffer.js');
const {OutputQueue} = require('./OutputQueue.js');

const DEFAULT_LIMITS = Object.assign({
	HEADERS_MAX_LENGTH: 256,
	CHAMBER_MAX_CONNECTIONS: 64,
}, OutputQueue.DEFAULT_LIMITS);

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

	const aQueued = a.hasQueuedItems();
	const bQueued = b.hasQueuedItems();
	if (aQueued !== bQueued) {
		return aQueued ? 1 : -1;
	}

	const aSending = (a.headerLength > 0);
	const bSending = (a.headerLength > 0);
	if (aSending !== bSending) {
		return aSending ? 1 : -1;
	}

	return 0;
}

function socketName(socket) {
	return socket.remoteAddress + ':' + socket.remotePort;
}

class EchoChamber extends EventEmitter {
	constructor(name, limits, log) {
		super();
		this.name = name;
		this.limits = limits;
		this.log = ((m) => log('[chamber ' + name + ']: ' + m));
		this.connections = new Map();
		this.idCounter = 0;
	}

	add(newConnection) {
		if (this.connections.size >= this.limits.CHAMBER_MAX_CONNECTIONS) {
			throw new HttpError(1013, 'Chamber is full');
		}
		const details = {
			connection: newConnection,
			queue: new OutputQueue(newConnection, this.limits),
			joined: Date.now(),
			id: String(this.idCounter ++),
			headerBuffer: new OnDemmandBuffer(this.limits.HEADERS_MAX_LENGTH),
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

EchoChamber.DEFAULT_LIMITS = DEFAULT_LIMITS;

module.exports = {EchoChamber};
