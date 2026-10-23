# Location matching + free test booking

## 1. Location pins
- Requesters get a **Send location** button when asked where the patient is. They can still type a town.
- New donors get the same button right after registering (reply `skip` to skip).
- Any donor can send a pin at any time (📎 → Location) to update where they are.
- Pins are saved as `lat` / `lng` on `donors` and `requests` (columns are added automatically on start).

## 2. Matching by distance
- With a pin (or a typed town the bot knows), donors are picked **nearest first, up to 50 km**
  (rings: 15 km → 30 km → 50 km). So Buea, Mutengene, Tiko and Limbe help each other.
- Donors **without** a pin match by their clean town (`donors.town`), using every known town inside 50 km.
- If the request has no pin and an unknown town, matching is the old `city ILIKE` text match.

### Typed places: typos and neighbourhoods
- Typed text is cleaned to a known town: "Douela" → Douala, "Yaunde" → Yaounde, "Molyko" → Buea,
  "Bonaberi" → Douala, "Up Station" → Bamenda. Accents, case, spaces and hyphens don't matter.
- Typos allowed: 1 letter for town names of 4–6 letters, 2 for longer. Neighbourhoods need 6+ letters before a typo is allowed.
- The clean name is saved as `donors.town` and `requests.town`. Old donors are filled in on startup.
- Not sure (e.g. "Mile 4" is in Limbe and Bamenda)? The bot asks **"Did you mean…?"** with buttons.
- Not found at all? Requesters get a **Send location** button. If the second answer is still unknown, the
  request goes ahead with the old text match, so a blood request is never blocked.
- Towns, other names and neighbourhoods are in `towns.js`. To add a neighbourhood, add it to that town's `areas`.

## 3. Partner labs + free test booking
- Labs live in the shared `facilities` table (same one used for hospitals). A donor can book at a facility with
  `is_partner = TRUE` and `does_lab_tests = TRUE`. This branch adds `facilities.hours` and `facilities.is_demo`.
- Bookings go in `appointments` (`facility_id`, `slot_at`, `status`, `reminder_sent`).
- After registration the donor is offered a free blood test. "Don't know" blood group donors get the lab list straight away.
- The bot shows the 3 closest partner labs (within 50 km of their pin, or in their town), then free slots
  (next 3 working days, 09:00 / 11:00 / 14:00 Cameroon time, max `SLOT_CAPACITY` people per slot, default 3).
- Donors can also reply `test` at any time to book.

### ⚠️ Demo labs are fictional
`SEED_DEMO_LABS=true` adds 3 **made-up** labs named "DEMO …" with fake phone numbers. They are **not** real partners.
Only use it on a test number. Never set it on the live bot. Add real partner labs with SQL once agreements exist:

```sql
INSERT INTO facilities (name, type, city, region, latitude, longitude, staff_phone, hours, is_partner, does_lab_tests)
VALUES ('Lab name', 'lab', 'Buea', 'South-West', 4.1527, 9.2410, '2376XXXXXXXX', 'Mon-Sat 08:00-16:00', TRUE, TRUE);
```

### New settings (all optional)
- `SLOT_CAPACITY` — people per lab per time slot (default 3).
- `SEED_DEMO_LABS` — `true` adds the fictional demo labs. Test numbers only.
- `REQUIRE_CONFIRMED_DONORS` — `true` turns on the confirmed-donor rule below. Default off.

### Confirmed donors only (`REQUIRE_CONFIRMED_DONORS=true`)
- Every booking gets a code like **LT-48213**. The donor shows it at the lab.
- Lab staff send the code from their partner WhatsApp number, check the ID card, and type the blood group.
  The donor is then confirmed (`donors.verified_at`), and the lab's blood group replaces the one they typed.
  A donation confirmed with an LD code also counts as confirmed.
- With the rule on, **Routine** and **Urgent** requests only go to confirmed donors.
- **Emergencies** go to everyone, confirmed donors first. Unconfirmed donors are told the hospital will test their blood first.
- Unconfirmed donors are reminded to book: at the end of sign-up, when they tap "Not now", and in "Welcome back".
- Only switch it on once partner labs exist in your main towns. Otherwise almost nobody gets normal requests.

### Known limits
- Slot times are the same for every lab (09:00 / 11:00 / 14:00). They don't read each lab's `hours` yet.
- One upcoming booking per donor. They cancel to rebook.

## 4. Reminders
- Every 15 minutes the bot sends a reminder to bookings starting in the next 24 hours.
- Inside the 24h chat window it sends normal buttons. Outside it, it needs the template below.
- Note: on Render's free plan the server sleeps, so reminders only go out while it is awake.

### Template to submit in Meta (WhatsApp Manager → Message templates)
- **Name:** `lab_appointment_reminder`
- **Category:** Utility
- **Language:** English (`en`)
- **Body:**
  ```
  Hello {{1}}, this is LifeDrop. Reminder: your free blood test is at {{2}} on {{3}}. Please bring an ID card. Can you still make it?
  ```
  Sample values: `{{1}}` = Amina, `{{2}}` = Sample Lab Buea, `{{3}}` = Mon 26 Oct, 09:00
- **Buttons (Quick reply):**
  1. `Yes, I'll be there`
  2. `Cancel booking`
