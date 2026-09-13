# KatanaService

## Project Overview

KatanaService is a B2B market intelligence platform for Japanese sword dealers.

The purpose of the service is to accumulate product data provided by participating sword shops and provide objective market information that helps dealers make pricing and inventory decisions.

This is NOT a consumer marketplace or EC service.

## Core Product Concept

Participating shops provide their own product data to KatanaService.

KatanaService stores and normalizes the data and provides market analytics such as:

- Current market inventory
- Average price
- Median price
- Minimum / maximum price
- Price distribution
- Price history
- Market inventory history
- SOLD history
- Listing duration
- Analysis by sword attributes

The long-term product value is the accumulated historical market data.

## Target Users

Primary users:

- Japanese sword dealers
- KatanaService administrators

Dealer users can:

- View anonymized market analytics
- Search market products
- View market product details
- Manage only their own products
- Import their own inventory data
- View import history

Administrators can manage:

- Shops
- Users
- Master data
- Platform operations

## Data Source Policy

Market data must come from participating shops.

Supported / planned input methods:

- Excel import
- CSV import
- Manual product registration
- Future official integrations or APIs provided with shop authorization

### Important: No Scraping

Web scraping is NOT part of this project.

Do not:

- Implement web scrapers
- Retrieve product data automatically from dealer websites
- Add scraping libraries or scraping infrastructure
- Propose scraping as a data acquisition method

Existing scraping-related code is legacy/prototype code and should not be treated as part of the target architecture.

## Product Lifecycle

Products follow this conceptual lifecycle:

NEW
→ ACTIVE
→ SOLD

When a product disappears from a shop's latest inventory import, it may transition from ACTIVE to SOLD according to the import rules.

SOLD products must not be physically deleted simply because they are no longer on sale.

Historical data is important because it will be used for market analysis.

## Historical Data

Do not overwrite information in a way that destroys useful market history.

The architecture should support historical analysis such as:

- Product price changes over time
- Market price changes over time
- Inventory changes over time
- SOLD events
- Listing duration

For example, if a product changes price:

1,500,000 JPY
→ 1,400,000 JPY
→ 1,250,000 JPY

the previous prices should remain available for historical analysis.

## Market Data Privacy

Market analysis and shop management must remain logically separated.

Dealer users may view aggregated/anonymized market information.

Dealer users must only be able to modify data belonging to their own shop.

Do not expose another shop's private management information unless explicitly required by a future specification.

Authorization must be enforced server-side.

## Planned Domain Model

The production domain is expected to include concepts such as:

- User
- Shop
- Product
- ProductPriceHistory
- ImportJob
- ImportRow

Master/reference data may include:

- Maker
- Grade
- Rank
- Period
- Tradition
- Category
- Appraiser

Do not assume this list is final.

Before making major Prisma schema changes, inspect the existing schema and propose the migration plan first.

## MVP Direction

The target MVP includes:

1. Authentication / authorization
2. Shop separation
3. Own product management
4. Excel / CSV import
5. Import validation
6. Import history
7. ACTIVE / SOLD lifecycle management
8. Market product search
9. Market analytics
10. Historical market data foundation

Advanced analytics should come after reliable market data accumulation.

## Future Features

Potential future features include:

- Price trend charts
- Market inventory trends
- Listing duration analysis
- Pricing recommendations
- AI-assisted price analysis
- CSV export
- Report generation

These are future extensions and should not be implemented unless explicitly requested.

## Out of Scope / On Hold

The following are currently out of scope:

- DID
- Verifiable Credentials (VC)
- Trust Infrastructure
- Blockchain
- Consumer marketplace features
- Purchase / checkout functionality
- Web scraping

Do not introduce these without explicit instruction.

## Technology Stack

Current stack:

- Next.js
- TypeScript
- App Router
- PostgreSQL
- Prisma
- Docker
- Tailwind CSS
- shadcn/ui
- Auth.js / NextAuth
- Zod
- react-hook-form
- next-intl

Follow the conventions already used in the repository unless there is a strong reason to change them.

## Development Rules

Before implementing a non-trivial change:

1. Inspect the relevant existing code.
2. Identify affected files and dependencies.
3. Explain the proposed implementation approach.
4. Avoid unnecessary rewrites.
5. Preserve existing working behavior unless the task requires changing it.
6. Prefer incremental changes.
7. Run appropriate checks after implementation.

Do not silently make major architectural decisions.

For significant architecture, database, authentication, or domain-model changes, present the proposed design before implementation.

## Database Changes

For Prisma changes:

1. Inspect the current `schema.prisma`.
2. Explain the proposed schema changes.
3. Identify migration/data-loss risks.
4. Do not delete existing production-relevant data without explicit approval.
5. Preserve historical market information.
6. Run Prisma validation after changes.

Do not execute destructive database operations without explicit approval.

## Git Rules

The developer is currently working from the `Develop` branch.

Do not:

- Push automatically
- Merge branches automatically
- Force push
- Rewrite Git history

Commits should be focused and understandable.

Do not commit unless explicitly requested.

## Working Style

Claude Code is primarily responsible for implementation.

Architecture, requirements, and important design decisions may be reviewed separately before implementation.

When requirements are ambiguous:

- Do not invent significant business rules.
- State the ambiguity.
- Prefer the smallest implementation consistent with the existing requirements.

When asked to investigate something, do not modify code unless explicitly asked to implement the solution.
