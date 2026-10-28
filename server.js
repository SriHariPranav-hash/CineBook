require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "cinebook";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI. Create .env locally or set it in Render.");
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
let db, movies, shows, bookings;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const now = () => new Date();
const clean = (v, max = 160) => String(v ?? "").trim().slice(0, max);
const validId = (id) => ObjectId.isValid(id);
const seatPattern = /^[A-J](0[1-9]|1[0-2])$/;

function publicMovie(movie) {
  return { ...movie, id: movie._id.toString(), _id: undefined };
}
function adminOnly(req, res, next) {
  const configured = ADMIN_KEY;
  const provided = req.get("x-admin-key") || "";
  if (!configured || !provided || provided.length !== configured.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(configured))) {
    return res.status(401).json({ error: "Admin access denied. Enter the configured admin key." });
  }
  next();
}
function apiError(res, error, fallback = "Something went wrong.") {
  console.error(error);
  res.status(500).json({ error: fallback });
}

app.get("/api/health", async (_req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({ status: "ok", database: "connected", databaseName: DB_NAME });
  } catch (e) {
    apiError(res, e, "Database is unavailable.");
  }
});

app.get("/api/movies", async (_req, res) => {
  try {
    const list = await movies.find({ active: { $ne: false } }).sort({ featured: -1, title: 1 }).toArray();
    res.json(list.map(m => ({
      id: m._id.toString(), title: m.title, genre: m.genre, language: m.language,
      duration: m.duration, rating: m.rating, synopsis: m.synopsis, poster: m.poster,
      accent: m.accent, featured: !!m.featured
    })));
  } catch (e) { apiError(res, e, "Could not load movies."); }
});

app.get("/api/movies/:id/shows", async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: "Invalid movie ID." });
  try {
    const movie = await movies.findOne({ _id: new ObjectId(req.params.id), active: { $ne: false } });
    if (!movie) return res.status(404).json({ error: "Movie not found." });
    const list = await shows.find({ movieId: movie._id, active: { $ne: false } }).sort({ date: 1, time: 1 }).toArray();
    const result = [];
    for (const show of list) {
      const booked = await bookings.distinct("seats", { showId: show._id, status: "confirmed" });
      result.push({
        id: show._id.toString(), movieId: movie._id.toString(), date: show.date, time: show.time,
        screen: show.screen, price: show.price, totalSeats: show.totalSeats,
        bookedSeats: booked, availableSeats: Math.max(0, show.totalSeats - booked.length)
      });
    }
    res.json(result);
  } catch (e) { apiError(res, e, "Could not load showtimes."); }
});

app.post("/api/bookings", async (req, res) => {
  const showIdText = clean(req.body.showId, 40);
  const name = clean(req.body.customerName, 100);
  const email = clean(req.body.email, 160).toLowerCase();
  const seats = Array.isArray(req.body.seats) ? [...new Set(req.body.seats.map(s => clean(s, 5)))] : [];
  const paymentMethod = clean(req.body.paymentMethod, 30) || "demo";
  if (!validId(showIdText)) return res.status(400).json({ error: "Choose a valid showtime." });
  if (name.length < 2) return res.status(400).json({ error: "Enter your full name." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email." });
  if (seats.length < 1 || seats.length > 8) return res.status(400).json({ error: "Select between 1 and 8 seats." });
  if (seats.some(s => !seatPattern.test(s))) return res.status(400).json({ error: "One or more seat IDs are invalid." });
  if (paymentMethod !== "demo") return res.status(400).json({ error: "Only demo payment is supported." });

  const showId = new ObjectId(showIdText);
  let createdBookingId = null;
  try {
    const show = await shows.findOne({ _id: showId, active: { $ne: false } });
    if (!show) return res.status(404).json({ error: "Showtime not found." });
    const movie = await movies.findOne({ _id: show.movieId });
    if (!movie) return res.status(404).json({ error: "Movie not found." });

    // IMPORTANT: MongoDB unique multikey index on (showId, seats) is the final guard
    // against two concurrent bookings containing the same seat for the same show.
    const alreadyBooked = await bookings.findOne({
      showId, status: "confirmed", seats: { $in: seats }
    }, { projection: { seats: 1 } });
    if (alreadyBooked) {
      const taken = alreadyBooked.seats.filter(s => seats.includes(s));
      return res.status(409).json({ error: `These seats were just booked: ${taken.join(", ")}. Please choose other seats.` });
    }

    const booking = {
      bookingCode: "CB-" + crypto.randomBytes(4).toString("hex").toUpperCase(),
      showId, movieId: movie._id, movieTitle: movie.title,
      showDate: show.date, showTime: show.time, screen: show.screen,
      customerName: name, email, seats: seats.sort(),
      seatCount: seats.length, amount: seats.length * show.price,
      currency: "INR", payment: { method: "demo", status: "simulated_paid", reference: "DEMO-" + crypto.randomBytes(3).toString("hex").toUpperCase() },
      status: "confirmed", createdAt: now(), cancelledAt: null
    };
    const result = await bookings.insertOne(booking);
    createdBookingId = result.insertedId;
    res.status(201).json({
      id: result.insertedId.toString(), bookingCode: booking.bookingCode,
      movieTitle: booking.movieTitle, showDate: booking.showDate, showTime: booking.showTime,
      screen: booking.screen, customerName: booking.customerName, email: booking.email,
      seats: booking.seats, seatCount: booking.seatCount, amount: booking.amount,
      currency: booking.currency, payment: booking.payment, status: booking.status, createdAt: booking.createdAt
    });
  } catch (e) {
    // Unique index is authoritative under concurrent requests.
    if (e && e.code === 11000) {
      return res.status(409).json({ error: "One or more selected seats were just booked by another customer. Refresh the show and select different seats." });
    }
    apiError(res, e, "Booking could not be saved.");
  }
});

app.get("/api/bookings/:code", async (req, res) => {
  const code = clean(req.params.code, 30).toUpperCase();
  try {
    const b = await bookings.findOne({ bookingCode: code });
    if (!b) return res.status(404).json({ error: "Booking not found." });
    res.json({
      bookingCode: b.bookingCode, movieTitle: b.movieTitle, showDate: b.showDate, showTime: b.showTime,
      screen: b.screen, customerName: b.customerName, email: b.email, seats: b.seats,
      seatCount: b.seatCount, amount: b.amount, currency: b.currency, payment: b.payment,
      status: b.status, createdAt: b.createdAt
    });
  } catch (e) { apiError(res, e, "Could not retrieve booking."); }
});

app.post("/api/bookings/:code/cancel", async (req, res) => {
  const code = clean(req.params.code, 30).toUpperCase();
  const email = clean(req.body.email, 160).toLowerCase();
  if (!email) return res.status(400).json({ error: "Enter the email used for the booking." });
  try {
    const result = await bookings.updateOne(
      { bookingCode: code, email, status: "confirmed" },
      { $set: { status: "cancelled", cancelledAt: now() } }
    );
    if (!result.modifiedCount) return res.status(404).json({ error: "Confirmed booking not found for this booking code and email." });
    res.json({ message: "Booking cancelled. Seats are available again.", bookingCode: code, status: "cancelled" });
  } catch (e) { apiError(res, e, "Could not cancel booking."); }
});

// Admin API: protected by a secret key stored in environment variables.
app.get("/api/admin/summary", adminOnly, async (_req, res) => {
  try {
    const [movieCount, showCount, confirmed, cancelled] = await Promise.all([
      movies.countDocuments({ active: { $ne: false } }),
      shows.countDocuments({ active: { $ne: false } }),
      bookings.find({ status: "confirmed" }).toArray(),
      bookings.countDocuments({ status: "cancelled" })
    ]);
    res.json({
      movieCount, showCount, confirmedBookings: confirmed.length, cancelledBookings: cancelled,
      demoRevenue: confirmed.reduce((sum, b) => sum + (b.amount || 0), 0),
      recentBookings: await bookings.find({}).sort({ createdAt: -1 }).limit(20).project({
        bookingCode: 1, movieTitle: 1, customerName: 1, email: 1, seats: 1, amount: 1,
        status: 1, createdAt: 1, showDate: 1, showTime: 1
      }).toArray()
    });
  } catch (e) { apiError(res, e, "Could not load admin summary."); }
});

app.post("/api/admin/movies", adminOnly, async (req, res) => {
  const title = clean(req.body.title, 120), genre = clean(req.body.genre, 80);
  const language = clean(req.body.language, 40), synopsis = clean(req.body.synopsis, 600);
  const poster = clean(req.body.poster, 1000), accent = clean(req.body.accent, 30) || "#8b5cf6";
  const duration = Number(req.body.duration), rating = Number(req.body.rating);
  if (!title || !genre || !language || !synopsis || !Number.isInteger(duration) || duration < 30 || duration > 400 || !Number.isFinite(rating) || rating < 0 || rating > 10) {
    return res.status(400).json({ error: "Fill all movie fields with valid values." });
  }
  try {
    const doc = { title, genre, language, synopsis, poster, accent, duration, rating, featured: !!req.body.featured, active: true, createdAt: now() };
    const result = await movies.insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), ...doc });
  } catch (e) { apiError(res, e, "Could not add movie."); }
});

app.put("/api/admin/movies/:id", adminOnly, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: "Invalid movie ID." });
  const title = clean(req.body.title, 120), genre = clean(req.body.genre, 80);
  const language = clean(req.body.language, 40), synopsis = clean(req.body.synopsis, 600);
  const poster = clean(req.body.poster, 1000), accent = clean(req.body.accent, 30) || "#8b5cf6";
  const duration = Number(req.body.duration), rating = Number(req.body.rating);
  if (!title || !genre || !language || !synopsis || !Number.isInteger(duration) || duration < 30 || duration > 400 || !Number.isFinite(rating) || rating < 0 || rating > 10) {
    return res.status(400).json({ error: "Fill all movie fields with valid values." });
  }
  try {
    const result = await movies.updateOne({ _id: new ObjectId(req.params.id) }, { $set: {
      title, genre, language, synopsis, poster, accent, duration, rating, featured: !!req.body.featured, updatedAt: now()
    }});
    if (!result.matchedCount) return res.status(404).json({ error: "Movie not found." });
    res.json({ message: "Movie updated." });
  } catch (e) { apiError(res, e, "Could not update movie."); }
});

app.delete("/api/admin/movies/:id", adminOnly, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: "Invalid movie ID." });
  try {
    const id = new ObjectId(req.params.id);
    const result = await movies.updateOne({ _id: id }, { $set: { active: false, updatedAt: now() } });
    if (!result.matchedCount) return res.status(404).json({ error: "Movie not found." });
    await shows.updateMany({ movieId: id }, { $set: { active: false } });
    res.json({ message: "Movie and its shows hidden from public listings." });
  } catch (e) { apiError(res, e, "Could not remove movie."); }
});

app.post("/api/admin/shows", adminOnly, async (req, res) => {
  const movieIdText = clean(req.body.movieId, 40), date = clean(req.body.date, 10), time = clean(req.body.time, 5);
  const screen = clean(req.body.screen, 50) || "Screen 1";
  const price = Number(req.body.price), totalSeats = Number(req.body.totalSeats);
  if (!validId(movieIdText) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) ||
      !Number.isFinite(price) || price < 1 || price > 10000 || !Number.isInteger(totalSeats) || totalSeats < 12 || totalSeats > 120) {
    return res.status(400).json({ error: "Enter a valid movie, date, time, ticket price, and seat count (12–120)." });
  }
  try {
    const movie = await movies.findOne({ _id: new ObjectId(movieIdText), active: { $ne: false } });
    if (!movie) return res.status(404).json({ error: "Active movie not found." });
    const doc = { movieId: movie._id, date, time, screen, price, totalSeats, active: true, createdAt: now() };
    const result = await shows.insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), ...doc, movieTitle: movie.title });
  } catch (e) { apiError(res, e, "Could not add showtime."); }
});

app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found." }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

async function seedData() {
  const count = await movies.countDocuments({});
  if (count > 0) return;
  const seedMovies = [
    { title: "Interstellar", genre: "Sci-Fi · Adventure", language: "English", duration: 169, rating: 8.7, synopsis: "A team travels beyond this galaxy to discover whether mankind has a future among the stars.", poster: "https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg", accent: "#a78bfa", featured: true, active: true },
    { title: "Spider-Man: Across the Spider-Verse", genre: "Animation · Action", language: "English", duration: 140, rating: 8.6, synopsis: "Miles Morales swings into a multiverse-spanning adventure that challenges what a hero can be.", poster: "https://image.tmdb.org/t/p/w500/8Vt6mWEReuy4Of61Lnj5Xj794x4.jpg", accent: "#e879f9", featured: true, active: true },
    { title: "Dune: Part Two", genre: "Sci-Fi · Drama", language: "English", duration: 166, rating: 8.5, synopsis: "Paul Atreides unites with Chani and the Fremen while seeking revenge and confronting destiny.", poster: "https://image.tmdb.org/t/p/w500/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg", accent: "#f59e0b", featured: true, active: true },
    { title: "Vikram", genre: "Action · Thriller", language: "Tamil", duration: 174, rating: 8.3, synopsis: "A special investigation uncovers a hidden network of crime, secrets and dangerous loyalties.", poster: "https://image.tmdb.org/t/p/w500/774UV1aCurG4dMQI3VSDm6YvSPr.jpg", accent: "#fb7185", featured: false, active: true },
    { title: "Jailer", genre: "Action · Comedy", language: "Tamil", duration: 168, rating: 7.1, synopsis: "A retired jailer sets out to find his missing son and discovers a much larger criminal web.", poster: "https://image.tmdb.org/t/p/w500/3k3l8m8XQmK8Z6f4vM7y9n3h4hH.jpg", accent: "#f97316", featured: false, active: true },
    { title: "The Batman", genre: "Crime · Drama", language: "English", duration: 176, rating: 7.8, synopsis: "A young vigilante follows a trail of clues through Gotham's corruption and its hidden past.", poster: "https://image.tmdb.org/t/p/w500/74xTEgt7R36Fpooo50r9T25onhq.jpg", accent: "#64748b", featured: false, active: true }
  ];
  const result = await movies.insertMany(seedMovies.map(m => ({ ...m, createdAt: now() })));
  const ids = Object.values(result.insertedIds);
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const date2 = new Date();
  date2.setDate(date2.getDate() + 2);
  const dateString = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const times = ["10:30", "13:45", "17:15", "20:30"];
  const showDocs = [];
  ids.forEach((movieId, i) => {
    times.forEach((time, j) => showDocs.push({
      movieId, date: dateString(j < 2 ? date : date2), time,
      screen: `Screen ${(i % 3) + 1}`, price: [150, 180, 220, 250][j],
      totalSeats: 60, active: true, createdAt: now()
    }));
  });
  await shows.insertMany(showDocs);
  console.log("Seeded sample movies and showtimes.");
}

async function start() {
  try {
    await client.connect();
    db = client.db(DB_NAME);
    movies = db.collection("movies");
    shows = db.collection("shows");
    bookings = db.collection("bookings");
    await Promise.all([
      bookings.createIndex({ bookingCode: 1 }, { unique: true }),
      // This unique multikey index prevents a seat being booked twice for one show.
      // One booking document may contain multiple unique seat IDs.
      bookings.createIndex({ showId: 1, seats: 1 }, {
        unique: true,
        partialFilterExpression: { status: "confirmed" },
        name: "unique_confirmed_seat_per_show"
      }),
      bookings.createIndex({ showId: 1, status: 1 }),
      shows.createIndex({ movieId: 1, date: 1, time: 1 })
    ]);
    await seedData();
    console.log(`Connected to MongoDB database "${DB_NAME}".`);
    app.listen(PORT, () => console.log(`CineBook running on port ${PORT}`));
  } catch (error) {
    console.error("Startup failed:", error.message);
    process.exit(1);
  }
}
async function shutdown() {
  await client.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
start();