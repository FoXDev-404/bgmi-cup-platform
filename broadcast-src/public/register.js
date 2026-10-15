const $ = (id) => document.getElementById(id);
const form = $("registrationForm");
let captain = null;
const authGate = $("captainAuthGate");
function feedback(id, text, success = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `form-message show${success ? " success" : ""}`;
}
function clearFeedback(id) {
  const el = $(id);
  if (el) {
    el.textContent = "";
    el.className = "form-message";
  }
}
function showAuthTab(tab) {
  document
    .querySelectorAll("[data-auth-tab]")
    .forEach((b) => b.classList.toggle("active", b.dataset.authTab === tab));
  $("captainSigninForm").classList.toggle("hidden", tab !== "signin");
  $("captainSignupForm").classList.toggle("hidden", tab !== "create");
  $("portalTitle").textContent =
    tab === "create" ? "Create captain account" : "Captain access";
  $("portalSubtitle").textContent =
    tab === "create"
      ? "One authenticated captain account per team."
      : "Sign in to manage your one team application.";
}
document
  .querySelectorAll("[data-auth-tab]")
  .forEach((b) =>
    b.addEventListener("click", () => showAuthTab(b.dataset.authTab)),
  );
function digitsOnly(el) {
  const next = el.value.replace(/\D/g, "").slice(0, 15);
  if (el.value !== next) el.value = next;
}
$("captainPhone")?.addEventListener("input", (e) => digitsOnly(e.target));
document
  .querySelectorAll('input[name^="playerUid"]')
  .forEach((el) => el.addEventListener("input", (e) => digitsOnly(e.target)));
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  let data = {};
  try {
    data = await response.json();
  } catch {}
  if (!response.ok) {
    const e = new Error(data.error || "Request failed.");
    e.status = response.status;
    throw e;
  }
  return data;
}
async function loadInfo() {
  try {
    const d = await api("/api/public/registration-info");
    document.title = `Team Registration · ${d.tournamentName || "BGMI Broadcast"}`;
    document.querySelector(".reg-hero .eyebrow").textContent =
      `BATTLEGROUNDS · ${(d.format || "ESPORTS TOURNAMENT").toUpperCase()} · TEAM ENTRY`;
    $("regAccepted").textContent = d.approved || 0;
    $("regCapacity").textContent = `${d.reserved || 0} / ${d.maxTeams || 96}`;
    $("regEventStatus").textContent = d.open ? "OPEN" : "CLOSED";
    $("closedPanel").classList.toggle("hidden", Boolean(d.open));
    if (!d.open) form.classList.add("hidden");
    return d;
  } catch {
    return null;
  }
}
function showCaptainSession(user) {
  captain = user;
  authGate.classList.add("hidden");
  $("captainSessionPanel").classList.remove("hidden");
  $("captainSessionName").textContent = user.captainName || "Captain";
  $("captainSessionContact").textContent =
    `${user.email || ""} · ${user.phone || ""}`;
  form.classList.remove("hidden");
  $("successPanel").classList.add("hidden");
  $("existingApplicationPanel").classList.add("hidden");
  checkMyApplication();
}
function showLoggedOut() {
  captain = null;
  authGate.classList.remove("hidden");
  $("captainSessionPanel").classList.add("hidden");
  form.classList.add("hidden");
  $("successPanel").classList.add("hidden");
  $("existingApplicationPanel").classList.add("hidden");
}
async function checkMyApplication() {
  if (!captain) return;
  try {
    const d = await api("/api/captain/my-registration");
    if (d.registration) {
      form.classList.add("hidden");
      $("successPanel").classList.add("hidden");
      $("existingApplicationPanel").classList.remove("hidden");
      $("existingTeamName").textContent = d.registration.teamName;
      $("existingStatusText").textContent =
        `APPLICATION STATUS: ${(d.registration.status || "pending").toUpperCase()}`;
      $("existingAssignedText").textContent = d.registration.assignedTeamId
        ? `Assigned tournament slot #${d.registration.assignedTeamId} · GROUP ${d.registration.assignedGroup}`
        : d.registration.reason || "Your team has one application on file.";
    } else {
      form.classList.remove("hidden");
      $("existingApplicationPanel").classList.add("hidden");
    }
  } catch (e) {
    if (e.status === 401) showLoggedOut();
  }
}
$("captainSigninForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFeedback("signinMessage");
  const btn = $("captainSigninBtn");
  btn.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(e.currentTarget));
    const result = await api("/api/captain/auth/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showCaptainSession(result.user);
  } catch (err) {
    feedback("signinMessage", err.message);
  } finally {
    btn.disabled = false;
  }
});
$("captainSignupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearFeedback("signupMessage");
  const phone = $("captainPhone");
  digitsOnly(phone);
  if (!/^\d{10,15}$/.test(phone.value)) {
    feedback("signupMessage", "Mobile number must contain 10–15 digits only.");
    return;
  }
  const btn = $("captainSignupBtn");
  btn.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(e.currentTarget));
    const result = await api("/api/captain/auth/signup", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showCaptainSession(result.user);
  } catch (err) {
    feedback("signupMessage", err.message);
  } finally {
    btn.disabled = false;
  }
});
$("captainSignoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    showLoggedOut();
  }
});
function message(text, success = false) {
  const el = $("formMessage");
  el.textContent = text;
  el.className = `form-message show${success ? " success" : ""}`;
}
function clearMessage() {
  $("formMessage").textContent = "";
  $("formMessage").className = "form-message";
}
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearMessage();
  if (!captain)
    return message("Sign in with your captain account before submitting.");
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form).entries());
  for (let i = 1; i <= 4; i++) {
    data["playerUid" + i] = String(data["playerUid" + i] || "")
      .replace(/\D/g, "")
      .slice(0, 15);
    if (!/^[0-9]{6,15}$/.test(data["playerUid" + i]))
      return message(
        `Player ${String(i).padStart(2, "0")} needs a BGMI UID containing 6–15 digits.`,
      );
  }
  if (new Set([1, 2, 3, 4].map((i) => data["playerUid" + i])).size !== 4)
    return message("Each player must have a different BGMI Player UID.");
  if (!data.consent)
    return message("Confirm the information is accurate before submitting.");
  const btn = $("submitRegistration");
  btn.disabled = true;
  btn.innerHTML = "SUBMITTING APPLICATION… <span>◌</span>";
  try {
    const result = await api("/api/registrations", {
      method: "POST",
      body: JSON.stringify(data),
    });
    form.classList.add("hidden");
    $("successPanel").classList.remove("hidden");
    $("successText").textContent =
      `${data.teamName} submitted successfully. Reference: ${result.registrationId}. The team appears in production after organizer approval.`;
    await checkMyApplication();
  } catch (err) {
    message(err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "SUBMIT TEAM APPLICATION <span>→</span>";
  }
});
$("refreshApplication").addEventListener("click", checkMyApplication);
$("refreshExistingApplication").addEventListener("click", checkMyApplication);
(async () => {
  const d = await loadInfo();
  if (!d) return;
  try {
    const result = await api("/api/captain/auth/me");
    showCaptainSession(result.user);
  } catch {
    showLoggedOut();
  }
  if (!d.open) {
    form.classList.add("hidden");
    $("closedPanel").classList.remove("hidden");
  }
})();
