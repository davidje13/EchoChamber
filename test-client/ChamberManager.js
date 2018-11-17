class ChamberManager {
	constructor() {
		this.currentUrl = '';
		this.ws = null;
		this.myID = null;
		this.ready = false;
		this.knownParticipants = new Set();
		this.messageCallback = () => {};
		this.participantCallback = () => {};

		this._open = this._open.bind(this);
		this._message = this._message.bind(this);
		this._close = this._close.bind(this);
		this._error = this._error.bind(this);
	}

	_open() {
		this.ready = true;
		this.messageCallback('info', 'CONNECTED');
	}

	_id(id) {
		this.myID = id;
		this.participantCallback(this.myID, this.knownParticipants);
	}

	_hi(id) {
		this.knownParticipants.add(id);
		this.participantCallback(this.myID, this.knownParticipants);
		this.messageCallback('info', id + ' joined');
	}

	_bye(id) {
		this.knownParticipants.delete(id);
		this.participantCallback(this.myID, this.knownParticipants);
		this.messageCallback('info', id + ' left');
	}

	_message({data}) {
		let p = data.indexOf('\n');
		if (p === -1) {
			p = data.length;
		}
		let offset = 0;
		let sender = null;
		while (offset < p) {
			let q = data.indexOf(':', offset);
			if (q === -1) {
				q = p;
			}
			const headLn = data.substr(offset, q - offset);
			if (headLn.startsWith('I')) {
				this._id(headLn.substr(1));
			} else if (headLn.startsWith('H')) {
				this._hi(headLn.substr(1));
			} else if (headLn.startsWith('B')) {
				this._bye(headLn.substr(1));
			} else if (headLn.startsWith('F')) {
				sender = headLn.substr(1);
			}
			offset = q + 1;
		}
		if (data.length >= p + 1) {
			this.messageCallback(sender, data.substr(p + 1));
		}
	}

	_close(e) {
		this.ready = false;
		this.myID = null;
		this.knownParticipants.clear();
		this.messageCallback('err', 'CLOSED');
		this.participantCallback(this.myID, this.knownParticipants);
	}

	_error(e) {
		this.messageCallback('err', 'ERROR');
		this.ready = false;
	}

	setMessageCallback(callback) {
		this.messageCallback = callback;
	}

	setParticipantCallback(callback) {
		this.participantCallback = callback;
	}

	send(msg) {
		if (!this.ready) {
			return false;
		}
		this.ws.send(msg);
		return true;
	}

	reconnect() {
		if (this.ws !== null) {
			this.ws.removeEventListener('open', this._open);
			this.ws.removeEventListener('message', this._message);
			this.ws.removeEventListener('close', this._close);
			this.ws.removeEventListener('error', this._error);
			this.ws.close();
			this._close();
		}
		this.ready = false;

		try {
			this.ws = new WebSocket(this.currentUrl, ['echo']);
			this.ws.addEventListener('open', this._open);
			this.ws.addEventListener('message', this._message);
			this.ws.addEventListener('close', this._close);
			this.ws.addEventListener('error', this._error);
		} catch (e) {
			this._error(e);
		}
	}

	setUrl(url) {
		if (this.currentUrl === url && this.ready) {
			return;
		}
		this.currentUrl = url;
		this.reconnect();
	}
}
