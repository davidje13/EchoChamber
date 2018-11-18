'use strict';

const {HttpError} = require('./HttpError.js');
const {EchoChamber} = require('./EchoChamber.js');

const DEFAULT_LIMITS = Object.assign({
	MAX_CHAMBERS: 512,
}, EchoChamber.DEFAULT_LIMITS);

class EchoChamberHalls {
	constructor(baseURL, permittedOrigins = [], limits = DEFAULT_LIMITS) {
		this.baseURL = baseURL;
		this.permittedOrigins = permittedOrigins;
		this.limits = limits;
		this.chambers = new Map();
		this.log = null;
	}

	begin({hostname, log, port}) {
		this.log = log;
		this.log('Echo Chamber bound at ' + this.baseURL);
	}

	close({log}) {
	}

	test(url, headers, protocols) {
		if (!protocols.includes('echo')) {
			return null;
		}
		if (!url.startsWith(this.baseURL)) {
			return null;
		}
		if (this.permittedOrigins.length > 0) {
			const origin = headers.get('Origin') || '';
			if (!this.permittedOrigins.includes(origin)) {
				throw new HttpError(403, 'Origin ' + origin + ' not permitted');
			}
		}
		return {protocol: 'echo', acceptor: this.accept.bind(this, url)};
	}

	accept(url, connection) {
		let chamber = this.chambers.get(url);
		if (!chamber) {
			if (this.chambers.size >= this.limits.MAX_CHAMBERS) {
				throw new HttpError(1013, 'Too many chambers');
			}
			chamber = new EchoChamber(url, this.limits, this.log);
			this.chambers.set(url, chamber);
			this.log('Created chamber ' + url);
			chamber.once('close', () => {
				this.chambers.delete(url);
				this.log('Removed chamber ' + url);
			});
		}
		chamber.add(connection);
	}
}

EchoChamberHalls.DEFAULT_LIMITS = DEFAULT_LIMITS;

module.exports = {EchoChamberHalls};
