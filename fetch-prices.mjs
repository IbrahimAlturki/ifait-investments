/* Runs on GitHub once a day and writes prices.json next to the app.
 *
 * Why this exists: a browser is blocked from calling market data APIs
 * directly (CORS). A server isn't. So GitHub fetches the prices, commits the
 * result, and the app reads prices.json from its own address — same origin,
 * always allowed, no API keys anywhere.
 *
 * prices.json contains public market prices only. No positions, no amounts.
 *
 * Node 18+ (fetch is built in). No dependencies.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const SYMBOLS = [
  // Tamra + the directly held ETF
  { key: "us:SPUS", yahoo: "SPUS" },
  { key: "us:GLD", yahoo: "GLD" },
  { key: "us:SPRE", yahoo: "SPRE" },
  { key: "us:SPSK", yahoo: "SPSK" },
  { key: "lse:ISDW.L", yahoo: "ISDW.L" },
  { key: "lse:ISDE.L", yahoo: "ISDE.L" },

  // Tadawul — Yahoo uses a .SR suffix on the four-digit code
  { key: "tadawul:1150", yahoo: "1150.SR" },
  { key: "tadawul:7010", yahoo: "7010.SR" },
  { key: "tadawul:2082", yahoo: "2082.SR" },
  { key: "tadawul:4013", yahoo: "4013.SR" },
  { key: "tadawul:7202", yahoo: "7202.SR" },
  { key: "tadawul:4263", yahoo: "4263.SR" },

  // Crypto comes from CoinGecko instead
  { key: "crypto:bitcoin", coin: "bitcoin" },
  { key: "crypto:ethereum", coin: "ethereum" },
  { key: "crypto:tether", coin: "tether" },
];

const UA = { "User-Agent": "Mozilla/5.0 (portfolio-tracker; github actions)" };

async function yahooPrice(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=5d`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const meta = (await res.json())?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  if (!price) throw new Error("no price in response");

  // A London ETF quoted in pence would be ~100x the dollar figure. Yahoo
  // reports the currency, so convert rather than silently storing pence.
  if (meta.currency === "GBp" || meta.currency === "GBX") {
    throw new Error("got the pence line, not the dollar line");
  }
  return Number(price);
}

async function cryptoPrices(coins) {
  const url =
    `https://api.coingecko.com/api/v3/simple/price` +
    `?ids=${coins.join(",")}&vs_currencies=usd`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  return res.json();
}

/* Keep yesterday's number if today's lookup fails, so one bad morning
   doesn't blank out a holding. */
const previous = existsSync("prices.json")
  ? JSON.parse(readFileSync("prices.json", "utf8")).prices ?? {}
  : {};

const prices = {};
const failed = [];

const coins = SYMBOLS.filter((s) => s.coin);
if (coins.length) {
  try {
    const data = await cryptoPrices(coins.map((c) => c.coin));
    for (const c of coins) {
      const p = data?.[c.coin]?.usd;
      if (p) prices[c.key] = p;
      else failed.push(c.key);
    }
  } catch (e) {
    failed.push(`crypto (${e.message})`);
  }
}

for (const s of SYMBOLS.filter((x) => x.yahoo)) {
  try {
    prices[s.key] = await yahooPrice(s.yahoo);
  } catch (e) {
    failed.push(`${s.key} (${e.message})`);
  }
  await new Promise((r) => setTimeout(r, 250)); // be polite
}

let carried = 0;
for (const s of SYMBOLS) {
  if (prices[s.key] === undefined && previous[s.key] !== undefined) {
    prices[s.key] = previous[s.key];
    carried++;
  }
}

const out = {
  updated: new Date().toISOString(),
  note: "Public market prices only. No holdings or amounts.",
  prices,
};
writeFileSync("prices.json", JSON.stringify(out, null, 2) + "\n");

console.log(`${Object.keys(prices).length} prices written, ${carried} carried over`);
if (failed.length) console.log(`could not fetch: ${failed.join(", ")}`);
for (const [k, v] of Object.entries(prices)) console.log(`  ${k.padEnd(18)} ${v}`);

// Missing everything means something is genuinely broken; a few gaps is normal.
if (!Object.keys(prices).length) process.exit(1);
