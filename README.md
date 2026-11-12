# FollyTap

Telegram Mini App + Telegram bot + PostgreSQL-backed player accounts and promo codes.

## Included
- Telegram Web App `initData` validation on the server (never trust a client-supplied Telegram ID).
- One player profile per Telegram numeric ID.
- Server-side taps and upgrades.
- Promo redemption with one redemption per player and a global activation limit.
- Admin promo creation/toggling/listing, restricted to `ADMIN_TELEGRAM_ID`.
- `/start` bot response with a Mini App launch button.

## Important setup
This project needs a public HTTPS deployment and a PostgreSQL database. It is not enough to upload `index.html` to GitHub Pages: the backend must run continuously and must receive the BotFather token as a private environment variable.

1. Create a PostgreSQL database (for example, a hosted PostgreSQL provider).
2. Deploy this repository as a Node.js web service with `npm install` and `npm start`.
3. Add environment variables:
   - `BOT_TOKEN`: token from BotFather (secret; never put it in source files or GitHub).
   - `WEBAPP_URL`: public HTTPS URL of this app, without a trailing slash.
   - `DATABASE_URL`: PostgreSQL connection string.
   - `ADMIN_TELEGRAM_ID`: your numeric Telegram user ID. Leave blank until you have obtained it safely.
4. Open the deployed URL in Telegram using your bot's `/start` button. The app deliberately refuses ordinary browser sessions because Telegram identity is required.
5. In BotFather, set the Mini App domain / menu button to the same HTTPS domain if needed.

## Admin
Once `ADMIN_TELEGRAM_ID` is set to your own numeric Telegram ID, the admin panel appears in the Mini App. It lets you create promo codes with a reward, total-use limit, and optional expiry date. The server checks the admin ID from Telegram's signed initData.

## Security notes
- Never commit `.env` or the BotFather token.
- If the token has ever been shared publicly, revoke it with BotFather and create a new one.
- Promo rewards, player balances and upgrade purchases are processed on the server.
- For a production game, add rate limiting, monitoring, backups and anti-abuse controls before opening it widely.
