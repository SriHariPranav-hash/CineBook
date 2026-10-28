# CineBook — Movie Ticket Booking System

A college database-deployment competition project using HTML, CSS, browser JavaScript, Node.js, Express, MongoDB Atlas, GitHub and Render.

## Features
- Premium responsive cinema UI and sample movie catalogue.
- Showtimes and interactive seats (available / selected / booked).
- Demo-only checkout (no real payment).
- Unique booking code and QR reference; print / save ticket as PDF.
- Look up booking using booking code + email; cancel a confirmed booking.
- Admin dashboard with secret key: view summary/recent bookings, add/edit/hide movies, add showtimes.
- MongoDB Atlas persistence and `/api/health` endpoint.
- Backend validation and duplicate-seat protection.

## Folder structure

```text
CineBook/
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── .env.example
├── .gitignore
├── package.json
├── render.yaml
├── server.js
└── README.md
```

## Requirements
- Node.js 20+
- Git
- MongoDB Atlas account
- GitHub account
- Render account

## Run locally on Windows

Open Command Prompt inside the extracted `CineBook` folder:

```bat
npm install
copy .env.example .env
notepad .env
```

Fill `.env` with your own MongoDB Atlas connection string and a long admin key:

```env
MONGODB_URI=mongodb+srv://YOUR_USER:YOUR_PASSWORD@YOUR_CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=cinebook
PORT=3000
ADMIN_KEY=replace-with-a-long-random-secret
```

Replace every placeholder. If your MongoDB password has characters like `@`, `#`, `/`, or `:`, URL-encode them. Never share `.env` or commit it to GitHub.

Then run:

```bat
npm start
```

Open `http://localhost:3000`. Check `http://localhost:3000/api/health` for the database connection status.

## MongoDB Atlas setup

1. Open https://www.mongodb.com/atlas/database and create a cluster (free-tier availability varies by region).
2. Under Database Access, create a database user with a strong password.
3. Under Network Access, allow your current IP for local development.
4. Choose Connect → Drivers → Node.js and copy the connection string.
5. Put it into `.env`. The app creates the `cinebook` database collections automatically when data is inserted. It seeds sample movies and showtimes on first startup.
6. For Render connectivity, configure Atlas Network Access to allow the deployed service to connect. `0.0.0.0/0` allows any IP and is less secure; use only if needed for a short demo and remove it afterwards if possible.

## NoSQL document design

### `movies`
```json
{
  "_id": "ObjectId",
  "title": "Interstellar",
  "genre": "Sci-Fi · Adventure",
  "language": "English",
  "duration": 169,
  "rating": 8.7,
  "synopsis": "A team travels beyond this galaxy...",
  "poster": "https://...",
  "featured": true,
  "active": true,
  "createdAt": "ISODate"
}
```

### `shows`
```json
{
  "_id": "ObjectId",
  "movieId": "ObjectId reference to movies",
  "date": "YYYY-MM-DD",
  "time": "20:30",
  "screen": "Screen 1",
  "price": 250,
  "totalSeats": 60,
  "active": true
}
```

### `bookings`
```json
{
  "_id": "ObjectId",
  "bookingCode": "CB-1A2B3C4D",
  "showId": "ObjectId reference to shows",
  "movieId": "ObjectId reference to movies",
  "movieTitle": "Interstellar",
  "showDate": "YYYY-MM-DD",
  "showTime": "20:30",
  "screen": "Screen 1",
  "customerName": "Demo Customer",
  "email": "demo@example.com",
  "seats": ["A01", "A02"],
  "seatCount": 2,
  "amount": 500,
  "currency": "INR",
  "payment": {
    "method": "demo",
    "status": "simulated_paid",
    "reference": "DEMO-ABC123"
  },
  "status": "confirmed",
  "createdAt": "ISODate",
  "cancelledAt": null
}
```

## Duplicate-seat protection

The backend checks the selected seats against confirmed bookings and returns HTTP 409 if a seat is already booked. More importantly, startup creates a MongoDB unique multikey index on `{ showId: 1, seats: 1 }` with a partial filter for `status: "confirmed"`. That index is the final database-level guard against concurrent requests trying to book the same seat for the same show. If two customers race for a seat, only one insert can succeed; the other gets a conflict response. Cancelled bookings no longer participate in the partial index, so their seats can be booked again.

For a production ticketing system, use a transaction/seat-hold model with expiry, rate limiting, authentication, and robust concurrent booking tests. This project demonstrates a safe basic duplicate-seat guard, but it is not a production payment system.

## GitHub upload

Create an empty GitHub repository called `CineBook` (do not create another README there). In CMD inside the project folder:

```bat
git init
git add .
git status
git commit -m "Build CineBook movie booking system"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/CineBook.git
git push -u origin main
```

Replace `YOUR-USERNAME`. Check that `.env` is not included in `git status`. If the origin already exists, use:

```bat
git remote -v
git remote set-url origin https://github.com/YOUR-USERNAME/CineBook.git
git push -u origin main
```

## Render deployment

1. Log in to https://render.com.
2. New → Web Service → connect your GitHub repo `CineBook`.
3. Build command: `npm install`; Start command: `npm start`; runtime: Node.
4. Add environment variables in Render:
   - `MONGODB_URI`: your full Atlas connection string
   - `MONGODB_DB`: `cinebook`
   - `ADMIN_KEY`: a long secret (must be the value you enter into the Admin studio)
   - `NODE_ENV`: `production`
5. Deploy. Render gives you a public URL like `https://your-service.onrender.com`.
6. Open `https://YOUR-RENDER-URL/api/health`; expect `{"status":"ok","database":"connected",...}`.
7. Open the public website. In Admin studio, enter the exact `ADMIN_KEY` you set in Render.

## Competition demo script

1. Open the live Render URL and show movie cards.
2. Choose a movie and showtime. Pick seats A01 and A02.
3. Enter fictional name/email and confirm demo booking.
4. Show the booking code, QR code, and print/save PDF option.
5. Refresh the page and book the same show again. The booked seats should be disabled.
6. Try booking the same seats with a second tab/request; backend should reject the duplicate with HTTP 409.
7. Use My ticket with booking code + email to retrieve the ticket; cancel it and show the seats become available again.
8. Unlock Admin studio using `ADMIN_KEY`. Add a movie and showtime, then show them in the public list.
9. Open MongoDB Atlas → `cinebook` → `movies`, `shows`, and `bookings` collections to prove changes are persisted.
10. Show `/api/health` and explain GitHub stores code while Render runs the app and MongoDB Atlas stores live data.

## API routes

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | DB health |
| GET | `/api/movies` | Active movie catalogue |
| GET | `/api/movies/:id/shows` | Showtimes and booked seats |
| POST | `/api/bookings` | Create demo booking |
| GET | `/api/bookings/:code` | Find booking |
| POST | `/api/bookings/:code/cancel` | Cancel booking with email |
| GET | `/api/admin/summary` | Protected admin stats |
| POST | `/api/admin/movies` | Add movie |
| PUT | `/api/admin/movies/:id` | Edit movie |
| DELETE | `/api/admin/movies/:id` | Hide movie |
| POST | `/api/admin/shows` | Add showtime |

Admin requests use the `x-admin-key` header. The key is stored in Render environment variables and never belongs in source code.

## Troubleshooting
- `Missing MONGODB_URI`: edit `.env`; on Render add the environment variable.
- `Authentication failed`: check Atlas DB user credentials and URL-encode special password characters.
- Network/IP error: review Atlas Network Access.
- `Admin access denied`: ensure the admin key entered in the page exactly matches Render's `ADMIN_KEY`.
- Deployment fails: inspect Render logs and ensure Node.js 20+ is available.
- Movie posters don't load: poster images are external; the card shows a fallback when an image URL fails.
- Source updates: `git add .`, `git commit -m "Describe change"`, `git push`; Render redeploys automatically when connected to GitHub.

## Safety and scope
This is a college demo, not a production ticketing platform. It has no real payment integration. Admin access is a shared secret key rather than full user authentication, and booking lookup uses code + email. Avoid real personal data. A production system needs user authentication, stronger authorization, rate limiting, privacy controls, payment-provider integration, seat holds/expiry, and broader concurrency tests.
