const $ = (s) => document.querySelector(s);
let movieCache = [];
let currentMovie = null;
let currentShows = [];
let currentShow = null;
let selectedSeats = new Set();
let adminKey = sessionStorage.getItem("cinebookAdminKey") || "";
let lastTicket = null;
let toastTimer;

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function money(v) { return new Intl.NumberFormat("en-IN", { style:"currency", currency:"INR", maximumFractionDigits:0 }).format(Number(v || 0)); }
function dateLabel(value) {
  if (!value) return "";
  const d = new Date(`${value}T12:00:00`);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString("en-IN", { weekday:"short", day:"numeric", month:"short" });
}
function toast(message, error=false) {
  const el = $("#toast"); el.textContent = message; el.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.className = "toast", 3500);
}
async function api(url, options={}) {
  const headers = { ...(options.body ? { "Content-Type":"application/json" } : {}), ...(options.headers || {}) };
  if (adminKey && url.startsWith("/api/admin")) headers["x-admin-key"] = adminKey;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function openModal(id) { $("#"+id).classList.remove("hidden"); document.body.style.overflow="hidden"; }
function closeModal(id) { $("#"+id).classList.add("hidden"); document.body.style.overflow=""; }
document.querySelectorAll("[data-close]").forEach(btn => btn.addEventListener("click", () => closeModal(btn.dataset.close)));
document.querySelectorAll(".modal-backdrop").forEach(el => el.addEventListener("click", e => { if (e.target === el) closeModal(el.id); }));
document.addEventListener("keydown", e => { if (e.key === "Escape") document.querySelectorAll(".modal-backdrop:not(.hidden)").forEach(el => closeModal(el.id)); });

function posterHtml(movie) {
  const fallback = `<div class="poster-fallback" style="--accent:${esc(movie.accent || "#55415d")}"><b>${esc(movie.title)}</b><span>CINEBOOK ORIGINAL</span></div>`;
  if (!movie.poster) return fallback;
  return `<img src="${esc(movie.poster)}" alt="${esc(movie.title)} poster" loading="lazy" data-poster-fallback="${esc(movie.id)}">`;
}
function renderMovies() {
  const search = $("#movie-search").value.trim().toLowerCase();
  const language = $("#language-filter").value;
  const filtered = movieCache.filter(m => (language === "all" || m.language === language) &&
    `${m.title} ${m.genre} ${m.language}`.toLowerCase().includes(search));
  if (!filtered.length) { $("#movie-grid").innerHTML = '<div class="loading-card">No movies match that search. Try another title or language.</div>'; return; }
  $("#movie-grid").innerHTML = filtered.map((m, i) => `
    <article class="movie-card">
      <div class="poster-wrap">${posterHtml(m)}<span class="movie-badge">${m.featured ? "✦ FEATURED" : esc(m.language.toUpperCase())}</span><span class="rating">★ ${Number(m.rating).toFixed(1)}</span></div>
      <div class="movie-info"><h3 class="movie-title" title="${esc(m.title)}">${esc(m.title)}</h3><div class="movie-meta">${esc(m.genre)} · ${m.duration} min</div><div class="movie-card-bottom"><span class="movie-duration">${esc(m.language)}</span><button class="book-btn" data-book="${esc(m.id)}">Book tickets ↗</button></div></div>
    </article>`).join("");
  $("#movie-grid").querySelectorAll("img[data-poster-fallback]").forEach(img => img.addEventListener("error", () => {
    const movie = movieCache.find(item => item.id === img.dataset.posterFallback);
    if (!movie) return;
    const fallback = document.createElement("div");
    fallback.className = "poster-fallback";
    fallback.style.setProperty("--accent", movie.accent || "#55415d");
    const title = document.createElement("b"); title.textContent = movie.title;
    const label = document.createElement("span"); label.textContent = "CINEBOOK ORIGINAL";
    fallback.append(title, label);
    img.replaceWith(fallback);
  }, { once: true }));
  $("#movie-grid").querySelectorAll("[data-book]").forEach(btn => btn.addEventListener("click", () => startBooking(btn.dataset.book)));
}
async function loadMovies() {
  try { movieCache = await api("/api/movies"); renderMovies(); }
  catch (e) { $("#movie-grid").innerHTML = `<div class="loading-card">${esc(e.message)}. Check the server and database.</div>`; }
}
$("#movie-search").addEventListener("input", renderMovies);
$("#language-filter").addEventListener("change", renderMovies);

function buildSeatMap(show) {
  const rows = "ABCDEFGHIJ".split("");
  const seatsPerRow = Math.max(1, Math.min(12, Math.floor(show.totalSeats / rows.length)));
  const booked = new Set(show.bookedSeats || []);
  $("#seat-map").innerHTML = rows.map((row, ri) => {
    const count = ri === rows.length - 1 ? Math.max(1, show.totalSeats - seatsPerRow * 9) : seatsPerRow;
    let seatButtons = "";
    for (let n=1; n<=count; n++) {
      const id = `${row}${String(n).padStart(2,"0")}`;
      const isBooked = booked.has(id);
      const isSelected = selectedSeats.has(id);
      const aisle = n === Math.ceil(count/2)+1 ? " aisle" : "";
      seatButtons += `<button type="button" class="seat ${isBooked?"booked":isSelected?"selected":"available"}${aisle}" data-seat="${id}" ${isBooked?"disabled":""} aria-label="Seat ${id}${isBooked?", booked":""}" title="${id}${isBooked?" · booked":""}">${n}</button>`;
    }
    return `<div class="seat-row"><span class="row-label">${row}</span>${seatButtons}</div>`;
  }).join("");
  $("#seat-map").querySelectorAll("[data-seat]").forEach(btn => btn.addEventListener("click", () => {
    const id = btn.dataset.seat;
    if (selectedSeats.has(id)) selectedSeats.delete(id);
    else if (selectedSeats.size >= 8) return toast("Maximum 8 seats per booking.", true);
    else selectedSeats.add(id);
    renderSeatSelection();
  }));
  renderSeatSelection();
}
function renderSeatSelection() {
  $("#seat-map").querySelectorAll("[data-seat]").forEach(btn => {
    if (btn.disabled) return;
    btn.classList.toggle("selected", selectedSeats.has(btn.dataset.seat));
    btn.classList.toggle("available", !selectedSeats.has(btn.dataset.seat));
  });
  const sorted = [...selectedSeats].sort();
  $("#selected-seats-label").textContent = sorted.length ? sorted.join(", ") : "None";
  $("#selected-total").textContent = money(sorted.length * (currentShow?.price || 0));
}
function renderShows() {
  $("#show-select").innerHTML = currentShows.map(s => `<option value="${esc(s.id)}">${esc(dateLabel(s.date))} · ${esc(s.time)} · ${esc(s.screen)} (${s.availableSeats} left)</option>`).join("");
  if (!currentShows.length) {
    $("#show-select").innerHTML = '<option value="">No shows available</option>';
    $("#seat-map").innerHTML = '<div class="muted">No active shows for this movie yet.</div>';
    $("#confirm-booking").disabled = true; $("#show-price").textContent = ""; return;
  }
  $("#confirm-booking").disabled = false;
  currentShow = currentShows[0]; selectedSeats.clear();
  $("#show-select").value = currentShow.id;
  $("#show-price").textContent = `${money(currentShow.price)} / seat`;
  buildSeatMap(currentShow);
}
async function startBooking(movieId) {
  currentMovie = movieCache.find(m => m.id === movieId);
  if (!currentMovie) return;
  selectedSeats.clear();
  $("#booking-movie-info").innerHTML = `<div><b>${esc(currentMovie.title)}</b><br><span>${esc(currentMovie.genre)} · ${currentMovie.duration} min</span></div><span>★ ${Number(currentMovie.rating).toFixed(1)}</span>`;
  $("#booking-step").classList.remove("hidden"); $("#ticket-result").classList.add("hidden");
  $("#booking-title").innerHTML = 'Pick your seats<span>.</span>';
  $("#confirm-booking").disabled = false;
  openModal("booking-modal");
  $("#show-select").innerHTML = '<option>Loading showtimes…</option>';
  try {
    currentShows = await api(`/api/movies/${encodeURIComponent(movieId)}/shows`);
    renderShows();
  } catch (e) { $("#show-select").innerHTML = ""; $("#seat-map").textContent = e.message; }
}
$("#show-select").addEventListener("change", () => {
  currentShow = currentShows.find(s => s.id === $("#show-select").value);
  selectedSeats.clear();
  if (!currentShow) return;
  $("#show-price").textContent = `${money(currentShow.price)} / seat`;
  buildSeatMap(currentShow);
});
async function refreshShowSeats() {
  currentShows = await api(`/api/movies/${encodeURIComponent(currentMovie.id)}/shows`);
  const updated = currentShows.find(s => s.id === currentShow.id);
  if (updated) { currentShow = updated; selectedSeats.clear(); renderShows(); }
}
function makeTicketHtml(ticket, includeCancel=false) {
  const data = encodeURIComponent(JSON.stringify({ bookingCode:ticket.bookingCode, movie:ticket.movieTitle, date:ticket.showDate, time:ticket.showTime, screen:ticket.screen, seats:ticket.seats }));
  return `<div class="ticket-card" id="print-ticket">
    <div class="ticket-card-head"><b>✦ CINEBOOK</b><span>DEMO E-TICKET</span></div>
    <h4>${esc(ticket.movieTitle)}</h4><div class="ticket-sub">${esc(dateLabel(ticket.showDate))} · ${esc(ticket.showTime)} · ${esc(ticket.screen)}</div>
    <div class="ticket-data"><div><small>BOOKING CODE</small><b>${esc(ticket.bookingCode)}</b></div><div><small>BOOKING STATUS</small><b class="status-tag ${ticket.status==="cancelled"?"cancelled":""}">${esc(ticket.status.toUpperCase())}</b></div><div><small>GUEST</small><b>${esc(ticket.customerName)}</b></div><div><small>SEATS</small><b>${esc((ticket.seats||[]).join(", "))}</b></div><div><small>TICKETS</small><b>${ticket.seatCount}</b></div><div><small>DEMO TOTAL</small><b>${money(ticket.amount)}</b></div></div>
    <div class="ticket-code"><div><small>SCAN / BOOKING REFERENCE</small><strong>${esc(ticket.bookingCode)}</strong><div class="ticket-sub">Simulated payment · No real money</div></div><div id="qrcode"></div></div>
  </div>
  <div class="ticket-actions"><button class="button button-dark" id="download-ticket">Print / Save PDF</button>${includeCancel && ticket.status==="confirmed" ? '<button class="cancel-ticket" id="cancel-ticket">Cancel booking</button>' : ""}</div>`;
}
function renderQr(ticket) {
  const target = $("#qrcode");
  if (!target) return;
  target.innerHTML = "";
  if (window.QRCode) new QRCode(target, { text: `${location.origin}/?booking=${encodeURIComponent(ticket.bookingCode)}`, width: 76, height: 76, colorDark:"#111111", colorLight:"#ffffff", correctLevel:QRCode.CorrectLevel.M });
  else target.textContent = ticket.bookingCode;
}
function showTicket(ticket, containerSelector, includeCancel=false) {
  lastTicket = ticket;
  const container = $(containerSelector);
  container.innerHTML = `<div class="ticket-success"><div class="success-mark">✓</div><h3>${ticket.status==="cancelled"?"Booking cancelled":"You're all set!"}</h3><p>${ticket.status==="cancelled"?"Your seats have been released.":"Your demo ticket has been saved to the database."}</p></div>${makeTicketHtml(ticket, includeCancel)}`;
  renderQr(ticket);
  const print = container.querySelector("#download-ticket");
  if (print) print.addEventListener("click", printTicket);
  const cancel = container.querySelector("#cancel-ticket");
  if (cancel) cancel.addEventListener("click", () => cancelBooking(ticket, containerSelector));
}
function printTicket() {
  const ticketEl = document.querySelector("#print-ticket");
  if (!ticketEl) return;
  const w = window.open("", "_blank", "width=720,height=780");
  if (!w) return toast("Allow pop-ups to print or save the ticket as PDF.", true);
  w.document.write(`<!doctype html><html><head><title>CineBook Ticket</title><style>body{font:14px Arial;padding:25px;color:#222}.ticket-card{max-width:520px;margin:20px auto;border:1px dashed #88734f;padding:20px;border-radius:12px}.ticket-card-head,.ticket-code{display:flex;justify-content:space-between;border-bottom:1px dashed #aaa;padding-bottom:12px}.ticket-data{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-top:20px}.ticket-data small,.ticket-code small{display:block;color:#777;font-size:10px}.ticket-data b{display:block;margin-top:5px}.ticket-code{margin-top:18px;padding-top:15px;border-top:1px dashed #aaa;border-bottom:0}#qrcode{width:80px;height:80px}#qrcode img{width:80px}h4{font-size:24px;margin:20px 0 5px}.ticket-sub{color:#666;font-size:12px;margin-top:5px}</style></head><body>${ticketEl.outerHTML}<script>window.onload=()=>window.print()<\\/script></body></html>`);
  w.document.close();
}
async function confirmBooking() {
  if (!currentShow) return toast("No showtime is selected.", true);
  const customerName = $("#customer-name").value.trim(), email = $("#customer-email").value.trim();
  if (customerName.length < 2) return toast("Enter your name.", true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast("Enter a valid email.", true);
  if (!selectedSeats.size) return toast("Choose at least one seat.", true);
  const button = $("#confirm-booking"); button.disabled = true; button.textContent = "Confirming booking…";
  try {
    const ticket = await api("/api/bookings", { method:"POST", body:JSON.stringify({
      showId:currentShow.id, customerName, email, seats:[...selectedSeats], paymentMethod:"demo"
    })});
    $("#booking-step").classList.add("hidden"); $("#ticket-result").classList.remove("hidden");
    $("#booking-title").innerHTML = 'Booking confirmed<span>.</span>';
    showTicket(ticket, "#ticket-result", false);
    toast("Booking saved successfully!");
    await refreshShowSeats().catch(()=>{});
    if (adminKey) await loadAdmin().catch(()=>{});
  } catch (e) {
    toast(e.message, true);
    try { await refreshShowSeats(); } catch {}
  } finally { button.disabled = false; button.innerHTML = 'Confirm demo booking <span>↗</span>'; }
}
$("#confirm-booking").addEventListener("click", confirmBooking);

$("#find-booking-btn").addEventListener("click", () => { $("#found-ticket").innerHTML=""; $("#find-booking-form").reset(); openModal("find-modal"); });
$("#find-booking-form").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("#find-code").value.trim().toUpperCase(), email = $("#find-email").value.trim().toLowerCase();
  const target = $("#found-ticket"); target.innerHTML = '<p class="muted">Looking up booking…</p>';
  try {
    const ticket = await api(`/api/bookings/${encodeURIComponent(code)}`);
    if (ticket.email !== email) throw new Error("Booking code and email do not match.");
    showTicket(ticket, "#found-ticket", true);
  } catch (err) { target.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
});
async function cancelBooking(ticket, containerSelector) {
  if (!confirm(`Cancel booking ${ticket.bookingCode}?`)) return;
  try {
    const result = await api(`/api/bookings/${encodeURIComponent(ticket.bookingCode)}/cancel`, {
      method:"POST", body:JSON.stringify({ email:ticket.email })
    });
    ticket.status = result.status;
    showTicket(ticket, containerSelector, false);
    toast("Booking cancelled; seats are released.");
    await loadMovies();
    if (currentMovie) await refreshShowSeats().catch(()=>{});
    if (adminKey) await loadAdmin().catch(()=>{});
  } catch (e) { toast(e.message, true); }
}

async function adminLogin() {
  const key = $("#admin-key").value.trim();
  if (!key) return toast("Enter the admin key configured on the server.", true);
  const previous = adminKey; adminKey = key;
  try {
    await api("/api/admin/summary");
    sessionStorage.setItem("cinebookAdminKey", key);
    $("#admin-status").textContent = "✓ Admin unlocked";
    $("#admin-status").style.color = "#a7edb7";
    $("#admin-content").classList.remove("hidden");
    await loadAdmin();
    toast("Admin studio unlocked for this browser tab.");
  } catch (e) {
    adminKey = previous;
    sessionStorage.removeItem("cinebookAdminKey");
    toast(e.message, true);
  }
}
$("#admin-login-btn").addEventListener("click", adminLogin);
$("#admin-key").addEventListener("keydown", e => { if(e.key==="Enter") adminLogin(); });
async function loadAdmin() {
  const data = await api("/api/admin/summary");
  $("#admin-stats").innerHTML = [
    ["ACTIVE MOVIES",data.movieCount],["ACTIVE SHOWTIMES",data.showCount],["CONFIRMED BOOKINGS",data.confirmedBookings],["DEMO REVENUE",money(data.demoRevenue)]
  ].map(([label,value])=>`<div class="admin-stat"><small>${label}</small><b>${esc(value)}</b></div>`).join("");
  $("#recent-bookings").innerHTML = data.recentBookings.length ? data.recentBookings.map(b=>`<div class="recent-row"><div><b>${esc(b.movieTitle)} · ${esc(b.bookingCode)}</b><small>${esc(b.customerName)} · ${esc(b.seats.join(", "))} · ${esc(b.showDate)} ${esc(b.showTime)}</small><span class="status-tag ${b.status==="cancelled"?"cancelled":""}">${esc(b.status.toUpperCase())}</span></div><div class="recent-amount">${money(b.amount)}</div></div>`).join("") : '<p class="muted">No bookings yet.</p>';
  $("#admin-movie-select").innerHTML = movieCache.map(m=>`<option value="${esc(m.id)}">${esc(m.title)}</option>`).join("");
  $("#admin-movie-list").innerHTML = movieCache.map(m=>`<div class="admin-movie-row"><div><b>${esc(m.title)}</b><small>${esc(m.language)} · ${esc(m.genre)} · ${m.duration} min</small></div><div class="movie-actions"><button data-edit="${esc(m.id)}">Edit</button><button class="danger" data-delete="${esc(m.id)}">Hide</button></div></div>`).join("");
  $("#admin-movie-list").querySelectorAll("[data-edit]").forEach(b=>b.addEventListener("click",()=>editMovie(b.dataset.edit)));
  $("#admin-movie-list").querySelectorAll("[data-delete]").forEach(b=>b.addEventListener("click",()=>deleteMovie(b.dataset.delete)));
}
function formData(form) {
  const fd = new FormData(form), data = Object.fromEntries(fd.entries());
  data.featured = fd.has("featured");
  for (const key of ["duration","rating","price","totalSeats"]) if (data[key] !== undefined) data[key] = Number(data[key]);
  return data;
}
$("#movie-form").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await api("/api/admin/movies", { method:"POST", body:JSON.stringify(formData(e.target)) });
    e.target.reset(); e.target.elements.duration.value=150; e.target.elements.rating.value=8.0; e.target.elements.accent.value="#8b5cf6";
    await loadMovies(); await loadAdmin(); toast("Movie added to MongoDB.");
  } catch(err) { toast(err.message,true); }
});
$("#show-form").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await api("/api/admin/shows", { method:"POST", body:JSON.stringify(formData(e.target)) });
    await loadAdmin(); toast("Showtime saved to MongoDB.");
  } catch(err) { toast(err.message,true); }
});
async function editMovie(id) {
  const m = movieCache.find(x=>x.id===id); if (!m) return;
  const title = prompt("Movie title:",m.title); if (title===null) return;
  const genre = prompt("Genre:",m.genre); if (genre===null) return;
  const language = prompt("Language:",m.language); if (language===null) return;
  const duration = Number(prompt("Duration in minutes:",m.duration)); if (!duration) return toast("Invalid duration.",true);
  const rating = Number(prompt("Rating out of 10:",m.rating)); if (!Number.isFinite(rating)) return toast("Invalid rating.",true);
  const synopsis = prompt("Synopsis:",m.synopsis); if (synopsis===null) return;
  try {
    await api(`/api/admin/movies/${encodeURIComponent(id)}`,{method:"PUT",body:JSON.stringify({...m,title,genre,language,duration,rating,synopsis})});
    await loadMovies(); await loadAdmin(); toast("Movie updated.");
  } catch(e) { toast(e.message,true); }
}
async function deleteMovie(id) {
  const m=movieCache.find(x=>x.id===id); if(!m || !confirm(`Hide "${m.title}" from public listings? Existing booking history will remain.`)) return;
  try {
    await api(`/api/admin/movies/${encodeURIComponent(id)}`,{method:"DELETE"});
    await loadMovies(); await loadAdmin(); toast("Movie hidden from listings.");
  } catch(e) { toast(e.message,true); }
}
$("#refresh-admin").addEventListener("click", async()=>{try{await loadMovies();await loadAdmin();toast("Admin data refreshed.");}catch(e){toast(e.message,true);}});
async function init() {
  try {
    const health = await api("/api/health");
    console.log("CineBook database status:",health.database);
  } catch(e) { console.warn(e.message); }
  await loadMovies();
  const params = new URLSearchParams(location.search);
  const code = params.get("booking");
  if (code) { $("#find-code").value=code; openModal("find-modal"); }
  if (adminKey) {
    $("#admin-key").value=adminKey;
    try { await api("/api/admin/summary"); $("#admin-status").textContent="✓ Admin unlocked"; $("#admin-content").classList.remove("hidden"); await loadAdmin(); }
    catch { adminKey="";sessionStorage.removeItem("cinebookAdminKey"); }
  }
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  const dateInput = document.querySelector('#show-form [name="date"]');
  if(dateInput) dateInput.value=`${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,"0")}-${String(tomorrow.getDate()).padStart(2,"0")}`;
}
init();