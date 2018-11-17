'use strict';

const crypto = require('crypto');
const http = require('http');
const EventEmitter = require('events');

const {HttpError} = require('./HttpError.js');
const {OnDemmandBuffer} = require('./AppendableBuffer.js');
const ws = require('./wsFrameUtils.js');

const COMMAND_MAX_SIZE = 125; // defined by spec
const HTTP_HEADER_MAX_LINE_LENGTH = 1024;
const HTTP_HEADER_MAX_COUNT = 32;
const HTTP_HEADER_MAX_VALUE_LENGTH = 1024;

const SHARED_COMMANDBUF = Buffer.alloc(COMMAND_MAX_SIZE);

const REGEXP_HTTP_REQUEST = /^GET ([a-zA-Z0-9_\\\/.?&%+ \-=~]*) HTTP\/1\.1$/;

const nop = () => {};

function readNextLine(buffer, d) {
	const existingBufferData = buffer.size();
	const consumed = buffer.add(d);
	const b = buffer.get();
	const end = b.indexOf('\r\n', 0, 'utf8');
	if (end !== -1) {
		const line = b.toString('utf8', 0, end);
		buffer.clear();
		return {
			consumed: end + 2 - existingBufferData,
			line,
			error: false,
		};
	}

	return {consumed, line: null, error: buffer.size() >= buffer.capacity()};
}

function wsComputeKeyDigest(key) {
	const sha1 = crypto.createHash('sha1');
	sha1.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'utf8');
	return sha1.digest('base64');
}

class WebSocketConnection extends EventEmitter {
	constructor(socket, targetResolver) {
		super();
		this.socket = socket;
		this.closed = false;
		this.targetResolver = targetResolver;
		this.url = null;
		this.headers = new Map();
		this.hasUpgraded = false;

		this.frame = null;
		this.lastNonContOpcode = 0;
		this.frameMaskPos = 0;

		this.buffer = new OnDemmandBuffer(HTTP_HEADER_MAX_LINE_LENGTH);

		this._handshakeData = this._handshakeData.bind(this);
		this._data = this._data.bind(this);
		socket.on('data', this._handshakeData);
		socket.on('end', this._end.bind(this));
		socket.on('error', nop);
		socket.on('close', this._close.bind(this));
	}

	_completeHandshake() {
		const hUpgrade = this.headers.get('Upgrade');
		const hConnection = this.headers.get('Connection');
		const hWsKey = this.headers.get('Sec-WebSocket-Key');
		const hWsProtocols = this.headers.get('Sec-WebSocket-Protocol') || '';
		const hWsVersion = Number(this.headers.get('Sec-WebSocket-Version') || '0');

		if (hConnection !== 'Upgrade' || hUpgrade !== 'websocket') {
			throw new HttpError(400, 'Must Upgrade connection to websocket');
		}
		if (!hWsKey) {
			throw new HttpError(400, 'Missing Sec-WebSocket-Key header');
		}
		if (hWsVersion < 13) {
			throw new HttpError(400, 'Unsupported Sec-WebSocket-Version');
		}

		const requestedProtocols = (hWsProtocols === '') ? [] : hWsProtocols.split(', ');

		const choice = this.targetResolver(this.url, this.headers, requestedProtocols);
		if (choice.protocol === null) {
			throw new HttpError(404, 'No handlers found for request');
		}

		// finished with header buffer
		this.buffer.clear();

		this.socket.off('data', this._handshakeData);
		this.socket.on('data', this._data);

		this.socket.write(
				'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				'Sec-WebSocket-Accept: ' + wsComputeKeyDigest(hWsKey) + '\r\n' +
				'Sec-WebSocket-Protocol: ' + choice.protocol + '\r\n' +
				'\r\n', 'utf8'
		);
		this.hasUpgraded = true;

		choice.acceptor(this);
		this.emit('upgrade', {protocol: choice.protocol});
		this.url = null;
		this.headers = null;
	}

	_handshakeData(d) {
		if (this.closed) {
			return;
		}
		try {
			let offset = 0;
			while (offset < d.length) {
				const {consumed, line, error} = readNextLine(this.buffer, d.slice(offset));
				offset += consumed;
				if (error) {
					throw new HttpError(400, 'Header too long');
				}
				if (line === null) {
					break; // Wait for more data
				}
				if (this.url === null) {
					const match = line.match(REGEXP_HTTP_REQUEST)
					if (!match) {
						throw new HttpError(400, 'Invalid URL');
					}
					this.url = match[1];
					continue;
				}
				if (line === '') {
					return this._completeHandshake();
				}

				const p = line.indexOf(': ');
				if (p === -1) {
					throw new HttpError(400, 'Invalid header');
				}
				const key = line.substr(0, p);
				let value = line.substr(p + 2);
				if (this.headers.has(key)) {
					value = this.headers.get(key) + ', ' + value;
				} else if (this.headers.size >= HTTP_HEADER_MAX_COUNT) {
					throw new HttpError(400, 'Too many headers');
				}
				if (value.length > HTTP_HEADER_MAX_VALUE_LENGTH) {
					throw new HttpError(400, 'Header value too long');
				}
				this.headers.set(key, value);
			}
		} catch (e) {
			this.error(e);
		}
	}

	_handleCommandOpcode(data, opcode) {
		switch (opcode) {
		case 0x08: // Close
			let code = null;
			let message = '';
			if (data.length >= 2) {
				code = data.readUInt16BE(0);
				message = data.toString('utf8', 2);
			}
			this.emit('close-received', {code: code || 1005, message});
			if (!this.closed) {
				this.close(code);
			}
			this.socket.end();
			break;
		case 0x09: // Ping
			this.emit('ping', {data});
			this.pong(data);
			break;
		case 0x0A: // Pong
			this.emit('pong', {data});
			break;
		default:
			throw new HttpError(1002, 'Unknown command opcode');
		}
	}

	_processNextFrameChunk(d) {
		const frame = this.frame;

		let bytesAvailable = Math.min(d.length, 0x100000000);
		const lastOfFrame = (bytesAvailable >= frame.lengthL && frame.lengthH === 0);
		if (lastOfFrame) {
			bytesAvailable = frame.lengthL;
		}

		const frameData = d.slice(0, bytesAvailable);
		if (frame.mask !== null) {
			const p = this.frameMaskPos;
			const mask = frame.mask;
			for (let i = 0; i < bytesAvailable; ++ i) {
				frameData[i] ^= mask[(p + i) & 3];
			}
			this.frameMaskPos = (p + bytesAvailable) & 3;
		}

		if (frame.isCommand) {
			this.buffer.setCapacity(COMMAND_MAX_SIZE);
			this.buffer.addAndTest(
				frameData,
				(commandData) => {
					if (!lastOfFrame) {
						return false;
					}
					this._handleCommandOpcode(commandData, frame.opcode);
					return true;
				}
			);
		} else {
			this.emit('message-part', {
				data: frameData,
				opcode: this.lastNonContOpcode,
				continuation: (frame.opcode === 0x00),
				fin: (frame.fin && lastOfFrame),
			});
			if (lastOfFrame) {
				this.emit('frame-end');
				if (frame.fin) {
					this.emit('message-end');
				}
			}
		}

		if (lastOfFrame) {
			if (frame.fin) {
				this.lastNonContOpcode = 0;
			}
			this.frame = null;
		} else if (bytesAvailable <= frame.lengthL) {
			frame.lengthL -= bytesAvailable;
		} else {
			frame.lengthL += 0x100000000 - bytesAvailable;
			-- frame.lengthH;
		}

		return bytesAvailable;
	}

	_beginFrame(frame) {
		if (frame.isCommand && (frame.lengthL > COMMAND_MAX_SIZE || frame.lengthH > 0)) {
			throw new HttpError(1002, 'Command message max length exceeded');
		}

		if (frame.isCommand && !frame.fin) {
			throw new HttpError(1002, 'Command messages cannot be split');
		}

		if (frame.mask === null) {
			throw new HttpError(1002, 'No mask specified');
		}

		if (frame.rsv1 || frame.rsv2 || frame.rsv3) {
			throw new HttpError(1002, 'Unknown use of reserved header bits');
		}

		this.frame = frame;
		this.frameMaskPos = 0;
		if (!frame.isCommand) {
			if (frame.opcode != 0x00) {
				if (this.lastNonContOpcode != 0) {
					throw new HttpError(1002, 'Previous message not finished');
				}
				this.lastNonContOpcode = frame.opcode;
				this.emit('message-start', {opcode: frame.opcode});
			} else if (this.lastNonContOpcode == 0) {
				throw new HttpError(1002, 'Continuation of finished message');
			}
			this.emit('frame-start', {fin: frame.fin});
		}
	}

	_data(d) {
		try {
			let offset = 0;
			while (true) { // process all frames (if more than one)
				while (this.frame !== null) {
					offset += this._processNextFrameChunk(d.slice(offset));
					if (offset >= d.length) {
						// Separate from main condition to allow zero-byte frames
						break;
					}
				}
				if (offset >= d.length) {
					break;
				}

				// Look for next frame

				const existingBufferData = this.buffer.size();
				this.buffer.setCapacity(ws.FRAME_HEADER_MAX_SIZE);
				const frame = this.buffer.addAndTest(
					d.slice(offset),
					ws.readFrameHeader
				);

				if (frame) {
					// previously, buffer contained a fragment of header and no data
					// (else it would already have been processed). Therefore, all data
					// is in d, at a certain offset (but may not be complete yet)

					this._beginFrame(frame);
					offset += frame.headerSize - existingBufferData;
				} else {
					break;
				}
			}
		} catch (e) {
			this.error(e);
		}
	}

	_end() {
		this.closed = true;
		this.emit('end');
	}

	_close() {
		this.closed = true;
		this.buffer.clear();
		this.emit('close');
	}

	send(message) {
		if (typeof message === 'string') {
			this.sendFrame(0x01, message, true);
		} else {
			this.sendFrame(0x02, message, true);
		}
	}

	sendFrame(opcode, data, fin) {
		if (this.closed) {
			return;
		}

		let len;
		if (data === null) {
			len = 0;
		} else if (typeof data === 'number') {
			len = data;
		} else if (typeof data === 'string') {
			len = Buffer.byteLength(data, 'utf8');
		} else {
			len = data.length;
		}
		if ((opcode & 0x08) && len > COMMAND_MAX_SIZE) {
			throw new Error('Message too long for command frame');
		}
		ws.writeFrameHeader(this.socket, opcode, len, fin);
		if (data !== null && typeof data !== 'number') {
			this.socket.write(data, 'utf8');
		}
	}

	ping(message = null) {
		this.sendFrame(0x09, message, true);
	}

	pong(message = null) {
		this.sendFrame(0x0A, message, true);
	}

	close(code = null, message = '') {
		if (this.closed) {
			return;
		}
		if (code === null) {
			this.sendFrame(0x08, null, true);
		} else {
			const len = 2 + Buffer.byteLength(message, 'utf8');
			if (len > COMMAND_MAX_SIZE) {
				throw new Error('Close reason too long');
			}
			SHARED_COMMANDBUF.writeUInt16BE(code, 0);
			SHARED_COMMANDBUF.write(message, 2, 'utf8');
			this.sendFrame(0x08, SHARED_COMMANDBUF.slice(0, len), true);
		}
		this.closed = true;
	}

	error(error) {
		let status = this.hasUpgraded ? 1011 : 500;
		let message = 'An internal error occurred';
		if (typeof error === 'object' && error.status) {
			status = error.status;
			message = error.message;
		}
		this.emit('error', {status, message, error});

		if (this.hasUpgraded) {
			this.close(status, message);
		} else {
			this.socket.write(
					'HTTP/1.1 ' + status + ' ' + http.STATUS_CODES[status] + '\r\n' +
					'Content-Type: text/plain; charset=utf-8\r\n' +
					'Content-Length: ' + Buffer.byteLength(message + '\n', 'utf8') + '\r\n' +
					'\r\n' +
					message + '\n', 'utf8'
			);
		}

		this.socket.destroy();
	}
}

module.exports = {WebSocketConnection};
