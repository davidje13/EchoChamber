'use strict';

const MAX_POOLED_BUFFERS = 64;
const bufferPools = new Map();

class AppendableBuffer {
	constructor(maxBytes) {
		this.buffer = Buffer.alloc(maxBytes);
		this.pos = 0;
	}

	add(data) {
		const consumed = data.copy(this.buffer, this.pos, 0);
		this.pos += consumed;
		return consumed;
	}

	get() {
		return this.buffer.slice(0, this.pos);
	}

	size() {
		return this.pos;
	}

	capacity() {
		return this.buffer.length;
	}

	clear() {
		this.pos = 0;
	}
}

function getBufferPool(size) {
	let pool = bufferPools.get(size);
	if (!pool) {
		pool = [];
		bufferPools.set(size, pool);
	}
	return pool;
}

const AppendableBufferPool = {
	get: (size) => {
		const pool = getBufferPool(size);
		if (pool.length > 0) {
			const buffer = pool[pool.length - 1];
			-- pool.length;
			buffer.clear();
			return buffer;
		}
		return new AppendableBuffer(size);
	},
	put: (buffer) => {
		if (!buffer) {
			return;
		}
		const pool = getBufferPool(buffer.capacity());
		if (pool.length < MAX_POOLED_BUFFERS) {
			pool.push(buffer);
		}
	},
};

class OnDemmandBuffer {
	constructor(cap = 0) {
		this.buffer = null;
		this.cap = cap;
	}

	_begin() {
		this.clear();
		this.buffer = AppendableBufferPool.get(this.cap);
	}

	add(data) {
		if (!this.buffer) {
			this._begin();
		}
		this.buffer.add(data);
	}

	get() {
		return (this.buffer === null) ? null : this.buffer.get();
	}

	size() {
		return (this.buffer === null) ? 0 : this.buffer.size();
	}

	capacity() {
		return this.cap;
	}

	setCapacity(cap) {
		if (this.cap === cap) {
			return;
		}
		this.clear();
		this.cap = cap;
	}

	addAndTest(data, fn) {
		if (this.buffer) {
			// Only use buffer if necessary
			this.buffer.add(data);
			data = this.buffer.get();
		}

		const result = fn(data);

		if (result) {
			// Finished with buffer; return it
			this.clear();
		} else if (!this.buffer) {
			// Not enough data yet; buffer what we have and wait for more
			this._begin();
			this.buffer.add(data);
		}

		return result;
	}

	clear() {
		AppendableBufferPool.put(this.buffer);
		this.buffer = null;
	}
}

module.exports = {AppendableBuffer, AppendableBufferPool, OnDemmandBuffer};
