# WebSocket Echo Chamber

Low-overhead implementation of a WebSocket communication hub.

Chambers are identified by URL. All connections to the same chamber
will hear each other's messages reflected back and be notified when
connections are made and closed.

## Usage

```sh
./server.js [<port> [<domain>]]
```

If `domain` is specified, the `Origin` header will be checked against
it. It should be a comma-separated list of permitted domains.

Example allowing local access during development:

```sh
./server.js 8080 file://
```

## Protocol

Connect to a chamber with:

```javascript
socket = new WebSocket(baseURL + chamberName, ['echo']);
```

All received messages will begin with metadata lines. These can be:

* `ID <n>`: received when first connecting; gives the unique ID for
  this connection
* `HI <n>`: received when a connection is made
* `BYE <n>`: received when a connection is closed or lost
* `FROM <n>`: the message which follows came from the noted connection

After all metadata lines, there may be 2 newlines followed by an
arbitrary message.

All sent messages will have metadata attached and be distributed to all
other connections (excluding the one which sent the data).

User IDs are currently numeric, but may change to UUIDs or any
alphanumeric format in the future.

See the sources in `test-client` for an example.
