const baseURL = 'ws://127.0.0.1:8080/';
const cm = new ChamberManager();

function buildMessage(sender, message) {
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
	return o;
}

window.addEventListener('load', () => {
	const fChamberName = document.getElementById('chamber');
	const fChamberSwitch = document.getElementById('chamberSwitch');
	const fMessage = document.getElementById('message');
	const messages = document.getElementById('messages');
	const participants = document.getElementById('participants');

	function showMessage(sender, message) {
		const atBottom = (messages.scrollTop >= messages.scrollHeight - messages.clientHeight);
		messages.appendChild(buildMessage(sender, message));
		if (atBottom) {
			messages.scrollTop = messages.scrollHeight - messages.clientHeight;
		}
	}

	cm.setMessageCallback(showMessage);

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
		const msg = fMessage.value;
		if (cm.send(msg)) {
			fMessage.value = '';
			showMessage(null, msg);
		}
	}
});
