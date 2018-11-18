'use strict';

const DEFAULT_LIMITS = {
	MAX_QUEUE_ITEMS: 1024,
	MAX_QUEUE_DATA: 128 * 1024,
};

function queueDataBytes(queue) {
	let size = 0;
	for (const item of queue) {
		size += item.data.length;
	}
	return size;
}

function queueBeyondCapacity(queue, limits) {
	return (
		queue.length > limits.MAX_QUEUE_ITEMS ||
		queueDataBytes(queue) > limits.MAX_QUEUE_DATA
	);
}

class OutputQueue {
	constructor(connection, limits = DEFAULT_LIMITS) {
		this.connection = connection;
		this.limits = limits;
		this.queue = [];
		this.activeSender = null;
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
			while (queueBeyondCapacity(this.queue, this.limits)) {
				this.abortCurrent();
			}
		}
	}

	add(sender, message) {
		this.addFrame(sender, {data: message, opcode: 0x01, continuation: false, fin: true});
	}

	hasQueuedItems() {
		return this.queue.length > 0;
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

OutputQueue.DEFAULT_LIMITS = DEFAULT_LIMITS;

module.exports = {OutputQueue};
