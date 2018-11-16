class ChamberManager {
	constructor() {
		this.currentUrl = '';
		this.ws = null;
		this.myID = null;
		this.ready = false;
		this.queue = [];
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
		for (const msg of this.queue) {
			this.send(msg);
		}
		this.queue = [];
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
		let p = data.indexOf('\n\n');
		if (p === -1) {
			p = data.length;
		}
		let offset = 0;
		let sender = null;
		while (offset < p) {
			let q = data.indexOf('\n', offset);
			if (q === -1) {
				q = p;
			}
			const headLn = data.substr(offset, q - offset);
			if (headLn.startsWith('ID ')) {
				this.myID = headLn.substr(3);
				this.participantCallback(this.myID, this.knownParticipants);
			} else if (headLn.startsWith('HI ')) {
				this._hi(headLn.substr(3));
			} else if (headLn.startsWith('BYE ')) {
				this._bye(headLn.substr(4));
			} else if (headLn.startsWith('FROM ')) {
				sender = headLn.substr(5);
			}
			offset = q + 1;
		}
		if (data.length >= p + 2) {
			this.messageCallback(sender, data.substr(p + 2));
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
		if (this.ready) {
			this.ws.send(msg);
			this.messageCallback(null, msg);
		} else {
			this.queue.push(msg);
		}
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
		if (this.currentUrl === url) {
			return;
		}
		this.currentUrl = url;
		this.reconnect();
	}
}

const baseURL = 'ws://127.0.0.1:8080/';
const cm = new ChamberManager();

window.addEventListener('load', () => {
	const fChamberName = document.getElementById('chamber');
	const fChamberSwitch = document.getElementById('chamberSwitch');
	const fMessage = document.getElementById('message');
	const messages = document.getElementById('messages');
	const participants = document.getElementById('participants');

	cm.setMessageCallback((sender, message) => {
		const o = document.createElement('div');
		if (sender === null) {
			o.className = 'message me';
		} else if (sender === 'err') {
			o.className = 'message err';
		} else if (sender === 'info') {
			o.className = 'message info';
		} else {
			o.className = 'message them';
			const lbl = document.createElement('div');
			lbl.className = 'from';
			lbl.appendChild(document.createTextNode(sender));
			o.appendChild(lbl);
		}
		const msg = document.createElement('div');
		msg.className = 'content';
		msg.innerText = message;

		o.appendChild(msg);
		const atBottom = (messages.scrollTop >= messages.scrollHeight - messages.clientHeight);
		messages.appendChild(o);
		if (atBottom) {
			messages.scrollTop = messages.scrollHeight - messages.clientHeight;
		}
	});

	cm.setParticipantCallback((myID, ps) => {
		participants.innerText = '';
		if (myID !== null) {
			const o = document.createElement('div');
			o.appendChild(document.createTextNode(myID + ' [Me]'));
			participants.appendChild(o);
		}
		for (const p of ps) {
			const o = document.createElement('div');
			o.appendChild(document.createTextNode(p));
			participants.appendChild(o);
		}
	});

	fChamberName.addEventListener('keyup', (e) => {
		if (e.keyCode === 13) {
			switchChamber();
		}
	});
	fChamberSwitch.addEventListener('click', switchChamber);
	fMessage.addEventListener('keyup', (e) => {
		if (e.keyCode === 13) {
			sendMessage();
		}
	});

	function switchChamber() {
		cm.setUrl(baseURL + fChamberName.value);
	}

	function sendMessage() {
		cm.send(fMessage.value);
		fMessage.value = '';
	}
});
