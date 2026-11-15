# Bug reports for the benchmark app

Start the app with `bun bench/app/server.ts` (port 4173). Before each run, `curl -s localhost:4173/__reset` resets the server-side settings.

## B1 · Cart total doesn't go down when removing an item
Steps: Go to http://localhost:4173/shop. Add "Blue Mug" and "Red Kettle" to the cart. Open the cart and remove "Blue Mug".
Expected: the total shows $35.00. Actual: the total still shows $47.00.

## B2 · Can't sign up with a plus-address email
Steps: Go to http://localhost:4173/signup. Fill in name "Priya Shah", email "priya+test@example.com", password "hunter2hunter2", pick country India, accept the terms, and click Create account.
Expected: the account is created. Actual: "Please enter a valid email address".

## B3 · Completed todos still show under "Active"
Steps: Go to http://localhost:4173/todos. Add the todos "buy milk" and "walk dog". Tick "buy milk" as done, then click the Active filter.
Expected: only "walk dog" is listed. Actual: "buy milk" (crossed out) is still listed.

## B4 · Email notifications setting doesn't stick
Steps: Go to http://localhost:4173/settings, open the Notifications tab, turn off Email notifications, click Save changes, then reload the page and open Notifications again.
Expected: Email notifications is off. Actual: it's back on.

## B5 · Search page 2 shows the same results as page 1
Steps: Go to http://localhost:4173/search, search for "tea", then go to page 2.
Expected: page 2 shows results 6–10 (Brewing guide #6 onwards). Actual: it shows Brewing guide #1–#5 again.
