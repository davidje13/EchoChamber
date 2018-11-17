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

All received messages will begin with colon-separated metadata. Each
item begins with a letter which denotes its type, followed by
type-specific data. The metadata types are:

* `I<n>`: received when first connecting; gives the unique ID for this
  connection
* `H<n>`: "hi" received when a connection is made
* `B<n>`: "bye" received when a connection is closed or lost
* `F<n>`: "from" the message which follows came from the noted
  connection

After all metadata, there may be a newline followed by an arbitrary
message. If there is no metadata, the message will start with a
newline.

All sent messages will have metadata attached and be distributed to all
other connections (excluding the one which sent the data).

User IDs are currently numeric, but may change to UUIDs or any
alphanumeric format in the future.

See the sources in `test-client` for an example.

### Example messages:

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
```
