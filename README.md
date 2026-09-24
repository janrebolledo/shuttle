# Shuttle

HTML/CSS implementation of [Figma frame 48:2](https://www.figma.com/design/G1kXTZzdupDlI54a7lwSX7/Shuttle-Tracker-App?node-id=48-2), with Bun tooling, Hono on Cloudflare Workers, Motion destination transitions, and [Lisse](https://corne.rs/) continuous corners.

## Run locally

```sh
bun install
cp .env.example .env # Only if you don't already have .env
bun run types
bun run dev
```

Open http://localhost:8787. Browser TypeScript rebuilds automatically, and Wrangler reloads the page when local files change.

## Apple Maps

Paste your Apple Maps **browser token** into `APPLE_MAPKIT_TOKEN` in `.env`, then restart the development server. Wrangler loads `.env` locally. With no token, the map area remains blank. With a token, MapKit initializes a map near Cal Poly Pomona. Authorization and appearance with a real token still need validation.

The token is delivered to the browser via `/api/mapkit-token`, as required by MapKit JS. Use an origin-restricted browser token; never supply an Apple private signing key. For production, configure it with `bunx wrangler secret put APPLE_MAPKIT_TOKEN` before deploying.

## Scope

Live arrivals use opt-in browser location sharing while the tab is open. After repeated accurate readings show sustained movement from SSB or The Current, the browser shares an ephemeral session's latest position with a single Durable Object. The server combines agreeing fresh reports, publishes one shuttle estimate, and deletes reports within 75 seconds after updates stop. Stopping sharing deletes the active report immediately. The map marker and ETA cards update for both destinations; when there are no fresh reports, the page shows “Live ETA unavailable.”

The route model uses the provided SSB coordinate (`34.05847, -117.81793`) and the existing The Current map pin (`34.0644634, -117.8036599`). It projects readings onto the segment between those stops, with a 400 m corridor and a provisional 1.3 road-distance factor for ETA ranges. This is a first-pass approximation, not a surveyed route trace. It needs calibration against real rides in both directions. Turnaround waits are modeled as 1–3 minutes at either endpoint. Service hours and breaks are not configured, so estimates appear only while rider updates are fresh; the app does not imply service is running when updates are absent.

For production diagnostics, open the site with `?debug` to show the DialKit menu. Turn on **Record location** before a ride, tap **Got on** and **Got off** at the stops, then choose **Export tracking TXT**. Recording stays in that browser tab and does not enable location sharing; sharing still requires its separate opt-in. The export contains precise GPS readings, accuracy, route fit, tracking status, browser details, and boarding markers. **Replay uploaded GPS ride** runs the captured relative route trace locally at 10× speed to exercise the ride detector without sending simulated reports to Cloudflare. Share only a short ride capture you are comfortable disclosing.

The app remains mostly vanilla TypeScript; only the alert sheet uses a React island. Tapping one of its four service alert choices posts to `/api/alerts`; the Worker validates it and writes it to logs, without durable storage. The feedback sheet uses filled Apple SF Symbols exported as SVGs from [sfsymbols-svg](https://github.com/brendanballon/sfsymbols-svg); Apple licenses these symbols for developing applications on Apple-branded products. Silk 0.10.1 is publicly installable and its unlayered styles are bundled into `/build/main.css`. The sheet declares `license="non-commercial"` based on the app’s confirmed exclusively non-commercial use. Commercial use requires purchasing a [Silk commercial license](https://silkhq.com/terms) and changing that declaration. Location requires HTTPS or localhost.

Static sample arrival counters and their roll animation were replaced with live ETA ranges; no simulated countdowns are used.

## Validate / deploy

```sh
bun run types
bun run check
bun run build
bunx wrangler deploy --dry-run
```

**Production releases go through GitHub Actions.** Push to `main`, or run the `Deploy to Cloudflare` workflow manually; it installs the locked dependencies, runs the type check, builds, and deploys/promotes the Worker on Cloudflare. Use that pipeline for production releases instead of running `bun run deploy` locally. Its credentials are the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` under **Settings → Secrets and variables → Actions**. The API token needs the **Edit Cloudflare Workers** permission, scoped to the account that hosts this Worker. The Worker uses `shuttle.calpoly.place` as a custom domain; Cloudflare must host the `calpoly.place` zone in that account.

Bun handles packages and the browser build; Cloudflare's Workers runtime runs the server. SVG icon assets are stored in `public/assets` so they do not depend on expiring URLs. Apple system fonts are used when available, with Helvetica Neue as fallback.

The three inline navigation and signal SVGs retain their original icon geometry; their license notices are in `public/assets/icons/LICENSE.lucide`.
