# Recipe: email when offline

**Package:** [`@netiflyjs/core`](../reference/core.md) (also works unchanged
under [`@netiflyjs/express`](../reference/express.md))

`send()` tells you at publish time whether a user was reachable over a live
WebSocket connection anywhere in your cluster (see the `SendResult` /
`delivered` field in the [`core` reference](../reference/core.md)).
`sendOr()` is sugar for the common "fall back to email/push when the user
isn't online" pattern, so you don't have to branch on `delivered` yourself:

```ts
await netifly.sendOr(userId, 'invoice.ready', data, {
  offline: () => sendEmail(userId, 'Your invoice is ready', data),
});
```

`offline` is only called — and awaited, if it returns a promise — when
nobody held a live connection for `userId` anywhere in your cluster. Either
way, `sendOr()` resolves with the same `SendResult` `send()` would have
returned.

## Full example: Express route + Resend

```ts
import express from 'express';
import { attachNetifly } from '@netiflyjs/express';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();

const { server, netifly } = attachNetifly(app, {
  resolveUserId: async (req) => verifyJwtFromRequest(req),
});

app.post('/invoices/:id/finalize', async (req, res) => {
  const invoice = await finalizeInvoice(req.params.id);
  const user = await db.users.find(invoice.userId);

  const { delivered } = await req.netifly.sendOr(
    invoice.userId,
    'invoice.ready',
    { invoiceId: invoice.id, url: invoice.pdfUrl },
    {
      offline: () =>
        resend.emails.send({
          from: 'billing@example.com',
          to: user.email,
          subject: 'Your invoice is ready',
          html: `<p>Your invoice is ready. <a href="${invoice.pdfUrl}">View it here</a>.</p>`,
        }),
    },
  );

  res.status(202).json({ delivered });
});

server.listen(3000);
```

Nothing here is Express-specific beyond `req.netifly` — the identical
`sendOr()` call works against a plain `createNetifly()` instance too.

## Idempotency

This is a best-effort fallback, not a transactional guarantee. If the user
reconnects a split second after `offline` starts running, both the
WebSocket delivery *and* the email can end up happening — `sendOr()`
decides which path to take from a single point-in-time check
(`isOnline`'s heartbeat-interval caveat applies here too; see the
[`core` reference](../reference/core.md#createnetiflyeventsoptions)). If
your notification must be exactly-once across both channels, dedupe on
your side using a stable id (e.g. the invoice id) — mark it "notified" in
your own database before/after the `sendOr()` call, and check that flag in
whichever channel's handler runs first.
