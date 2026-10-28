
require("dotenv").config();

const dns = require("node:dns");

if (process.env.USE_PUBLIC_DNS === "true") {
  dns.setServers(["8.8.8.8", "8.8.4.4"]);
}

const express = require("express");
const path = require("node:path");
const crypto = require("node:crypto");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "cinebook";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI. Configure it in your environment.");
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI, {
  serverSelectionTimeoutMS: 15000,
  connectTimeoutMS: 15000,
});

let db;
let movies;
let shows;
let bookings;

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const now = () => new Date();

const clean = (value, max = 160) =>
  String(value ?? "").trim().slice(0, max);

const validId = (id) =>
  typeof id === "string" && ObjectId.isValid(id);

const seatPattern = /^[A-J](0[1-9]|1[0-2])$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function adminOnly(req, res, next) {
  const provided = req.get("x-admin-key") || "";

  if (!ADMIN_KEY || !provided || provided.length !== ADMIN_KEY.length) {
    return res.status(401).json({ error: "Admin access denied." });
  }

  const expectedBuffer = Buffer.from(ADMIN_KEY);
  const providedBuffer = Buffer.from(provided);

  if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return res.status(401).json({ error: "Admin access denied." });
  }

  next();
}

function apiError(res, error, message = "Something went wrong.") {
  console.error(error);
  return res.status(500).json({ error: message });
}

function publicMovie(movie) {
  const { _id, ...rest } = movie;
  return { ...rest, id: _id.toString() };
}

// --------------------------------------------------
// HEALTH CHECK
// GET /api/health
// --------------------------------------------------

app.get("/api/health", async (_req, res) => {
  try {
    await db.command({ ping: 1 });

    res.json({
      status: "ok",
      database: "connected",
      databaseName: DB_NAME,
    });
  } catch (error) {
    apiError(res, error, "Database is unavailable.");
  }
});

// --------------------------------------------------
// LIST MOVIES
// GET /api/movies
// --------------------------------------------------

app.get("/api/movies", async (_req, res) => {
  try {
    const list = await movies
      .find({ active: { $ne: false } })
      .sort({ featured: -1, title: 1 })
      .toArray();

    res.json(list.map(publicMovie));
  } catch (error) {
    apiError(res, error, "Could not load movies.");
  }
});

// --------------------------------------------------
// GET SHOWTIMES FOR A MOVIE
// GET /api/movies/:id/shows
// --------------------------------------------------

app.get("/api/movies/:id/shows", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ error: "Invalid movie ID." });
  }

  try {
    const movie = await movies.findOne({
      _id: new ObjectId(req.params.id),
      active: { $ne: false },
    });

    if (!movie) {
      return res.status(404).json({ error: "Movie not found." });
    }

    const list = await shows
      .find({
        movieId: movie._id,
        active: { $ne: false },
      })
      .sort({ date: 1, time: 1 })
      .toArray();

    const result = [];

    for (const show of list) {
      const booked = await bookings.distinct("seats", {
        showId: show._id,
        status: "confirmed",
      });

      result.push({
        id: show._id.toString(),
        movieId: movie._id.toString(),
        date: show.date,
        time: show.time,
        screen: show.screen,
        price: show.price,
        totalSeats: show.totalSeats,
        bookedSeats: booked,
        availableSeats: Math.max(0, show.totalSeats - booked.length),
      });
    }

    res.json(result);
  } catch (error) {
    apiError(res, error, "Could not load showtimes.");
  }
});

// --------------------------------------------------
// CREATE BOOKING
// POST /api/bookings
// --------------------------------------------------

app.post("/api/bookings", async (req, res) => {
  const showIdText = clean(req.body.showId, 40);
  const name = clean(req.body.customerName, 100);
  const email = clean(req.body.email, 160).toLowerCase();

  const seats = Array.isArray(req.body.seats)
    ? [...new Set(req.body.seats.map((seat) => clean(seat, 5)))]
    : [];

  const paymentMethod = clean(req.body.paymentMethod, 30) || "demo";

  if (!validId(showIdText)) {
    return res.status(400).json({ error: "Choose a valid showtime." });
  }

  if (name.length < 2) {
    return res.status(400).json({ error: "Enter your full name." });
  }

  if (!emailPattern.test(email)) {
    return res.status(400).json({ error: "Enter a valid email." });
  }

  if (seats.length < 1 || seats.length > 8) {
    return res.status(400).json({
      error: "Select between 1 and 8 seats.",
    });
  }

  if (seats.some((seat) => !seatPattern.test(seat))) {
    return res.status(400).json({
      error: "One or more seat IDs are invalid.",
    });
  }

  if (paymentMethod !== "demo") {
    return res.status(400).json({
      error: "Only demo payment is supported.",
    });
  }

  const showId = new ObjectId(showIdText);

  try {
    const show = await shows.findOne({
      _id: showId,
      active: { $ne: false },
    });

    if (!show) {
      return res.status(404).json({ error: "Showtime not found." });
    }

    const movie = await movies.findOne({
      _id: show.movieId,
      active: { $ne: false },
    });

    if (!movie) {
      return res.status(404).json({ error: "Movie not found." });
    }

    // Check that requested seats do not exceed the configured capacity.
    const capacity = Math.min(
      Number(show.totalSeats) || 0,
      120
    );

    const seatNumbers = seats.map((seat) => Number(seat.slice(1)));

    if (seatNumbers.some((number) => number > capacity)) {
      return res.status(400).json({
        error: "One or more seats are outside this show's capacity.",
      });
    }

    const alreadyBooked = await bookings.findOne({
      showId,
      status: "confirmed",
      seats: { $in: seats },
    });

    if (alreadyBooked) {
      const taken = alreadyBooked.seats.filter((seat) =>
        seats.includes(seat)
      );

      return res.status(409).json({
        error: `These seats were just booked: ${taken.join(", ")}.`,
      });
    }

    const booking = {
      bookingCode:
        "CB-" + crypto.randomBytes(4).toString("hex").toUpperCase(),
      showId,
      movieId: movie._id,
      movieTitle: movie.title,
      showDate: show.date,
      showTime: show.time,
      screen: show.screen,
      customerName: name,
      email,
      seats: seats.sort(),
      seatCount: seats.length,
      amount: seats.length * show.price,
      currency: "INR",
      payment: {
        method: "demo",
        status: "simulated_paid",
        reference:
          "DEMO-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
      },
      status: "confirmed",
      createdAt: now(),
      cancelledAt: null,
    };

    const result = await bookings.insertOne(booking);

    res.status(201).json({
      id: result.insertedId.toString(),
      ...booking,
      showId: showId.toString(),
      movieId: movie._id.toString(),
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({
        error: "A selected seat was just booked. Refresh and try again.",
      });
    }

    apiError(res, error, "Booking could not be saved.");
  }
});

// --------------------------------------------------
// RETRIEVE BOOKING
// GET /api/bookings/:code
// --------------------------------------------------

app.get("/api/bookings/:code", async (req, res) => {
  const code = clean(req.params.code, 30).toUpperCase();

  try {
    const booking = await bookings.findOne({ bookingCode: code });

    if (!booking) {
      return res.status(404).json({ error: "Booking not found." });
    }

    res.json(booking);
  } catch (error) {
    apiError(res, error, "Could not retrieve booking.");
  }
});

// --------------------------------------------------
// CANCEL BOOKING
// POST /api/bookings/:code/cancel
// --------------------------------------------------

app.post("/api/bookings/:code/cancel", async (req, res) => {
  const code = clean(req.params.code, 30).toUpperCase();
  const email = clean(req.body.email, 160).toLowerCase();

  if (!email) {
    return res.status(400).json({
      error: "Enter the email used for the booking.",
    });
  }

  try {
    const result = await bookings.updateOne(
      {
        bookingCode: code,
        email,
        status: "confirmed",
      },
      {
        $set: {
          status: "cancelled",
          cancelledAt: now(),
        },
      }
    );

    if (!result.modifiedCount) {
      return res.status(404).json({
        error: "Confirmed booking not found for this code and email.",
      });
    }

    res.json({
      message: "Booking cancelled.",
      bookingCode: code,
      status: "cancelled",
    });
  } catch (error) {
    apiError(res, error, "Could not cancel booking.");
  }
});

// --------------------------------------------------
// ADMIN SUMMARY
// GET /api/admin/summary
// Header: x-admin-key
// --------------------------------------------------

app.get("/api/admin/summary", adminOnly, async (_req, res) => {
  try {
    const [
      movieCount,
      showCount,
      confirmedBookings,
      cancelledBookings,
    ] = await Promise.all([
      movies.countDocuments({ active: { $ne: false } }),
      shows.countDocuments({ active: { $ne: false } }),
      bookings.find({ status: "confirmed" }).toArray(),
      bookings.countDocuments({ status: "cancelled" }),
    ]);

    res.json({
      movieCount,
      showCount,
      confirmedBookings: confirmedBookings.length,
      cancelledBookings,
      demoRevenue: confirmedBookings.reduce(
        (sum, booking) => sum + (booking.amount || 0),
        0
      ),
      recentBookings: await bookings
        .find({})
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray(),
    });
  } catch (error) {
    apiError(res, error, "Could not load admin summary.");
  }
});

// --------------------------------------------------
// ADMIN: ADD MOVIE
// POST /api/admin/movies
// --------------------------------------------------

app.post("/api/admin/movies", adminOnly, async (req, res) => {
  const title = clean(req.body.title, 120);
  const genre = clean(req.body.genre, 80);
  const language = clean(req.body.language, 40);
  const synopsis = clean(req.body.synopsis, 600);
  const poster = clean(req.body.poster, 1000);
  const accent = clean(req.body.accent, 30) || "#8b5cf6";
  const duration = Number(req.body.duration);
  const rating = Number(req.body.rating);

  if (
    !title ||
    !genre ||
    !language ||
    !synopsis ||
    !Number.isInteger(duration) ||
    duration < 30 ||
    duration > 400 ||
    !Number.isFinite(rating) ||
    rating < 0 ||
    rating > 10
  ) {
    return res.status(400).json({
      error: "Fill all movie fields with valid values.",
    });
  }

  try {
    const movie = {
      title,
      genre,
      language,
      synopsis,
      poster,
      accent,
      duration,
      rating,
      featured: !!req.body.featured,
      active: true,
      createdAt: now(),
    };

    const result = await movies.insertOne(movie);

    res.status(201).json({
      id: result.insertedId.toString(),
      ...movie,
    });
  } catch (error) {
    apiError(res, error, "Could not add movie.");
  }
});

// --------------------------------------------------
// ADMIN: UPDATE MOVIE
// PUT /api/admin/movies/:id
// --------------------------------------------------

app.put("/api/admin/movies/:id", adminOnly, async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ error: "Invalid movie ID." });
  }

  const title = clean(req.body.title, 120);
  const genre = clean(req.body.genre, 80);
  const language = clean(req.body.language, 40);
  const synopsis = clean(req.body.synopsis, 600);
  const poster = clean(req.body.poster, 1000);
  const accent = clean(req.body.accent, 30) || "#8b5cf6";
  const duration = Number(req.body.duration);
  const rating = Number(req.body.rating);

  if (
    !title ||
    !genre ||
    !language ||
    !synopsis ||
    !Number.isInteger(duration) ||
    duration < 30 ||
    duration > 400 ||
    !Number.isFinite(rating) ||
    rating < 0 ||
    rating > 10
  ) {
    return res.status(400).json({
      error: "Fill all movie fields with valid values.",
    });
  }

  try {
    const result = await movies.updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          title,
          genre,
          language,
          synopsis,
          poster,
          accent,
          duration,
          rating,
          featured: !!req.body.featured,
          updatedAt: now(),
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ error: "Movie not found." });
    }

    res.json({ message: "Movie updated." });
  } catch (error) {
    apiError(res, error, "Could not update movie.");
  }
});

// --------------------------------------------------
// ADMIN: HIDE MOVIE AND SHOWTIMES
// DELETE /api/admin/movies/:id
// --------------------------------------------------

app.delete("/api/admin/movies/:id", adminOnly, async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ error: "Invalid movie ID." });
  }

  try {
    const id = new ObjectId(req.params.id);

    const result = await movies.updateOne(
      { _id: id },
      { $set: { active: false, updatedAt: now() } }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ error: "Movie not found." });
    }

    await shows.updateMany(
      { movieId: id },
      { $set: { active: false } }
    );

    res.json({ message: "Movie and its shows hidden." });
  } catch (error) {
    apiError(res, error, "Could not remove movie.");
  }
});

// --------------------------------------------------
// ADMIN: ADD SHOWTIME
// POST /api/admin/shows
// --------------------------------------------------

app.post("/api/admin/shows", adminOnly, async (req, res) => {
  const movieIdText = clean(req.body.movieId, 40);
  const date = clean(req.body.date, 10);
  const time = clean(req.body.time, 5);
  const screen = clean(req.body.screen, 50) || "Screen 1";
  const price = Number(req.body.price);
  const totalSeats = Number(req.body.totalSeats);

  if (
    !validId(movieIdText) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^\d{2}:\d{2}$/.test(time) ||
    !Number.isFinite(price) ||
    price < 1 ||
    price > 10000 ||
    !Number.isInteger(totalSeats) ||
    totalSeats < 12 ||
    totalSeats > 120
  ) {
    return res.status(400).json({
      error: "Enter valid movie, date, time, price and seat count.",
    });
  }

  try {
    const movie = await movies.findOne({
      _id: new ObjectId(movieIdText),
      active: { $ne: false },
    });

    if (!movie) {
      return res.status(404).json({ error: "Active movie not found." });
    }

    const show = {
      movieId: movie._id,
      date,
      time,
      screen,
      price,
      totalSeats,
      active: true,
      createdAt: now(),
    };

    const result = await shows.insertOne(show);

    res.status(201).json({
      id: result.insertedId.toString(),
      ...show,
      movieTitle: movie.title,
    });
  } catch (error) {
    apiError(res, error, "Could not add showtime.");
  }
});

// --------------------------------------------------
// UNKNOWN API ROUTES
// --------------------------------------------------

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found." });
});

// --------------------------------------------------
// FRONTEND FALLBACK
// --------------------------------------------------

app.use((req, res, next) => {
  if (req.method !== "GET") {
    return next();
  }

  res.sendFile(path.join(__dirname, "public", "index.html"), (error) => {
    if (error && !res.headersSent) {
      next(error);
    }
  });
});

// --------------------------------------------------
// SEED SAMPLE MOVIES AND SHOWTIMES
// --------------------------------------------------

async function seedData() {
  const count = await movies.countDocuments({});

  if (count > 0) {
    return;
  }

  const seedMovies = [
    {
      title: "Interstellar",
      genre: "Sci-Fi · Adventure",
      language: "English",
      duration: 169,
      rating: 8.7,
      synopsis: "A team travels beyond this galaxy to discover whether mankind has a future among the stars.",
      poster: "https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg",
      accent: "#a78bfa",
      featured: true,
      active: true,
    },
    {
      title: "Spider-Man: Across the Spider-Verse",
      genre: "Animation · Action",
      language: "English",
      duration: 140,
      rating: 8.6,
      synopsis: "Miles Morales swings into a multiverse-spanning adventure that challenges what a hero can be.",
      poster: "https://image.tmdb.org/t/p/w500/8Vt6mWEReuy4Of61Lnj5Xj794x4.jpg",
      accent: "#e879f9",
      featured: true,
      active: true,
    },
    {
      title: "Dune: Part Two",
      genre: "Sci-Fi · Drama",
      language: "English",
      duration: 166,
      rating: 8.5,
      synopsis: "Paul Atreides unites with Chani and the Fremen while seeking revenge and confronting destiny.",
      poster: "https://image.tmdb.org/t/p/w500/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg",
      accent: "#f59e0b",
      featured: true,
      active: true,
    },
    {
      title: "Vikram",
      genre: "Action · Thriller",
      language: "Tamil",
      duration: 174,
      rating: 8.3,
      synopsis: "A special investigation uncovers a hidden network of crime, secrets and dangerous loyalties.",
      poster: "https://image.tmdb.org/t/p/w500/774UV1aCurG4dMQI3VSDm6YvSPr.jpg",
      accent: "#fb7185",
      featured: false,
      active: true,
    },
    {
      title: "Jailer",
      genre: "Action · Comedy",
      language: "Tamil",
      duration: 168,
      rating: 7.1,
      synopsis: "A retired jailer sets out to find his missing son and discovers a much larger criminal web.",
      poster: "https://image.tmdb.org/t/p/w500/3k3l8m8XQmK8Z6f4vM7y9n3h4hH.jpg",
      accent: "#f97316",
      featured: false,
      active: true,
    },
    {
      title: "The Batman",
      genre: "Crime · Drama",
      language: "English",
      duration: 176,
      rating: 7.8,
      synopsis: "A young vigilante follows a trail of clues through Gotham's corruption and its hidden past.",
      poster: "https://image.tmdb.org/t/p/w500/74xTEgt7R36Fpooo50r9T25onhq.jpg",
      accent: "#64748b",
      featured: false,
      active: true,
    },
  ];

  const inserted = await movies.insertMany(
    seedMovies.map((movie) => ({
      ...movie,
      createdAt: now(),
    }))
  );

  const ids = Object.values(inserted.insertedIds);

  const date1 = new Date();
  date1.setDate(date1.getDate() + 1);

  const date2 = new Date();
  date2.setDate(date2.getDate() + 2);

  const dateString = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  const times = ["10:30", "13:45", "17:15", "20:30"];
  const showDocs = [];

  ids.forEach((movieId, i) => {
    times.forEach((time, j) => {
      showDocs.push({
        movieId,
        date: dateString(j < 2 ? date1 : date2),
        time,
        screen: `Screen ${(i % 3) + 1}`,
        price: [150, 180, 220, 250][j],
        totalSeats: 60,
        active: true,
        createdAt: now(),
      });
    });
  });

  await shows.insertMany(showDocs);
  console.log("Seeded sample movies and showtimes.");
}

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

async function start() {
  try {
    await client.connect();

    db = client.db(DB_NAME);
    movies = db.collection("movies");
    shows = db.collection("shows");
    bookings = db.collection("bookings");

    await Promise.all([
      bookings.createIndex({ bookingCode: 1 }, { unique: true }),
      bookings.createIndex({ showId: 1, status: 1 }),
      shows.createIndex({ movieId: 1, date: 1, time: 1 }),
    ]);

    await seedData();

    console.log(`Connected to MongoDB database "${DB_NAME}".`);

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`CineBook running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Startup failed:", error);
    await client.close().catch(() => {});
    process.exit(1);
  }
}

async function shutdown() {
  try {
    await client.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
