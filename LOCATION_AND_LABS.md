# Location matching + free test booking

## 1. Location pins
- Requesters get a **Send location** button when asked where the patient is. They can still type a town.
- New donors get the same button right after registering (reply `skip` to skip).
- Any donor can send a pin at any time (📎 → Location) to update where they are.
- Pins are saved as `lat` / `lng` on `donors` and `requests` (columns are added automatically on start).

## 2. Matching by distance
- With a pin (or a typed town the bot knows), donors are picked **nearest first, up to 50 km**
  (rings: 15 km → 30 km → 50 km). So Buea, Mutengene, Tiko and Limbe help each other.
- Donors **without** a pin still match by city text, using every known town inside 50 km.
- If the request has no pin and an unknown town, matching is the old `city ILIKE` text match.
- Known town centres live in `geo.js` (approximate public coordinates). Add towns there.

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
