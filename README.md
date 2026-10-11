# Haven — Apartment Manager

A simple, responsive apartment and tenant tracker for property owners. It works in a modern browser without an account or installation; optional Supabase sign-in synchronizes a private workspace across devices.

## Open the app

Open `index.html` in a modern browser. When adding a building, enter each room in the spreadsheet-style room list, including its room number, floor, AC/fan type, and monthly price. Prices of 1,000 or more display with commas for easier reading (for example, `1,200`); commas are removed while editing and are not part of the saved amount. Add or remove room rows before saving. On an existing building, expand **All room details in this building** to edit every room together. You can paste tab-separated room details copied from Excel or Google Sheets directly into the matching cell; pasted rows are saved automatically. After making individual edits, click **Save room changes**. The overview and each building show current monthly rent income alongside potential income when every room is occupied. Current income uses the rent agreed with each current tenant; potential income uses each room's listed price.

Use **Add a tenant** to record a tenant's contact details, nationality, optional date of birth, room, monthly rent in your local currency, move-in date, and lease end date. The app calculates age from the date of birth and shows both with the tenant record. The Current tenants page includes nationality and age-group pie charts calculated across all buildings; tenants without a recorded date of birth are counted separately. Choose a building first; the room list then shows only available rooms in that building. Nationality is required; a passport number is required for non-Thai nationals and kept with the tenant's record. Choosing a room fills in that room's listed monthly price, which can be changed if the agreed rent differs. Select any monthly extras the tenant rents: refrigerator (500 THB), car park (800 THB), motorcycle (500 THB), or bedding (500 THB). The extras appear in a clear vertical list with a checkbox per item and can also be updated later from **Monthly extras** beside a current tenant. Use **Edit stay** to change current tenant move-in or lease-end dates; date changes cannot overlap another current tenant or a daily booking in the same room. The rental term is calculated automatically.

The overview includes a building-by-building table of occupied rooms, room rent, extras, and expected monthly total. It also breaks down monthly extra income by item and shows the expected total across all buildings.

Use **Daily rentals** in the left menu to configure any existing building room for short stays. Edit bed type and nightly price for multiple rooms in the spreadsheet-style settings table; manual edits are saved together with its save button, while valid pasted bed type and price rows from Excel or Sheets save automatically. Use **Edit daily room** on a room to change its bed type or price, or turn off daily availability when it should be used for monthly tenants. Existing bookings are kept and still prevent overlapping monthly tenancies; each booking also keeps the nightly rate and bed type saved when it was booked. When recording a guest, enter their nationality and optional date of birth; the app calculates age from the date of birth. A passport number is required for non-Thai guests and is kept with the booking. Use **Edit dates** beside an active booking to change its check-in or check-out; changes cannot overlap a monthly tenancy or another daily booking. Check-out is not a booked night. The app blocks date overlaps with confirmed monthly tenancies and other daily bookings; monthly tenant records are also prevented from overlapping existing daily bookings. Cancel a booking to keep its record while freeing those dates. Daily income summaries count booked room-nights in each calendar month and show totals by building and for the whole portfolio.

Use **Past tenants** to find older records. Ending a tenancy keeps the tenant and rental dates in the history and makes the apartment available again.

## Cloud sync and your records

Haven saves records on this device by default. To use the same records on your devices, open **Connect cloud**, sign in with the same account on each device, and choose whether to copy this device's records to a new cloud workspace or start with an empty workspace. Existing local records are not uploaded or replaced without that choice. You can also download a JSON backup from the cloud setup screen and use it to import records from another browser.

Cloud sync uses the `haven_workspaces` table and row-level security policies in `supabase-setup.sql`. The table and owner-only policies have been installed in the configured Supabase project. The local test URL `http://127.0.0.1:8765/` is allowed for email confirmation; add the published website URL in **Authentication → URL Configuration → Redirect URLs** when hosting is set up. The browser app uses only the public publishable key; never add a service-role key or database password to the app. Each signed-in account can access only its own workspace.

Open the app through an `http://` or `https://` address to sign in; browsers do not allow Supabase authentication from a `file://` page. Local-only records remain available on the device/browser where they were originally saved. Use the app's backup download and upload options to move them safely between browser addresses.

If you sign out, Haven returns to the records saved locally on that device. Cloud data remains in your account.

## Sharing a read-only availability link

The signed-in owner can use **Share availability** in the top bar to publish a client link. The link is public to anyone who receives it and contains only building names and rooms that have no current monthly tenant or current-day daily booking, with each room's number, floor, room type, and monthly listed rent. It excludes street addresses, tenant information, and booking records. Treat the link as public.

The public page reads only a sanitized snapshot through the `get_haven_public_availability` database function. Direct anonymous access to the publication table is revoked; the function returns listing fields only when called with the unguessable share token in the link. Existing Haven installations should run `supabase-public-availability-setup.sql` in the configured Supabase project's SQL Editor before using this feature. New installations can run the complete `supabase-setup.sql`. Existing workspace data and its owner-only row-level security policy are unchanged.

The public snapshot does not refresh itself when the owner's records change. After updating room or tenant records, sign in to Haven and click **Share availability** again; the same link is updated. The page shows when the snapshot was last refreshed. Ask clients to confirm availability for their intended move-in date. Grok can share the link, but the current custom bot has no direct live lookup connection; add the link to its instructions if its settings allow static instructions, or paste the link into a reply.

## Files

- `index.html` — application page
- `styles.css` — responsive styles
- `app.js` — application behavior and browser storage
- `availability.html`, `availability.css`, and `availability.js` — public read-only availability page
- `supabase-config.js` — public Supabase project URL and publishable key
- `supabase-setup.sql` — private per-user workspace and sanitized public availability setup
- `supabase-public-availability-setup.sql` — additive migration for existing Supabase installations
