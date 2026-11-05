# daemonitor tenant

Your fleet's home: a Cloudflare Worker and one Durable Object on your own Cloudflare account. Agents report here. History, alert state and your Slack and webhook settings are stored here, in the Durable Object's SQLite, with finished months exported to an R2 bucket. [daemonitor.com](https://daemonitor.com) signs you in and draws the dashboard, reading this tenant straight from your browser. It never stores your fleet data.

## Deploy

You need a Cloudflare account with a zone for the tenant's hostname, Node.js 20 or newer, and pnpm. Workers Paid ($5 a month) is recommended. On the free plan, hitting a daily limit stops reports until midnight UTC, and nothing pages you.

```sh
git clone https://github.com/daemonitor/daemonitor-tenant
cd daemonitor-tenant
pnpm install
```

In `wrangler.jsonc`, uncomment `routes` and put in your hostname, for example `monitor.example.com`. Change `bucket_name` if you like.

```sh
npx wrangler login
npx wrangler r2 bucket create daemonitor-tenant-archive
npx wrangler secret put CLAIM_CODE     # any long random string; you type it once more below
pnpm run deploy
```

Then sign in at [daemonitor.com](https://daemonitor.com), choose **Add deployment**, and give it your tenant's URL and the claim code. The tenant takes you as its owner and accepts no second claim.

## Update

Pull from this repository and deploy again. The database schema upgrades itself on the next request.

```sh
git pull
pnpm install
pnpm run deploy
```

## Develop

```sh
pnpm check          # the checks in test/
pnpm dev            # wrangler dev; set DAEMONITOR_ISSUER and CLAIM_CODE in .dev.vars
```

`vendor/` holds modules shared with the daemonitor app (cluster evaluation, the fleet adapter, Slack and webhook delivery). They come from the daemonitor monorepo through `scripts/sync-shared.sh`; edit them there.
