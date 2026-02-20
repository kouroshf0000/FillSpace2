"use strict";

(async function initAdminDashboard() {
  const authRes = await fetch("/api/auth/me").catch(() => null);
  if (!authRes || !authRes.ok) {
    window.location.href = "admin-login.html";
    return;
  }
  const authPayload = await authRes.json();
  const user = authPayload.user;
  if (!user || user.role !== "admin") {
    window.location.href = "admin-login.html";
    return;
  }

  const welcome = document.getElementById("admin-welcome");
  if (welcome) {
    welcome.textContent = `Signed in as ${user.name || user.email}`;
  }

  const logoutButton = document.getElementById("admin-logout-btn");
  if (logoutButton instanceof HTMLButtonElement) {
    logoutButton.addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.href = "admin-login.html";
    });
  }

  wireAdminActions();
  await loadAdminQueue();
})();

function wireAdminActions() {
  const tbody = document.querySelector("#admin-review-table tbody");
  if (!(tbody instanceof HTMLElement)) {
    return;
  }
  tbody.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest("[data-admin-action]");
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const reservationId = Number(button.dataset.reservationId);
    if (!Number.isFinite(reservationId)) {
      return;
    }
    const action = String(button.dataset.adminAction || "");
    if (action === "approve" || action === "reject") {
      const approved = action === "approve";
      const notes = approved ? "" : prompt("Add rejection note (only for serious issues):") || "";
      setMessage("Submitting review...");
      const res = await fetch(`/api/admin/reservations/${reservationId}/documents/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, notes }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(payload.error || "Unable to submit review.", true);
        return;
      }
      setMessage(`Reservation ${reservationId} ${approved ? "approved" : "rejected"}.`);
      await loadAdminQueue();
      return;
    }
    if (action === "override") {
      const status = prompt("Enter new status (e.g. booking_confirmed, booking_cancelled):", "booking_confirmed");
      if (!status) {
        return;
      }
      const notes = prompt("Add override reason:", "") || "";
      setMessage("Applying override...");
      const res = await fetch(`/api/admin/reservations/${reservationId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, notes }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(payload.error || "Unable to override status.", true);
        return;
      }
      setMessage(`Reservation ${reservationId} status updated to ${status}.`);
      await loadAdminQueue();
    }
  });
}

async function loadAdminQueue() {
  const tbody = document.querySelector("#admin-review-table tbody");
  if (!(tbody instanceof HTMLElement)) {
    return;
  }
  const res = await fetch("/api/admin/reservations/pending-review");
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    setMessage(payload.error || "Unable to load admin queue.", true);
    return;
  }
  const rows = payload.reservations || [];
  tbody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>#${row.id}</td>
      <td>${escapeHtml(row.property_title || "")}</td>
      <td>${escapeHtml(row.tenant_name || "")}</td>
      <td>${escapeHtml(row.owner_name || "")}</td>
      <td>${escapeHtml(String(row.status || "").replaceAll("_", " "))}</td>
      <td>
        <div class="property-row-actions">
          <button class="table-action-btn" type="button" data-admin-action="approve" data-reservation-id="${row.id}">Approve docs</button>
          <button class="table-action-btn danger" type="button" data-admin-action="reject" data-reservation-id="${row.id}">Reject docs</button>
          <button class="table-action-btn" type="button" data-admin-action="override" data-reservation-id="${row.id}">Override</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }
  if (!tbody.children.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6">No reservations currently require admin review.</td>`;
    tbody.appendChild(tr);
  }
}

function setMessage(text, isError = false) {
  const node = document.getElementById("admin-message");
  if (!(node instanceof HTMLElement)) {
    return;
  }
  node.textContent = text;
  node.classList.toggle("is-error", isError);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
