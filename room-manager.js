(() => {
  "use strict";

  const config = window.HAVEN_SUPABASE_CONFIG;
  const message = document.getElementById("manager-message");
  const content = document.getElementById("manager-content");
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const formatMoney = (value) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(value) || 0);
  const formatDate = (value) => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
  const localDate = (offset = 0) => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const coolingName = (value) => ({ ac: "Air conditioning", fan: "Fan", none: "No AC or fan" })[value] || "Not set";
  let client;
  let state;
  let busy = false;

  const setMessage = (text, isError = false) => {
    message.textContent = text;
    message.classList.toggle("error", isError);
    message.hidden = !text;
  };
  const rpc = async (name, args) => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  };
  const activeHoldsForRoom = (buildingId, unitId) => state.holds.filter((hold) =>
    hold.buildingId === buildingId && hold.unitId === unitId);
  const render = () => {
    content.innerHTML = state.buildings.length ? state.buildings.map((building) => `
      <section class="building-card">
        <h2>${escapeHtml(building.name || "Building")}</h2>
        <div class="room-list">${building.rooms.map((room) => {
          const holds = activeHoldsForRoom(building.id, room.id);
          const occupied = room.occupied || room.dailyBookedToday;
          const status = room.occupied ? "Occupied by a monthly tenant"
            : room.dailyBookedToday ? "Booked today"
              : holds.some((hold) => hold.startDate <= localDate() && hold.endDate > localDate()) ? "On hold today"
                : "Available today";
          return `<article class="room-card">
            <div class="room-heading"><div><h3>Room ${escapeHtml(room.number || "—")}</h3><p>Floor ${escapeHtml(room.floor || "not set")} · ${escapeHtml(coolingName(room.cooling))} · ${formatMoney(room.rent)} THB / month</p></div><span class="status${occupied || status !== "Available today" ? " busy" : ""}">${status}</span></div>
            <form class="room-edit" data-room-form data-building="${escapeHtml(building.id)}" data-unit="${escapeHtml(room.id)}">
              <label class="field">Room number<input name="number" maxlength="30" required value="${escapeHtml(room.number)}"></label>
              <label class="field">Floor<input name="floor" maxlength="30" required value="${escapeHtml(room.floor)}"></label>
              <label class="field">Listed rent (THB / month)<input name="rent" type="number" min="0" max="100000000" step="0.01" required value="${escapeHtml(room.rent)}"></label>
              <label class="field">Room type<select name="cooling" required><option value="ac" ${room.cooling === "ac" ? "selected" : ""}>Air conditioning</option><option value="fan" ${room.cooling === "fan" ? "selected" : ""}>Fan</option><option value="none" ${room.cooling === "none" ? "selected" : ""}>No AC or fan</option></select></label>
              <button class="button" type="submit">Request room change</button>
            </form>
            <p class="status-note">Changing the listed price does not change an existing tenant’s agreed rent.</p>
            <section class="hold-section">
              <h4>Temporary room holds</h4>
              <form class="hold-form" data-hold-form data-building="${escapeHtml(building.id)}" data-unit="${escapeHtml(room.id)}">
                <label class="field">Hold this room<input aria-label="Room to hold" disabled value="Room ${escapeHtml(room.number)}"></label>
                <label class="field">Start date<input name="startDate" type="date" min="${localDate()}" required></label>
                <label class="field">End date (available again)<input name="endDate" type="date" min="${localDate(1)}" required></label>
                <button class="button secondary" type="submit">Request hold</button>
              </form>
              ${holds.length ? `<ul class="hold-list">${holds.map((hold) => `<li><span>${formatDate(hold.startDate)} – ${formatDate(hold.endDate)} · available again on end date</span><button class="button danger" type="button" data-cancel-hold="${escapeHtml(hold.id)}">Request removal</button></li>`).join("")}</ul>` : `<p class="status-note">No active or upcoming holds. Holds release automatically on their end date.</p>`}
            </section>
          </article>`;
        }).join("") || `<p class="status-note">No rooms listed in this building.</p>`}</div>
      </section>`).join("") : `<section class="building-card"><p>No buildings or rooms were found in the Haven workspace.</p></section>`;
    if (state.pendingRequests?.length) {
      content.insertAdjacentHTML("afterbegin", `<section class="building-card pending-requests"><h2>Waiting for Haven owner approval</h2><p>These requests have not changed live room records. The owner must approve them in the signed-in Haven app.</p><ul>${state.pendingRequests.map((request) => {
        const room = state.buildings.flatMap((building) => building.rooms).find((item) => item.id === request.unitId);
        return `<li>${escapeHtml(request.action.replace(/_/g, " "))} · Room ${escapeHtml(room?.number || "—")}</li>`;
      }).join("")}</ul></section>`);
    }
  };
  const setBusy = (form, value) => {
    form.querySelectorAll("button").forEach((button) => { button.disabled = value; });
    busy = value;
  };

  content.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || busy) return;
    event.preventDefault();
    const values = new FormData(form);
    setBusy(form, true);
    try {
      if (form.matches("[data-room-form]")) {
        await rpc("request_haven_room_change", {
          p_access_token: token,
          p_action: "update_room",
          p_building_id: form.dataset.building,
          p_unit_id: form.dataset.unit,
          p_request_data: {
            number: String(values.get("number")).trim(),
            floor: String(values.get("floor")).trim(),
            rent: Number(values.get("rent")),
            cooling: values.get("cooling")
          }
        });
        state = await rpc("get_haven_room_manager", { p_access_token: token });
        render();
        setMessage("Room-change request sent. Nothing changes until the Haven owner approves it in their signed-in app.");
      } else if (form.matches("[data-hold-form]")) {
        const startDate = String(values.get("startDate"));
        const endDate = String(values.get("endDate"));
        if (endDate <= startDate) throw new Error("The end date must be after the start date.");
        await rpc("request_haven_room_change", {
          p_access_token: token,
          p_action: "create_hold",
          p_building_id: form.dataset.building,
          p_unit_id: form.dataset.unit,
          p_request_data: { startDate, endDate }
        });
        state = await rpc("get_haven_room_manager", { p_access_token: token });
        render();
        setMessage("Room-hold request sent. Nothing changes until the Haven owner approves it in their signed-in app.");
      }
    } catch (error) {
      console.error("Haven room manager could not save the request:", error);
      setMessage(error.message || "The request could not be saved. Please try again.", true);
    } finally {
      setBusy(form, false);
    }
  });
  content.addEventListener("click", async (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-cancel-hold]") : null;
    if (!button || busy) return;
    button.disabled = true;
    busy = true;
    try {
      const hold = state.holds.find((item) => item.id === button.dataset.cancelHold);
      if (!hold) throw new Error("This active room hold could not be found.");
      await rpc("request_haven_room_change", {
        p_access_token: token,
        p_action: "cancel_hold",
        p_building_id: hold.buildingId,
        p_unit_id: hold.unitId,
        p_request_data: { holdId: hold.id }
      });
      state = await rpc("get_haven_room_manager", { p_access_token: token });
      render();
      setMessage("Hold-removal request sent. The room stays held until the Haven owner approves it.");
    } catch (error) {
      console.error("Haven room manager could not remove the hold:", error);
      setMessage(error.message || "The hold could not be removed. Please try again.", true);
      button.disabled = false;
    } finally {
      busy = false;
    }
  });

  const start = async () => {
    if (!config?.url || !config?.publishableKey || !window.supabase?.createClient) {
      setMessage("The room manager is not configured. Ask the Haven owner to check the app setup.", true);
      return;
    }
    if (!uuidPattern.test(token)) {
      setMessage("This room-management link is missing or invalid. Ask the Haven owner for a current link.", true);
      return;
    }
    client = window.supabase.createClient(config.url, config.publishableKey);
    try {
      state = await rpc("get_haven_room_manager", { p_access_token: token });
      if (!state || !Array.isArray(state.buildings) || !Array.isArray(state.holds)) {
        setMessage("This room-management link has been revoked or is invalid. Ask the Haven owner for a new link.", true);
        return;
      }
      render();
      setMessage(`Room information loaded. ${state.holds.length} active or upcoming holds.`);
    } catch (error) {
      console.error("Haven room manager could not load room information:", error);
      setMessage(error.message || "Could not load room information. Please try again.", true);
    }
  };
  start();
})();
