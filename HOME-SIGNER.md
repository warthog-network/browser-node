# Pool signer (website + extension)

Opening **browser-node.netlify.app** or the extension runs a WASM node.
Signing is **opt-in**: use **Signing ON / OFF**. A node-only tab does not
join the 3P orbit. **Show panel / Hide panel** collapses the signer
dashboard; signing can stay on in the background.

Already-enrolled profiles keep signing until they turn it off. Fresh
profiles start off. Same origin / same profile = same signer. Another
device or the extension is a new signer.

Payout waits for **every signer seen in the last ~2 minutes** (n-of-n
active), with a floor of 3. Cap 32 unique slots.

## Unique signers

Same share file on two machines is still **one** signer. Phone and desktop
need different issued slots.

Need **3 unique** issued signers to pay. Typical lab set:

| Slot | Role |
|------|------|
| 1 | Desktop extension |
| 5 | Phone / second device (Import share) |
| 2 | One VPS faux signer |

## Local home build

```bash
# private file, never commit
# signer-share.local.json
npm run extension:build
```

Load unpacked → `extension/` (folder with `manifest.json`).

Panel shows **Listening / Signing now**, ticket progress, and **signed N tickets**.

## Do not

- Commit `signer-share*.json` or bake a live share into the public zip
- Copy one share to a friend and call it a second signer
