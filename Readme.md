# WebSocket Echo Chamber

Low-overhead implementation of a WebSocket communication hub.

Chambers are identified by URL. All connections to the same chamber
will hear each other's messages reflected back and be notified when
connections are made and closed.

## Usage

```sh
npm start [<port> [<domain>]]
```

If `domain` is specified, the `Origin` header will be checked against
it. It should be a comma-separated list of permitted domains.

Example allowing local access during development:

```sh
npm start 8080 file://
```

You can include this in another project using npm:

```sh
npm install --save websocket-echo-chamber
```

Once added, you can start the server from the command line:

```sh
echo-chamber 8080 file://
```

Or create your own server programmatically:

```javascript
const {EchoChamberHalls, WebSocketServer} = require('websocket-echo-chamber');

const domains = [];

// Max memory usage is approximately (bytes):
// (MAX_QUEUE_DATA + HEADERS_MAX_LENGTH) * CHAMBER_MAX_CONNECTIONS * MAX_CHAMBERS
// + some overhead from data structures
// Memory usage will typically be much lower (unless explicitly attacked)
// The values below result in ~0.25GB peak memory usage

const echoChamber = new EchoChamberHalls('/', domains, {
	MAX_QUEUE_ITEMS: 1024,
	MAX_QUEUE_DATA: 16 * 1024,
	HEADERS_MAX_LENGTH: 1024,
	CHAMBER_MAX_CONNECTIONS: 64,
	MAX_CHAMBERS: 256,
});

// 2-person echo chambers do not require a queue, so we can support more of them
const p2EchoChamber = new EchoChamberHalls('/p2/', domains, {
	MAX_QUEUE_ITEMS: 0,
	MAX_QUEUE_DATA: 0,
	HEADERS_MAX_LENGTH: 1024,
	CHAMBER_MAX_CONNECTIONS: 2,
	MAX_CHAMBERS: 512,
});

new WebSocketServer()
	.addHandler(p2EchoChamber)
	.addHandler(echoChamber)
	.listen(8080, '127.0.0.1')
	.then((server) => server.printListeningInfo(process.stdout));
```

## Protocol

Connect to a chamber with:

```javascript
socket = new WebSocket(baseURL + chamberName, ['echo']);
```

All received messages will begin with colon-separated metadata. Each
item begins with a letter which denotes its type, followed by
type-specific data. The metadata types are:

* `I<n>`: received when first connecting; gives the unique ID for this
  connection
* `H<n>`: "hi" received when a connection is made
* `B<n>`: "bye" received when a connection is closed or lost
* `F<n>`: "from" the message which follows came from the noted
  connection
* `X`: "truncated" the preceeding message was truncated

After all metadata, there may be a newline followed by an arbitrary
message. If there is no metadata, the message will start with a
newline.

All sent messages will have metadata attached and be distributed to all
other connections (excluding the one which sent the data).

User IDs are currently numeric, but may change to UUIDs or any
alphanumeric format in the future.

See the sources in `test-client` for an example.

### Example server-to-client messages:

#### Begin connection to new room

New connection is assigned ID "100"

```
I100
```

#### Begin connection to existing room

Room already contains "3" and "22", new connection is assigned ID "29"

```
I29:H3:H22
```

#### Message received

Message sent from connection "19"

```
F19
Message here
(may contain extra newlines)
```

#### Partial message received

Message sent from connection "22" but connection is lost before all
data is uploaded, or another data stream forced this one to close

```
F22
Partial messa
```

```
X
```

(the first message appears to complete normally, but is immediately
followed by a header-only message showing the error - `X` = previous
message truncated)

### Example client-to-server messages:

#### Send message to all connections except self

```

Message here
```

#### Send message to any arbitrary connection except self

(will favour long-lived connections which are currently idle)

```
T*
Message here
```

#### Send message to all connections including self

```
T**
Message here
```

#### Send message to specific connection(s) (can include self)

Send to connection "22" and "18"

```
T22,18
Message here
```
