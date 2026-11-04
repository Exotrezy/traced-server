# Traced

Read receipts and tracked-link activity for Gmail, with an extension popup and a Cloudflare-hosted dashboard.

- Website: https://traced.mikaelsyed.me/
- Chrome Web Store: https://chromewebstore.google.com/detail/gffkdnbgdhploafkibimgnhlpgbiaeam
- Privacy policy: https://traced.mikaelsyed.me/privacy/

## Source availability and reuse

This repository makes Traced's implementation available for inspection. The original project code remains copyright Mikael Syed; it is not released under an open-source license. See LICENSE. Contact hello@mikaelsyed.me to request reuse or redistribution permission. Included third-party fonts retain their own licenses; see THIRD_PARTY_NOTICES.md.

The extension source snapshot is version 1.3.4. The store can temporarily serve an earlier approved version while an update is under review.

## Repository layout

The Worker stays at the repository root to match the existing traced-server repository. The extension is in its own folder.

- extension/: the complete browser extension package, including bundled fonts and icons.
- src/worker.js: tracking endpoints, owner-key authorization, session grouping, and cleanup.
- public/: landing page, privacy policy, dashboard, and interactive example UI.
- schema.sql: database schema for a fresh database only.
- migrations/: historical schema migrations for existing installations.
- test/api.test.mjs: API integration checks.
- wrangler.toml: configuration template; supply your own database ID before use.

## How it works

The extension adds tracking images and, when enabled, tracked links to outgoing Gmail messages. The Worker records eligible image and link requests. Status responses group activity into sessions. A random access key authorizes access to the installation's records; the server stores its hash.

The popup and Gmail checkmarks use a local cache and refresh from the API. Settings, the access key, and cached activity persist through ordinary updates of the same installed extension. Server records remain subject to retention and user-requested deletion.

Location is optional metadata saved after event recording. Known Gmail image-proxy opens do not reveal a recipient location. Direct image requests and link clicks can have approximate city/country when available.

An image load does not prove a person read a message. Images may be preloaded, blocked, or cached. Multiple requests can belong to one session, and both tracking images may load on a single open.

## Maintainer setup

These instructions are for maintainers and authorized contributors. Source visibility does not grant general reuse rights.

Use Node.js/npm and a Cloudflare account with Workers and D1. Install dependencies from the repository root:

```sh
npm ci
npx wrangler login
```

Edit wrangler.toml and replace YOUR_D1_DATABASE_ID with the intended database's ID. The public project domain and route in the template describe the official Traced service; change them for an authorized separate deployment. Never put API tokens, ADMIN_TOKEN values, or user access keys in that file. Use Cloudflare's secret facilities for secrets.

For a NEW database only, initialize its schema once:

```sh
npx wrangler d1 execute traced-db --local --file=schema.sql
```

For a fresh remote database, use --remote instead of --local only after checking the account and database target. Existing production databases must not be reinitialized. Historical migrations are not a list of commands to rerun; inspect the existing schema before selecting any migration.

Start the local Worker:

```sh
npm run dev
```

Deploy only after checking the configuration and intended account/database:

```sh
npm run deploy
```

The official extension source points to the official service. To review a separately hosted authorized build, update the API origins in extension/background.js and extension/content.js, the relevant extension/manifest.json URLs, and public-facing policy/site links. Loading an unpacked copy can create a different extension ID and separate storage from the store-installed extension. Avoid enabling two Traced copies in the same Gmail tab.

## API integration checks

Use a local test database. Production settings must not be changed for tests. In one terminal:

```sh
npx wrangler d1 execute traced-db --local --file=schema.sql
npx wrangler dev --local --port 8787 --var SESSION_GAP_MIN:0.05 --var PREFETCH_MS:1500 --var SELF_OPEN_MS:0 --var DUP_MS:300 --var READ_DELAY_MS:0
```

In another terminal:

```sh
node test/api.test.mjs
```

The test-only shortened windows let the suite exercise multiple sessions quickly. The production read delay and sender/scanner filters are preserved in the supplied configuration and source.

## What is excluded

This snapshot contains application source and static assets. It excludes local Cloudflare state, login credentials, node_modules, actual tracking records, database dumps, logs, personal update notes, backups, and generated extension-download ZIPs. The database ID in wrangler.toml is a placeholder. Production code and the live site have not been changed by preparing this source snapshot.
