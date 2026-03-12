# Polysis Design

## Goal

Create a standalone `/polysis` research page that uses Polymarket crypto prediction markets as a volatility and distribution lens for BTC, ETH, and SOL across daily, weekly, monthly, and yearly horizons.

## Product Direction

`/polysis` should not inject Polymarket data into the main options chain or exchange table.

Instead, it should answer a separate research question:

- what distribution is Polymarket implying for a given asset and horizon?
- how quickly is that distribution repricing?
- how credible is that signal based on liquidity and spread?
- where does that signal differ from the options market already shown in `/analysis`?

The page should behave like an analysis dashboard, not a scanner table.

## Core Insight

Polymarket crypto markets can be treated as a noisy but useful forward-looking distribution surface.

The strongest signal does not come from displaying raw market prices. It comes from translating several related prediction markets into:

- terminal probability ladders
- approximate expected move
- tail probability asymmetry
- repricing velocity
- liquidity-weighted confidence

That output is useful as a volatility sentiment overlay against options-implied expected move and skew.

## Scope

In scope:

- standalone `frontend/app/polysis/page.tsx` route
- BTC, ETH, SOL support for MVP
- daily, weekly, monthly, yearly horizon filters
- Polymarket market discovery, classification, and quality scoring
- normalized probability outputs from threshold and range markets
- separate handling for path-dependent "hit" markets
- comparison against existing options analytics
- source market drilldown with direct links

Out of scope:

- direct Polymarket execution or order entry
- mixing Polymarket quotes into existing chain tables
- deriving strict Black-Scholes implied volatility from prediction markets
- websocket streaming in MVP
- non-crypto Polymarket markets

## Page Structure

Top controls:

- asset selector: `BTC`, `ETH`, `SOL`
- horizon selector: `Daily`, `Weekly`, `Monthly`, `Yearly`
- quality summary: number of markets used, latest update time, confidence score

Primary panels:

1. `Polymarket Implied Move`
   - expected move in dollars and percent
   - most likely terminal range
   - upside and downside tail probabilities
   - concise note stating how many markets feed the signal

2. `Distribution`
   - histogram or ladder for normalized terminal probabilities
   - threshold-derived curve fallback when range markets are sparse

3. `Repricing`
   - recent changes in the derived probabilities using Polymarket price history
   - highlights whether the market is stable or actively repricing

4. `Signal Quality`
   - open interest
   - bid/ask spread
   - recent trade freshness
   - volume

5. `Options Comparison`
   - compare Polymarket expected move with options-implied expected move
   - compare directional asymmetry with options skew
   - present differences as divergence, not arbitrage

6. `Source Markets`
   - exact Polymarket markets used
   - market type labels: `threshold`, `range`, `path`
   - direct links to the source market pages

## Data Sources

### Gamma API

Base URL: `https://gamma-api.polymarket.com`

Use for market discovery and metadata.

Relevant endpoints:

- `GET /markets`
- `GET /markets/slug/{slug}`
- `GET /public-search`

Primary use:

- find active crypto markets for one asset and horizon
- read titles, slugs, token metadata, and timing metadata
- support drilldown from a selected source market

### CLOB API

Base URL: `https://clob.polymarket.com`

Use for pricing, spreads, and history.

Relevant endpoints:

- `GET /simplified-markets`
- `GET /price`
- `GET /prices`
- `GET /spread`
- `GET /last-trade-price`
- `GET /prices-history`

Primary use:

- current probability estimates
- bid/ask quality
- last traded price
- repricing over time

### Data API

Base URL: `https://data-api.polymarket.com`

Use for supporting analytics.

Relevant endpoint:

- `GET /oi`

Primary use:

- confidence weighting
- ranking by conviction rather than by quoted probability alone

## Market Taxonomy

The normalization layer should classify candidate markets into three groups.

### Threshold

Examples:

- "Will BTC be above 100k on March 31?"
- "Will ETH close below 2,800 this week?"

Interpretation:

- one point on the terminal CDF
- `Yes` can be read as `P(S_T > K)` or `P(S_T < K)`

Use:

- contributes to terminal distribution reconstruction

### Range

Examples:

- "Where will BTC close this week?"
- "What range will SOL end the month in?"

Interpretation:

- discrete terminal probability mass function across non-overlapping bins

Use:

- preferred base input for derived expected move and terminal range

### Path / Hit

Examples:

- "Will BTC hit 120k this year?"
- "Will SOL touch 250 this month?"

Interpretation:

- path-dependent barrier-touch sentiment
- closer to realized-vol or convexity stress sentiment than terminal pricing

Use:

- shown as separate volatility stress indicators
- excluded from the terminal PMF

## Normalization Model

### Candidate Discovery

For one asset and horizon:

1. discover candidate markets via Gamma search and market listing
2. keep only active, non-closed, time-relevant crypto markets
3. classify titles and metadata into threshold, range, or path

### Quality Filter

Exclude weak markets using:

- minimum volume
- minimum open interest
- maximum spread
- recent-trade recency
- parser confidence in title classification

Weak but still relevant markets may be shown in the source panel while excluded from the main derived signal.

### Distribution Construction

Preferred order:

1. use range markets to build a discrete PMF when available
2. use threshold markets to reconstruct an approximate CDF when ranges are missing
3. derive PMF bins from adjacent threshold points where possible
4. keep path markets separate

### Derived Outputs

For each asset and horizon, compute:

- expected terminal price
- expected absolute move
- expected percent move
- most likely range
- upside tail probability
- downside tail probability
- directional skew proxy
- repricing velocity
- confidence score

### Confidence Score

Combine:

- total open interest
- total volume
- median or weighted spread
- number of independent markets used
- overlap consistency across related markets
- freshness of last trade and last quote

This score should be surfaced to the user because Polymarket liquidity varies materially across markets.

## Comparison to Existing Options Analytics

The page should explicitly separate:

- `Options-implied expected move`
- `Prediction-market implied distribution`

Comparison outputs should include:

- Polymarket expected move versus ATM options expected move
- Polymarket upside/downside asymmetry versus options skew
- brief divergence labels such as `prediction market richer in upside tails`

The UI should avoid suggesting there is a clean tradable arbitrage relationship. These are distinct market structures with different participants and payoffs.

## API Usage Strategy

### Discovery Layer

Use Gamma first to:

- search by asset terms such as `bitcoin`, `btc`, `ethereum`, `eth`, `solana`, `sol`
- filter for active markets
- map markets to one of the supported horizons
- cache market metadata by slug or id

### Pricing Layer

Use CLOB to fetch:

- current probability
- spread
- last trade
- historical price series

This layer should be separate from discovery so a stale or malformed market can be excluded after discovery without refetching metadata.

### Quality Layer

Use Data API OI to:

- weight markets by conviction
- display confidence

### Refresh Model

MVP should use polling, not websocket subscriptions.

Recommended MVP refresh:

- metadata refresh on asset or horizon change
- price and spread refresh every 30 to 60 seconds
- price-history refresh on page load and on manual refresh

## Risks And Caveats

### Non-Uniform Contract Design

Polymarket crypto pages mix several market shapes. Treating them all as one distribution without classification would produce misleading outputs.

### Thin Liquidity

Some markets will quote probabilities with poor spreads and low OI. Confidence scoring is required to avoid false precision.

### Title Parsing Ambiguity

Market titles are human-readable and may not always be machine-clean. The parser must reject low-confidence cases instead of forcing classification.

### Path Dependence

"Hit" markets are useful as stress indicators, but blending them into terminal probabilities would distort the result.

### Not A Strict Vol Surface

The derived output should be described as:

- `prediction-market implied distribution`
- `volatility sentiment`

It should not be marketed as directly comparable implied volatility in the strict options-model sense.

## MVP Recommendation

Build the first version as a research-grade dashboard with polling and a narrow asset set.

MVP includes:

- BTC, ETH, SOL
- daily, weekly, monthly, yearly
- normalized terminal distribution
- implied expected move
- repricing panel
- quality panel
- source market panel
- options comparison panel

MVP excludes:

- streaming updates
- auto-expanding asset list
- advanced distribution fitting beyond discrete normalization
- persistent user annotations or saved watchlists

## Success Criteria

`/polysis` is successful if a user can answer the following in under a minute:

1. what move does Polymarket imply for this asset and horizon?
2. how much confidence should I have in that signal?
3. is Polymarket materially more bullish, bearish, or volatile than the options market?
4. which exact source markets produced that conclusion?
