'use strict';

class AppendableBuffer {
	constructor(maxBytes) {
		this.buffer = Buffer.alloc(maxBytes);
		this.pos = 0;
	}

	add(data, maxBytes) {
		if (maxBytes === null) {
			maxBytes = data.length - begin;
		}
		if (maxBytes === 0) {
			return 0;
		}
		const consumed = data.copy(this.buffer, this.pos, 0, maxBytes);
		this.pos += consumed;
		return consumed;
	}

	get() {
		return this.buffer.slice(0, this.pos);
	}

	size() {
		return this.pos;
	}

	clear() {
		this.pos = 0;
	}
}

module.exports = {AppendableBuffer};
