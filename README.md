# PulseVault

This is a small website that shows the idea of PulseVault: a board of paid jobs for short phone videos. Someone posts a call ("I need this shot"). Someone else claims a slot, uploads a video, and gets paid if the buyer accepts it.

The live demo is here: https://rileykhalifaadam.github.io/pulsevault/

Add `?demo` to the end of that address to open the buyer review screen. Example: https://rileykhalifaadam.github.io/pulsevault/?demo

## What is real, and what is only a demo

Nothing on this site is a real business yet. There is no account, no server, and no company taking money.

Everything a visitor does is saved only in that browser, in a place called localStorage. Clearing the browser, or switching phones, wipes it.

- Uploads are not sent anywhere. The file stays on the phone.
- Payments are not real. "Paid" is a label on the screen.
- Email is not sent. The contact form tells the visitor it was not sent, until the placeholder below is filled in.
- Scores, badges, claims, and appeals are worked out on the phone. They are not checked by a server.

## How to update the site

1. On GitHub, open the PulseVault project and edit the file you want (the pencil icon).
2. Save the change to the `main` branch. That is the same as pushing to `main`.
3. GitHub Pages publishes the site again by itself. Give it about a minute, then refresh the live address.

You do not need to run anything on your computer. The Pages setup runs `build.py` for you. That step refreshes the copy of the site that phones keep offline, so people see your update instead of an old saved copy.

## Two placeholders to fill in

Both are at the top of the file `app.js`.

- `CONTACT_ENDPOINT` is the address of a Formspree form. Right now it says `https://formspree.io/f/YOUR_FORM_ID`. Create a form at [formspree.io](https://formspree.io), copy the form address they give you, and replace the whole `YOUR_FORM_ID` line with that address.
- `SUPPORT_EMAIL` is the inbox for safety and help. Right now it says `support@pulsevault.example`. Replace that with a real email address you read.

After you change either line, save `app.js` to `main` as in the steps above.

Until those are filled in, the contact form stays honest and says the message was not sent.

## Checklist before this is a real product

Do these in order. The demo can stay up while you work through them.

1. Put in a real support email and connect the contact form with Formspree, using the two placeholders above.
2. Add sign-in, so a buyer and a contributor are different people, and a person cannot review their own upload.
3. Add a database and file storage, so claims, videos, and messages live on a server instead of in one browser.
4. Add Stripe Connect for payouts, so accepted work sends real money to a bank or PayPal account.
5. Move badges, reviews, and appeals onto the server, and check them there. The phone must not be able to award its own score.
6. Have a lawyer review the Terms, the Privacy note, and the consent checkboxes before anyone relies on them.
7. Form a Florida LLC before the site takes real jobs or real payments.
