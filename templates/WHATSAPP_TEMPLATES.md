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
| 6 | `donor_broadcast` | Marketing | Used by dashboard broadcasts |
| 7 | `supporter_contribution` | Marketing | Text only |
| 8 | `hospital_admin_notice` | Utility | Used by bot (welcome when you run `addhospital`) |
| 9 | `hospital_donor_incoming` | Utility | Used by bot |
| 10 | `hospital_request_alert` | Utility | Used by bot |
| 11 | `blood_group_confirmed` | Utility | Used by bot |
| 12 | `donor_broadcast_image` | Marketing | Used by dashboard broadcasts with an image |

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

Sent when a donor accepts a request where the family picked this partner hospital.

---

## 10. `hospital_request_alert` (Utility): system to hospital, new request for their patient

**Body**
```
Hello {{1}}, LifeDrop received blood request {{2}} for a patient at your facility: {{3}} unit(s), urgency {{4}}. Patient: {{5}}. Family contact: {{6}}. Reply "requests" to see the details.
```
**Button** (Quick reply): `Noted`
**Samples:** {{1}} `Buea Regional Hospital` · {{2}} `#42` · {{3}} `O+ x 2` · {{4}} `Emergency` · {{5}} `M. N.` · {{6}} `Paul (237677123456)`

Sent when the family picks this partner hospital in the request flow.

---

## 11. `blood_group_confirmed` (Utility): lab confirmed the donor's blood group

**Body**
```
Hi {{1}}, your blood group {{2}} has been confirmed by {{3}}. You are now a confirmed LifeDrop donor and can receive matching blood requests. Thank you!
```
**Samples:** {{1}} `Jean` · {{2}} `O+` · {{3}} `Buea Regional Lab`

Used only when the donor hasn't messaged the bot in the last 24 hours when lab staff confirm their free test.

---

## 12. `donor_broadcast_image` (Marketing): news to all donors, with a picture

Same as `donor_broadcast`, with an image on top. The dashboard uses it when a broadcast has an image and the donor is outside the 24h window.
Inside the window, donors get a normal image message with the same text as the caption.

**Header**: Image (upload any sample JPG/PNG when submitting; the real picture is sent with each message)
**Body**
```
Hello {{1}}, a message from the LifeDrop team: {{2}}

Thank you for being a LifeDrop blood donor. Reply STOP to stop these updates.
```
**Button** (Quick reply): `Stop updates`
**Samples:** {{1}} `Jean` · {{2}} `Healthy adults can give blood every 3 to 4 months. Invite a friend to join LifeDrop: https://wa.me/237686001785?text=Hi`
