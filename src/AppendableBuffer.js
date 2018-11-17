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

module.exports = {AppendableBuffer, AppendableBufferPool};
