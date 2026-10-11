"use strict";

(() => {
  const content = document.getElementById("availability-content");
  const updatedAt = document.getElementById("updated-at");
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
  const formatMoney = (value) => new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
  }).format(Number(value) || 0);
  const showMessage = (message, isError = false) => {
    content.innerHTML = `<section class="availability-message${isError ? " error" : ""}" role="${isError ? "alert" : "status"}">${escapeHtml(message)}</section>`;
  };
  const coolingLabel = (cooling) => ({
    ac: "Air conditioning",
    fan: "Fan",
    none: "No AC or fan"
  })[cooling] || "Room type not listed";

  const renderListing = (listing) => {
    if (!Array.isArray(listing.buildings)) {
      throw new Error("This availability link has invalid listing data.");
    }
    const availableBuildings = listing.buildings.filter((building) =>
      typeof building.name === "string" && Array.isArray(building.rooms) && building.rooms.length
    );
    if (!availableBuildings.length) {
      showMessage("There are no monthly rooms listed as available right now. Please contact the property owner to check upcoming availability.");
    } else {
      content.innerHTML = availableBuildings.map((building) => `<section class="availability-building">
        <h2>${escapeHtml(building.name)}</h2>
        <div class="availability-room-list">${building.rooms.map((room) => `<article class="availability-room">
          <div class="room-topline"><h3>Room ${escapeHtml(room.number)}</h3><span class="available-badge">Available now</span></div>
          <div class="room-facts"><span class="room-fact">Floor ${escapeHtml(room.floor || "Not listed")}</span><span class="room-fact">${escapeHtml(coolingLabel(room.cooling))}</span></div>
          <div class="room-price">${formatMoney(room.rent)} THB <small>/ month</small></div>
        </article>`).join("")}</div>
      </section>`).join("");
    }

    const updatedDate = new Date(listing.updated_at);
    if (!Number.isNaN(updatedDate.getTime())) {
      updatedAt.textContent = `Last updated ${new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
      }).format(updatedDate)}`;
    }
  };

  const loadListing = async () => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      showMessage("This availability link is incomplete or invalid.", true);
      return;
    }

    const config = window.HAVEN_SUPABASE_CONFIG;
    if (!config?.url || !config?.publishableKey || !window.supabase?.createClient) {
      showMessage("Availability could not be loaded. Please check your connection and try again.", true);
      return;
    }

    try {
      const client = window.supabase.createClient(config.url, config.publishableKey);
      const { data, error } = await client.rpc("get_haven_public_availability", {
        p_share_token: token
      });
      if (error) throw error;
      if (!data) {
        showMessage("This availability link is no longer active. Please ask the property owner for an updated link.", true);
        return;
      }
      renderListing(data);
    } catch (error) {
      console.error("Haven could not load public availability:", error);
      showMessage("Availability could not be loaded. Please ask the property owner to update the link.", true);
    }
  };

  loadListing();
})();
