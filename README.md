# killer

MVP backend for the P2P match platform described in the brief. This build focuses on the core flows:
registration/login, wallet topups/withdrawals (sandbox), match creation/joining, escrow, and match settlement
with commission + referral payouts.

## Stack
- Node.js (Express)
- SQLite (development/local). Replace with PostgreSQL in production.

## Quick start

```bash
npm install
npm run dev
```

The API listens on `http://localhost:3000` by default.

## Core endpoints

### Auth
- `POST /api/register` `{ email, password, phone, referralCode? }`
- `POST /api/login` `{ email, password }`

### Profile
- `GET /api/profile` (Bearer token)

### Games
- `GET /api/games`

### Wallet (sandbox)
- `POST /api/wallet/topup` `{ amount }`
- `POST /api/wallet/withdraw` `{ amount }`

### Matches
- `POST /api/matches` `{ gameId, mode, stake, playerLimit }`
- `POST /api/matches/:id/join`
- `POST /api/matches/:id/start` `{ matchCode }`
- `POST /api/matches/:id/finish` `{ winnerUserId }`

## Notes
- Commission rate is 10% of each player's stake. Winner payout = total pot - total commission.
- Referral bonus is 30% of the referred player's commission and is active for 60 days from registration.
- Payment integrations are sandbox placeholders; callbacks can be wired into the `transactions` table.

## Environment

```
PORT=3000
JWT_SECRET=change-me
DATABASE_PATH=data.sqlite
```
