require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const axios = require("axios");
const { DateTime } = require("luxon");

// =====================================================
// CONFIG
// =====================================================
const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://LOVJEET:LOVJEETMONGO@cluster0.zpzj90m.mongodb.net/montessorienrollmentai";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "569716849235-go0bkijujaj44085dnpv71g6otdnmc4f.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "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";
const TZ = "America/Chicago"; // CST

// =====================================================
// MONGOOSE MODEL — matches your `integrations` collection
// =====================================================
const integrationSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    type: { type: String, enum: ["google", "outlook"], required: true },
    name: String,
    connected: { type: Boolean, default: false },
    connectedAt: Date,
    config: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true, collection: "integrations" }
);
const Integration = mongoose.model("Integration", integrationSchema);

// =====================================================
// GOOGLE — refresh token & fetch events
// =====================================================
async function refreshGoogleToken(doc) {
  const res = await axios.post("https://oauth2.googleapis.com/token", {
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: doc.config.tokens.refresh_token,
    grant_type: "refresh_token",
  });
  await Integration.updateOne(
    { _id: doc._id },
    {
      $set: {
        "config.tokens.access_token": res.data.access_token,
        "config.tokens.expiry_date": Date.now() + res.data.expires_in * 1000,
      },
    }
  );
  console.log("[Google] Token refreshed & saved to DB");
  return res.data.access_token;
}

async function getGoogleToken(doc) {
  if (Date.now() + 60000 >= (doc.config.tokens.expiry_date || 0)) {
    return refreshGoogleToken(doc);
  }
  return doc.config.tokens.access_token;
}

async function fetchGoogleEvents(doc, date) {
  const dayStart = DateTime.fromISO(date, { zone: TZ }).startOf("day");
  const dayEnd = dayStart.endOf("day");

  const call = (t) =>
    axios.get("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      headers: { Authorization: `Bearer ${t}` },
      params: { timeMin: dayStart.toISO(), timeMax: dayEnd.toISO(), singleEvents: true, orderBy: "startTime" },
    });

  let token = await getGoogleToken(doc);
  let res;
  try {
    res = await call(token);
  } catch (err) {
    if (err.response?.status === 401) {
      token = await refreshGoogleToken(doc);
      res = await call(token);
    } else throw err;
  }

  return (res.data.items || []).map((ev) => {
    const s = DateTime.fromISO(ev.start.dateTime || ev.start.date).setZone(TZ);
    const e = DateTime.fromISO(ev.end.dateTime || ev.end.date).setZone(TZ);
    return {
      source: "google",
      title: ev.summary || "(No title)",
      start: s.toFormat("yyyy-MM-dd hh:mm a") + " CST",
      end: e.toFormat("yyyy-MM-dd hh:mm a") + " CST",
      _s: s,
      _e: e,
      isAllDay: !!ev.start.date,
    };
  });
}

// =====================================================
// OUTLOOK — fetch events
// =====================================================
async function fetchOutlookEvents(doc, date) {
  const dayStart = DateTime.fromISO(date, { zone: TZ }).startOf("day");
  const dayEnd = dayStart.endOf("day");
  const token = doc.config.accessToken;
  if (!token) throw new Error("No Outlook access token in DB");

  const res = await axios.get("https://graph.microsoft.com/v1.0/me/calendarview", {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: `outlook.timezone="${TZ}"`,
    },
    params: {
      startDateTime: dayStart.toUTC().toISO(),
      endDateTime: dayEnd.toUTC().toISO(),
      $orderby: "start/dateTime",
      $top: 100,
    },
  });

  return (res.data.value || []).map((ev) => {
    const s = DateTime.fromISO(ev.start.dateTime, { zone: TZ });
    const e = DateTime.fromISO(ev.end.dateTime, { zone: TZ });
    return {
      source: "outlook",
      title: ev.subject || "(No title)",
      start: s.toFormat("yyyy-MM-dd hh:mm a") + " CST",
      end: e.toFormat("yyyy-MM-dd hh:mm a") + " CST",
      _s: s,
      _e: e,
      isAllDay: ev.isAllDay,
    };
  });
}

// =====================================================
// COMPUTE AVAILABLE SLOTS — 10 AM to 5 PM CST
// =====================================================
function computeSlots(events, date, workStart, workEnd, slotMin) {
  const ds = DateTime.fromISO(date, { zone: TZ }).set({ hour: workStart, minute: 0, second: 0 });
  const de = DateTime.fromISO(date, { zone: TZ }).set({ hour: workEnd, minute: 0, second: 0 });

  // Clamp busy intervals to working hours
  const busy = events
    .filter((e) => !e.isAllDay)
    .map((e) => ({ start: e._s < ds ? ds : e._s, end: e._e > de ? de : e._e }))
    .filter((e) => e.start < de && e.end > ds)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());

  // Merge overlapping
  const merged = [];
  for (const iv of busy) {
    if (!merged.length || merged[merged.length - 1].end < iv.start) merged.push({ ...iv });
    else if (merged[merged.length - 1].end < iv.end) merged[merged.length - 1].end = iv.end;
  }

  // Find free gaps
  const gaps = [];
  let cursor = ds;
  for (const b of merged) {
    if (cursor < b.start) gaps.push({ start: cursor, end: b.start });
    cursor = b.end > cursor ? b.end : cursor;
  }
  if (cursor < de) gaps.push({ start: cursor, end: de });

  // Break into fixed slots
  const slots = [];
  for (const g of gaps) {
    let s = g.start;
    while (s.plus({ minutes: slotMin }) <= g.end) {
      const e = s.plus({ minutes: slotMin });
      slots.push({
        start: s.toFormat("yyyy-MM-dd hh:mm a") + " CST",
        end: e.toFormat("yyyy-MM-dd hh:mm a") + " CST",
      });
      s = e;
    }
  }
  return slots;
}

// =====================================================
// MAIN — reads from DB, fetches both calendars, returns CST
// =====================================================
async function getAvailability(schoolId, date, opts = {}) {
  const { workStart = 10, workEnd = 17, slotMin = 15 } = opts;

  // 1. Read integrations from MongoDB
  const integrations = await Integration.find({ schoolId, connected: true }).lean();
  const gDoc = integrations.find((i) => i.type === "google");
  const oDoc = integrations.find((i) => i.type === "outlook");

  if (!gDoc && !oDoc) throw new Error("No connected calendar integrations for this school");

  // 2. Fetch events from both APIs in parallel
  const errors = [];
  const [gEvents, oEvents] = await Promise.all([
    gDoc
      ? fetchGoogleEvents(gDoc, date).catch((e) => { errors.push({ source: "google", error: e.message }); return []; })
      : Promise.resolve([]),
    oDoc
      ? fetchOutlookEvents(oDoc, date).catch((e) => { errors.push({ source: "outlook", error: e.message }); return []; })
      : Promise.resolve([]),
  ]);

  // 3. Merge, sort, compute
  const all = [...gEvents, ...oEvents].sort((a, b) => a._s.toMillis() - b._s.toMillis());
  const available = computeSlots(all, date, workStart, workEnd, slotMin);

  // 4. Clean response (remove internal Luxon objects)
  const booked = all.map(({ _s, _e, ...rest }) => rest);

  return {
    date,
    timezone: "CST (America/Chicago)",
    workingHours: {
      start: `${workStart > 12 ? workStart - 12 : workStart}:00 ${workStart >= 12 ? "PM" : "AM"} CST`,
      end: `${workEnd > 12 ? workEnd - 12 : workEnd}:00 ${workEnd >= 12 ? "PM" : "AM"} CST`,
    },
    bookedSlots: booked,
    availableSlots: available,
    summary: {
      totalBooked: booked.length,
      google: gEvents.length,
      outlook: oEvents.length,
      totalAvailable: available.length,
    },
    ...(errors.length && { errors }),
  };
}

// =====================================================
// EXPRESS
// =====================================================
const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/calendar/availability", async (req, res) => {
  try {
    const { schoolId, date, startHour, endHour, slotMins } = req.query;

    if (!schoolId || !date)
      return res.status(400).json({ success: false, error: "Required: schoolId, date (YYYY-MM-DD)" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ success: false, error: "Date must be YYYY-MM-DD" });
    if (!mongoose.Types.ObjectId.isValid(schoolId))
      return res.status(400).json({ success: false, error: "Invalid schoolId" });

    const data = await getAvailability(schoolId, date, {
      workStart: parseInt(startHour) || 10,
      workEnd: parseInt(endHour) || 17,
      slotMin: parseInt(slotMins) || 15,
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/health", (req, res) =>
  res.json({ status: "ok", db: mongoose.connection.readyState === 1 })
);

// =====================================================
// START
// =====================================================
mongoose.connect(MONGO_URI).then(() => {
  console.log("MongoDB connected");
  app.listen(PORT, () => {
    console.log(`\n  Server: http://localhost:${PORT}`);
    console.log(`  Try:    http://localhost:${PORT}/api/calendar/availability?schoolId=69a2a7bf84844ca0d53116d6&date=2026-03-22\n`);
  });
}).catch((err) => {
  console.error("MongoDB error:", err.message);
  process.exit(1);
});
