# Sending transactions via the browser WASM node

This site is a **full node in the tab**, not a wallet UI. Website wallets (and
most apps) talk to a normal **HTTP JSON RPC** node (`https://warthognode…` or
`http://127.0.0.1:3000`). The browser build does **not** expose that HTTP port.

## Official1 “RPC stream” is unrelated

The network status card for **Official1 /stream**
(`wss://warthognode.duckdns.org/stream`) is an optional **remote dashboard
event feed**. The WASM full node does **not** use it for P2P, sync, or
submitting transactions. Leaving it unused is correct.

| Path | Purpose |
|------|---------|
| Official1 `wss://…/ws` | P2P bridge (GRUNT, blocks) — used after **Start** |
| Official1 `wss://…/stream` | Dashboard feed only — unused by this app |
| Native `--rpc :3000` | HTTP API on a desktop/VPS node |
| Browser `virtual_get` / `virtual_post` | Same API routes **inside this tab’s** Module |

## Can the website wallet use this tab as its node?

**Not as a custom node URL.** The website wallet expects
`fetch(nodeBase + '/chain/head')` etc. There is no host/port for this WASM
instance. Using *this* node for sends means calling virtual RPC from the
**same page** (or embedding a wallet UI here later).

Use Official1 (or any public/self-hosted HTTP node) for the normal website
wallet.

## In-tab virtual RPC (power users / future wallet embed)

With the node **running** (and preferably near tip):

```js
// DevTools on this origin
await window.wartNode.virtual_get('/chain/head')
await window.wartNode.virtual_get('/account/<addr>/balance')
await window.wartNode.virtual_get('/transaction/mempool')

// Same JSON body as native POST /transaction/add
await window.wartNode.virtual_post('/transaction/add', JSON.stringify({
  pinHeight,
  nonceId,
  toAddr,
  amount,      // or amountE8
  fee,         // or feeE8
  signature65, // hex 65-byte recoverable ECDSA
}))
```

Helpers (same semantics): `src/lib/browserRpc.js`

- `rpcGet(path)`
- `rpcPost(path, body)`
- `rpcAddTransaction(payment)`

Signing still requires a wallet or offline signer. Spec for the payment body:
core [`doc/API.md`](../../core-wasm-build-0.9.6/doc/API.md) → `POST /transaction/add`
(or upstream Warthog API docs).

### Note on `virtual_post`

Older glue called `VIRTUALSTATE.postId()` (undefined). Current
`public/node/wart-node.js` uses `getId()` so POST routes resolve.

## Future (not implemented)

- In-page send form using virtual RPC  
- Same-origin bridge so another app can target this tab  
- Drop-in replacement for website wallet “custom node” field  
