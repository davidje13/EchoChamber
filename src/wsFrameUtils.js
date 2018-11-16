'use strict';

const FRAME_HEADER_MAX_SIZE = 14;
const SHARED_HEADERBUF = Buffer.alloc(FRAME_HEADER_MAX_SIZE);

// fin? (1 bit)
// reserved (3 bits)
// opcode (4 bits)
//   0 = continuation
//   1 = text
//   2 = binary
//   8 = close
//   9 = ping
//   10 = pong
// mask? (1 bit)
// length (7 bits / 7+16 bits / 7 + 64 bits)
// mask (32 bits if mask? is 1)

function readFrameHeader(data) {
	if (data.length < 2) {
		// not enough data to determine payload properties; wait for more data
		return null;
	}
	const b0 = data.readUInt8(0);
	const b1 = data.readUInt8(1);
	const fin = Boolean(b0 & 0x80);
	const rsv1 = Boolean(b0 & 0x40);
	const rsv2 = Boolean(b0 & 0x20);
	const rsv3 = Boolean(b0 & 0x10);
	const opcode = (b0 & 0x0F);
	const hasMask = Boolean(b1 & 0x80);
	let lengthH = 0;
	let lengthL = (b1 & 0x7F);
	const extraLength = (lengthL === 127) ? 8 : (lengthL === 126) ? 2 : 0;
	const headerSize = 2 + extraLength + (hasMask ? 4 : 0);
	if (data.length < headerSize) {
		// header is incomplete; wait for more data
		return null;
	}
	if (lengthL === 126) {
		lengthL = data.readUInt16BE(2);
	} else if (lengthL === 127) {
		lengthH = data.readUInt32BE(2);
		lengthL = data.readUInt32BE(6);
	}
	let mask = null;
	if (hasMask) {
		mask = Buffer.allocUnsafe(4);
		if (data.copy(mask, 0, 2 + extraLength, 2 + extraLength + 4) !== 4) {
			throw new Error('Failed to copy mask');
		}
	}

	return {
		fin,
		rsv1,
		rsv2,
		rsv3,
		isCommand: Boolean(opcode & 0x08),
		opcode,
		lengthH,
		lengthL,
		mask,
		headerSize,
	};
}

function writeFrameHeader(socket, opcode, dataLength, fin) {
	let headerSize = 2;
	SHARED_HEADERBUF.writeUInt8((fin ? 0x80 : 0x00) | opcode, 0);
	if (dataLength < 126) {
		SHARED_HEADERBUF.writeUInt8(dataLength, 1);
	} else if (dataLength < 0x10000) {
		SHARED_HEADERBUF.writeUInt8(126, 1);
		SHARED_HEADERBUF.writeUInt16BE(dataLength, 2);
		headerSize += 2;
	} else {
		SHARED_HEADERBUF.writeUInt8(127, 1);
		SHARED_HEADERBUF.writeUInt32BE(dataLength >>> 32, 2);
		SHARED_HEADERBUF.writeUInt32BE(dataLength, 6);
		headerSize += 8;
	}
	socket.write(SHARED_HEADERBUF.slice(0, headerSize));
}

module.exports = {readFrameHeader, writeFrameHeader, FRAME_HEADER_MAX_SIZE};
