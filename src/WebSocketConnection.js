'use strict';

const crypto = require('crypto');
const http = require('http');
const EventEmitter = require('events');

const {AppendableBuffer} = require('./AppendableBuffer.js');
const ws = require('./wsFrameUtils.js');

const COMMAND_MAX_SIZE = 125;
const HTTP_HEADER_MAX_LINE_LENGTH = 256;
const HTTP_HEADER_MAX_COUNT = 32;
const HTTP_HEADER_MAX_VALUE_LENGTH = 256;

const SHARED_COMMANDBUF = Buffer.alloc(COMMAND_MAX_SIZE);

const REGEXP_HTTP_REQUEST = /^GET ([a-zA-Z0-9_\\\/.?+ \-=~]*) HTTP\/1\.1$/;

const nop = () => {};

class WebSocketConnection extends EventEmitter {
	constructor(socket, targetResolver) {
		super();
		this.socket = socket;
		this.closed = false;
		this.targetResolver = targetResolver;
		this.url = null;
		this.headers = new Map();

		this.frame = null;
		this.lastNonContOpcode = 0;
		this.frameMaskPos = 0;

		this.buffer = new AppendableBuffer(Math.max(
			ws.FRAME_HEADER_MAX_SIZE,
			COMMAND_MAX_SIZE,
			HTTP_HEADER_MAX_LINE_LENGTH
		));

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
			return this._returnHttpError(400, 'Must Upgrade connection to websocket');
		}
		if (!hWsKey) {
			return this._returnHttpError(400, 'Missing Sec-WebSocket-Key header');
		}
		if (hWsVersion < 13) {
			return this._returnHttpError(400, 'Unsupported Sec-WebSocket-Version');
		}

		const requestedProtocols = (hWsProtocols === '') ? [] : hWsProtocols.split(', ');

		let choice = null;
		try {
			choice = this.targetResolver(this.url, this.headers, requestedProtocols);
			if (choice.protocol === null) {
				return this._returnHttpError(404, 'No handlers found for request');
			}
		} catch (e) {
			let status = 500;
			let message = 'An internal error occurred';
			if (typeof e === 'object' && e.status) {
				status = e.status;
				message = e.message;
			}
			return this._returnHttpError(status, message, e);
		}

		this.socket.off('data', this._handshakeData);
		this.socket.on('data', this._data);

		const sha1 = crypto.createHash('sha1');
		sha1.update(hWsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'utf8');
		const shaKey = sha1.digest('base64');

		this.socket.write(
				'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				'Sec-WebSocket-Accept: ' + shaKey + '\r\n' +
				'Sec-WebSocket-Protocol: ' + choice.protocol + '\r\n' +
				'\r\n', 'utf8'
		);

		try {
			choice.acceptor(this);
			this.emit('upgrade', {protocol: choice.protocol});
			this.url = null;
			this.headers = null;
		} catch (e) {
			this.error(1011, 'Unknown error', e);
		}
	}

	_readNextLine(d) {
		const existingBufferData = this.buffer.size();
		const consumed = this.buffer.add(d);
		const b = this.buffer.get();
		const end = b.indexOf('\r\n', 0, 'utf8');
		if (end !== -1) {
			const line = b.toString('utf8', 0, end);
			this.buffer.clear();
			return {
				consumed: end + 2 - existingBufferData,
				line,
				error: false,
			};
		}

		if (this.buffer.size() >= HTTP_HEADER_MAX_LINE_LENGTH) {
			return {consumed, line: null, error: true};
		}

		return {consumed, line: null, error: false};
	}

	_returnHttpError(code, message, error = null) {
		this.emit('error', {code, message, error});
		this.socket.write(
				'HTTP/1.1 ' + code + ' ' + http.STATUS_CODES[code] + '\r\n' +
				'Content-Type: text/plain; charset=utf-8\r\n' +
				'Content-Length: ' + Buffer.byteLength(message + '\n', 'utf8') + '\r\n' +
				'\r\n' +
				message + '\n', 'utf8'
		);
		this.socket.destroy();
	}

	_handshakeData(d) {
		if (this.closed) {
			return;
		}
		try {
			let offset = 0;
			while (offset < d.length) {
				const {consumed, line, error} = this._readNextLine(d.slice(offset));
				offset += consumed;
				if (error) {
					return this._returnHttpError(400, 'Header too long');
				}
				if (line === null) {
					break; // Wait for more data
				}
				if (this.url === null) {
					const match = line.match(REGEXP_HTTP_REQUEST)
					if (!match) {
						return this._returnHttpError(400, 'Invalid URL');
					}
					this.url = match[1];
					continue;
				}
				if (line === '') {
					return this._completeHandshake();
				}

				const p = line.indexOf(': ');
				if (p === -1) {
					return this._returnHttpError(400, 'Invalid header');
				}
				const key = line.substr(0, p);
				let value = line.substr(p + 2);
				if (this.headers.has(key)) {
					value = this.headers.get(key) + ', ' + value;
				} else if (this.headers.size >= HTTP_HEADER_MAX_COUNT) {
					return this._returnHttpError(400, 'Too many headers');
				}
				if (value.length > HTTP_HEADER_MAX_VALUE_LENGTH) {
					return this._returnHttpError(400, 'Header value too long');
				}
				this.headers.set(key, value);
			}
		} catch (e) {
			return this._returnHttpError(500, 'Unknown error', e);
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
			this.sendFrame(0x0A, data, true);
			break;
		case 0x0A: // Pong
			this.emit('pong', {data});
			break;
		default:
			this.error(1002, 'Unknown command opcode');
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
			if (lastOfFrame) {
				let commandData = frameData;
				if (this.buffer.size() > 0) {
					// Only use buffer if message is split
					this.buffer.add(frameData);
					commandData = this.buffer.get();
				}
				this._handleCommandOpcode(commandData, frame.opcode);
			} else {
				this.buffer.add(frameData);
			}
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
			this.buffer.clear();
		} else if (bytesAvailable <= frame.lengthL) {
			frame.lengthL -= bytesAvailable;
		} else {
			frame.lengthL += 0x100000000 - bytesAvailable;
			-- frame.lengthH;
		}

		return bytesAvailable;
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

				// Look for next frame
				const existingBufferData = this.buffer.size();
				const consumed = this.buffer.add(d.slice(offset), ws.FRAME_HEADER_MAX_SIZE);
				const frame = ws.readFrameHeader(this.buffer.get());
				if (!frame) {
					return; // Not enough data yet; wait for more
				}

				if (frame.isCommand && (frame.lengthL > COMMAND_MAX_SIZE || frame.lengthH > 0)) {
					return this.error(1002, 'Command message max length exceeded');
				}

				if (frame.isCommand && !frame.fin) {
					return this.error(1002, 'Command messages cannot be split');
				}

				if (frame.mask === null) {
					return this.error(1002, 'No mask specified');
				}

				if (frame.rsv1 || frame.rsv2 || frame.rsv3) {
					return this.error(1002, 'Unknown use of reserved header bits');
				}

				// previously, buffer contained a fragment of header and no data
				// (else it would already have been processed). Therefore, all data
				// is in d, at a certain offset (but may not be complete yet)

				offset += frame.headerSize - existingBufferData;
				this.buffer.clear();
				this.frame = frame;
				this.frameMaskPos = 0;
				if (!frame.isCommand) {
					if (frame.opcode != 0x00) {
						if (this.lastNonContOpcode != 0) {
							return this.error(1002, 'Previous message not finished');
						}
						this.lastNonContOpcode = frame.opcode;
						this.emit('message-start', {opcode: frame.opcode});
					} else if (this.lastNonContOpcode == 0) {
						return this.error(1002, 'Continuation of finished message');
					}
					this.emit('frame-start', {fin: frame.fin});
				}
			}
		} catch (e) {
			this.error(1011, 'Unknown error', e);
		}
	}

	_end() {
		this.closed = true;
		this.emit('end');
	}

	_close() {
		this.closed = true;
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

	error(code, message, internalError = null) {
		this.emit('error', {code, message, error: internalError});
		this.close(code, message);
		this.socket.destroy();
	}
}

module.exports = {WebSocketConnection};
