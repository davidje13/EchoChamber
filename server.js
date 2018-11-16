#!/usr/bin/env node

'use strict';

const {WebSocketServer} = require('./src/WebSocketServer.js');
const {EchoChamber} = require('./src/EchoChamber.js');

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

const echoChamber = new EchoChamber('/', DOMAINS);

new WebSocketServer()
	.addHandler(echoChamber)
	.listen(PORT, HOSTNAME)
	.then((server) => server.printListeningInfo(process.stdout));
