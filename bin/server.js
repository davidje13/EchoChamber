#!/usr/bin/env node

'use strict';

const {EchoChamberHalls, WebSocketServer} = require('../src/index.js');

const HOSTNAME = '127.0.0.1';
let PORT = Number.parseInt(process.argv[2], 10);
if (Number.isNaN(PORT)) {
	PORT = 8080;
}

let DOMAINS = process.argv[3] || '';
if (DOMAINS === '') {
	DOMAINS = [];
} else {
	DOMAINS = DOMAINS.split(',');
}

// Max memory usage is approximately (bytes):
// (MAX_QUEUE_DATA + HEADERS_MAX_LENGTH) * CHAMBER_MAX_CONNECTIONS * MAX_CHAMBERS
// + some overhead from data structures
// Memory usage will typically be much lower (unless explicitly attacked)
// The values below result in ~0.25GB peak memory usage

const echoChamber = new EchoChamberHalls('/', DOMAINS, {
	MAX_QUEUE_ITEMS: 1024,
	MAX_QUEUE_DATA: 16 * 1024,
	HEADERS_MAX_LENGTH: 1024,
	CHAMBER_MAX_CONNECTIONS: 64,
	MAX_CHAMBERS: 256,
});

// 2-person echo chambers do not require a queue, so we can support more of them
const p2EchoChamber = new EchoChamberHalls('/p2/', DOMAINS, {
	MAX_QUEUE_ITEMS: 0,
	MAX_QUEUE_DATA: 0,
	HEADERS_MAX_LENGTH: 1024,
	CHAMBER_MAX_CONNECTIONS: 2,
	MAX_CHAMBERS: 512,
});

new WebSocketServer()
	.addHandler(p2EchoChamber)
	.addHandler(echoChamber)
	.listen(PORT, HOSTNAME)
	.then((server) => server.printListeningInfo(process.stdout));
