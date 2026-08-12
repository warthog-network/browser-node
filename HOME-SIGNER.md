# Pool signer in the browser-node extension

The Chromium extension can run a **unique Shamir share** of the fungible pool
payout key. This is **not** the vault 2P-ECDSA cosigner.

Public website zip (`/downloads/warthog-browser-node-extension.zip`) has **no**
share baked in. Import a share on the device, or build locally with a private
`signer-share.local.json` (gitignored).

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
