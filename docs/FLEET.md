# Fleet mode

Fleet mode keeps every VPS independently observable while adding a central view.

## Topology

```text
node collectors -> local SQLite + local dashboard
       | HTTPS push, HMAC-SHA256, timestamp + nonce
       v
central hub -> fleet registry + fleet history + unified dashboard
```

Each node remains useful if the hub or network is down. The hub never receives SSH keys, Docker sockets, file contents, passkeys or root access.

## Hub configuration

```env
SENTINEL_ROLE=hub
FLEET_NODE_ID=umar
FLEET_NODE_NAME=Umar Core
FLEET_NODES_JSON={"mmo":"replace-with-64-random-hex"}
```

## Node configuration

```env
SENTINEL_ROLE=node
FLEET_NODE_ID=mmo
FLEET_NODE_NAME=MMO Production
FLEET_HUB_URL=https://vps.example.com
FLEET_SHARED_SECRET=replace-with-64-random-hex
```

Use a unique secret per node. Generate one with `openssl rand -hex 32`.

## Telegram

VPS Sentinel only calls Telegram `sendMessage`; it does not use long polling or webhooks. One bot token may therefore be used on multiple nodes without a Telegram conflict. Messages include the node name, and deduplication is local to each node. For large fleets, configure Telegram only on the hub or use separate chats.

## Updates

Every instance checks the latest GitHub Release and exposes version state in the dashboard. Updates remain explicit and verified: download the release archive and `SHA256SUMS`, then use `sentinelctl update`. Fleet mode never executes an update remotely.
