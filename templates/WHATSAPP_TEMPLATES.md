# LifeDrop WhatsApp message templates

Submit these in **WhatsApp Manager → Message templates → Create template**.
Language: **English (en)** for all. Use the exact **name** below: the bot sends templates by name.

Rules Meta enforces (templates get rejected otherwise):
- Variables are `{{1}}`, `{{2}}`… and every template needs **sample values** when you submit.
- A variable cannot hold new lines. The bot squashes multi-line text into one line for you.
- Don't start or end the body with a variable, and keep enough fixed text around the variables.
- **Utility** = about something the person already asked for or is part of (cheaper, approved faster).
  **Marketing** = announcements, appeals, fundraising (needs the person to have opted in; can be muted by them).

Status column: **Used by bot** = code already sends it. **Text only** = submit now; the bot code to send it is a next step.

| # | Name | Category | Status |
|---|------|----------|--------|
| 1 | `donor_match_alert` | Utility | Already approved, used by bot |
| 2 | `donation_update` | Utility | Used by bot |
| 3 | `lifedrop_ops_report` | Utility | Used by bot |
| 4 | `lifedrop_daily_summary` | Utility | Used by bot |
| 5 | `blood_sos` | Utility | Text only |
| 6 | `donor_broadcast` | Marketing | Text only |
| 7 | `supporter_contribution` | Marketing | Text only |
| 8 | `hospital_admin_notice` | Utility | Text only |
| 9 | `hospital_donor_incoming` | Utility | Text only |

---

## 2. `donation_update` (Utility): donation results ready

**Body**
```
Hi {{1}}, there is an update about your blood donation with code {{2}}. Tap below to view it in this chat.
```
**Button** (Quick reply): `View update`
**Samples:** {{1}} = `Jean` · {{2}} = `LD-48213`

The bot sends this only when the donor is outside the 24h window. The tap reopens the window and the bot sends the neutral blood-group message.

---

## 3. `lifedrop_ops_report` (Utility): support line reports

Used automatically when a report to the support number can't be sent as a normal message (support phone hasn't messaged the bot in 24h).

**Body**
```
LifeDrop operations report: {{1}}

Details: {{2}}

This is an automatic message from the LifeDrop bot. Reply to this message to see the next reports as normal messages.
```
**Samples:** {{1}} = `New Blood Request` · {{2}} = `Request #42 | Blood needed: O+ (2 units) | Location: Buea | Hospital: Regional Hospital Buea | Urgency: Emergency | Donors contacted: 3 | Time: 23 Oct 2026 14:05`

Tip: the support phone should reply "ok" once a day. That keeps the 24h window open so reports arrive as full, normal messages (free) instead of templates (paid).

---

## 4. `lifedrop_daily_summary` (Utility): daily analytics

**Body**
```
LifeDrop daily summary for {{1}}.

Donors: {{2}} new, {{3}} total, {{4}} ready to donate.
Requests: {{5}} new, {{6}} fulfilled, {{7}} with no donor found.
Donor replies: {{8}} said yes, {{9}} said no, {{10}} no reply.
Donations confirmed: {{11}} ({{12}} by blood banks).

Reply "stats" to get the full report.
```
**Samples:** {{1}} `23 Oct 2026` · {{2}} `5` · {{3}} `312` · {{4}} `241` · {{5}} `4` · {{6}} `3` · {{7}} `1` · {{8}} `6` · {{9}} `2` · {{10}} `4` · {{11}} `2` · {{12}} `1`

---

## 5. `blood_sos` (Utility): general SOS appeal to matching donors

**Body**
```
URGENT from LifeDrop: {{1}} blood is needed for a patient in {{2}} ({{3}}). If you are a {{1}} donor, feel well and have not donated in the last 3 months, please tap below. LifeDrop never pays donors.
```
**Buttons** (Quick reply): `I can help` · `Not now`
**Samples:** {{1}} `O-` · {{2}} `Douala` · {{3}} `Laquintinie Hospital`

Only send to donors who match the blood group and area and are not resting or paused. Meta may re-classify mass appeals as Marketing; if that happens, resubmit as Marketing.

---

## 6. `donor_broadcast` (Marketing): news to all donors

**Body**
```
Hello {{1}}, a message from the LifeDrop team: {{2}}

Thank you for being a LifeDrop blood donor. Reply STOP to stop these updates.
```
**Button** (Quick reply): `Stop updates`
**Samples:** {{1}} `Jean` · {{2}} `Blood drive this Saturday at Buea Regional Hospital, 8am to 2pm. Bring your ID card.`

---

## 7. `supporter_contribution` (Marketing): optional support after a successful connection

Send only to requesters whose donation was **confirmed**, a few days later, never more than once per request.

**Body**
```
Hello {{1}}, we are glad LifeDrop could connect you with a blood donor. LifeDrop is free and run by volunteers. If you wish, you can support our work with a voluntary contribution of any amount: {{2}}

This is completely optional. It is not payment for blood and does not affect any LifeDrop service now or in future.
```
**Button** (Quick reply): `No thanks`
**Samples:** {{1}} `Marie` · {{2}} `MTN MoMo 6XX XXX XXX (LifeDrop Association)`

Important: blood donation in Cameroon must stay unpaid. Never send this to donors, never send it before the donation is done, and never link it to how fast someone gets help.

---

## 8. `hospital_admin_notice` (Utility): admin to partner hospitals

**Body**
```
Hello {{1}} team, this is a message from LifeDrop administration: {{2}}

Reply to this message if you have questions.
```
**Samples:** {{1}} `Buea Regional Hospital` · {{2}} `From 1 November, please send the donor's code to confirm every LifeDrop donation.`

---

## 9. `hospital_donor_incoming` (Utility): system to hospital, donor on the way

**Body**
```
Hello {{1}}, a LifeDrop donor, {{2}} (blood group {{3}}), has agreed to donate for a patient at your facility. Their donation code is {{4}}. After they donate, send this code to this number to confirm.
```
**Button** (Quick reply): `Noted`
**Samples:** {{1}} `Buea Regional Hospital` · {{2}} `Jean M.` · {{3}} `O+` · {{4}} `LD-48213`

Needs the request to be linked to a partner facility first (hospital picker), which is not built yet.
