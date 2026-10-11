(() => {
  "use strict";

  const STORAGE_KEY = "haven-apartment-manager-v1";
  const CLOUD_CACHE_KEY = "haven-apartment-manager-cloud-cache-v1";
  const EMPTY_DATA = () => ({ buildings: [], tenants: [], dailyBookings: [] });
  const nationalityOptions = [
    "Afghan", "Albanian", "Algerian", "American", "Australian", "Bangladeshi", "Brazilian",
    "British", "Cambodian", "Canadian", "Chinese", "Colombian", "Dutch", "Egyptian",
    "Filipino", "French", "German", "Indian", "Indonesian", "Iranian", "Iraqi", "Irish",
    "Italian", "Japanese", "Kenyan", "Korean", "Malaysian", "Mexican", "Myanmar", "Nepalese",
    "Nigerian", "Pakistani", "Russian", "Saudi", "Singaporean", "South African",
    "Spanish", "Sri Lankan", "Thai", "Turkish", "Ukrainian", "Vietnamese", "Other"
  ];
  const renderNationalityOptions = () => nationalityOptions.map((nationality) => `<option value="${escapeHtml(nationality)}">${escapeHtml(nationality)}</option>`).join("");
  const extraRentalOptions = [
    { id: "refrigerator", label: "Refrigerator", price: 500 },
    { id: "carPark", label: "Car park", price: 800 },
    { id: "motorcycle", label: "Motorcycle", price: 500 },
    { id: "bedding", label: "Bedding", price: 500 }
  ];
  const avatarColors = [
    ["#e8f1eb", "#3d7656"], ["#f4ece5", "#9a6944"], ["#e8edf5", "#546d93"],
    ["#f2eaf2", "#89638b"], ["#f5eee0", "#98733b"], ["#e4f0ef", "#397a73"]
  ];

  const dateAtOffset = (offset) => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return localDateValue(date);
  };
  const localDateValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const dateAtMonthOffset = (offset) => {
    const date = new Date();
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + offset);
    date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
    return localDateValue(date);
  };
  const normalizeData = (parsed) => {
    if (!parsed || !Array.isArray(parsed.buildings) || !Array.isArray(parsed.tenants)) {
      throw new Error("Saved records are not in the expected format.");
    }
    if (parsed.dailyBookings === undefined) parsed.dailyBookings = [];
    if (!Array.isArray(parsed.dailyBookings)) {
      throw new Error("Saved daily bookings are not in the expected format.");
    }
    return parsed;
  };
  const loadData = () => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === null ? EMPTY_DATA() : normalizeData(JSON.parse(saved));
  };

  let data;
  let cloudClient = null;
  let activeCloudUser = null;
  let activeCloudUserId = null;
  let pendingCloudUser = null;
  let pendingImportData = null;
  let cloudSyncTimer = null;
  let cloudSyncQueue = Promise.resolve();
  let currentView = "overview";
  let tenantQuery = "";
  let buildingFilter = "all";
  let historyQuery = "";
  let historyBuildingFilter = "all";
  let dailyViewMonth = localDateValue(new Date()).slice(0, 7);

  const appContent = document.getElementById("app-content");
  const modalRoot = document.getElementById("modal-root");
  const cloudRoot = document.getElementById("cloud-root");
  const toastRegion = document.getElementById("toast-region");
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const makeId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const formatDate = (dateString, options = { day: "numeric", month: "short", year: "numeric" }) => {
    if (!dateString) return "—";
    const date = new Date(`${dateString}T00:00:00`);
    return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, options).format(date);
  };
  const ageFromDateOfBirth = (dateOfBirth) => {
    if (!dateOfBirth) return null;
    const birthDate = new Date(`${dateOfBirth}T00:00:00`);
    const today = new Date();
    if (Number.isNaN(birthDate.getTime()) || birthDate > new Date(`${localDateValue(today)}T00:00:00`)) return null;
    let age = today.getFullYear() - birthDate.getFullYear();
    if (today.getMonth() < birthDate.getMonth()
      || (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate())) age -= 1;
    return age;
  };
  const formatMoney = (amount) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(amount) || 0);
  const parseMoney = (value, integerOnly = false) => {
    const text = String(value ?? "").trim();
    const pattern = integerOnly
      ? /^(?:\d+|\d{1,3}(?:,\d{3})+)$/
      : /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{0,2})?$/;
    if (!pattern.test(text)) return NaN;
    return Number(text.replace(/,/g, ""));
  };
  const getBuilding = (buildingId) => data.buildings.find((building) => building.id === buildingId);
  const getUnit = (buildingId, unitId) => getBuilding(buildingId)?.units.find((unit) => unit.id === unitId);
  const isDailyRoomConfigured = (unit) => unit.dailyRate !== undefined && unit.dailyRate !== null && unit.dailyRate !== ""
    && Number.isFinite(Number(unit.dailyRate)) && ["king", "double"].includes(unit.bedType);
  const datesOverlap = (startA, endA, startB, endB) => startA < endB && startB < endA;
  const getDailyBookingAmount = (booking) => Number(booking.nightlyRate) * Math.max(0, Math.round((new Date(`${booking.checkOut}T00:00:00`) - new Date(`${booking.checkIn}T00:00:00`)) / 86400000));
  const countNightsInMonth = (checkIn, checkOut, month) => {
    const monthStart = `${month}-01`;
    const monthEndDate = new Date(`${monthStart}T00:00:00`);
    monthEndDate.setMonth(monthEndDate.getMonth() + 1);
    const monthEnd = localDateValue(monthEndDate);
    const start = checkIn > monthStart ? checkIn : monthStart;
    const end = checkOut < monthEnd ? checkOut : monthEnd;
    return start < end ? Math.round((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86400000) : 0;
  };
  const dailyBookingConflicts = (unitId, checkIn, checkOut, exceptBookingId = "") => ({
    monthlyConflict: data.tenants.some((tenant) => tenant.status === "current" && tenant.unitId === unitId
      && datesOverlap(checkIn, checkOut, tenant.startDate, tenant.endDate)),
    dailyConflict: data.dailyBookings.some((booking) => booking.status !== "cancelled" && booking.id !== exceptBookingId
      && booking.unitId === unitId && datesOverlap(checkIn, checkOut, booking.checkIn, booking.checkOut))
  });
  const getCurrentTenant = (unitId) => data.tenants.find((tenant) => tenant.unitId === unitId && tenant.status === "current");
  const getOccupancy = (building) => {
    const occupied = building.units.filter((unit) => getCurrentTenant(unit.id)).length;
    return { occupied, total: building.units.length };
  };
  const getMonthlyRevenue = (building) => ({
    current: building.units.reduce((total, unit) => total + (getCurrentTenant(unit.id)?.rent ?? 0), 0),
    potential: building.units.reduce((total, unit) => total + (Number(unit.rent) || 0), 0)
  });
  const getExtraRentalAmount = (tenant, extraId) => Number(tenant.extraRentals?.[extraId]) || 0;
  const getTenantExtrasTotal = (tenant) => extraRentalOptions.reduce((total, extra) => total + getExtraRentalAmount(tenant, extra.id), 0);
  const renderExtraRentalOptions = (selected = {}) => extraRentalOptions.map((extra) =>
    `<label class="extra-rental-option"><input type="checkbox" name="extra-${escapeHtml(extra.id)}" data-extra-id="${escapeHtml(extra.id)}" ${getExtraRentalAmount({ extraRentals: selected }, extra.id) > 0 ? "checked" : ""}><span><strong>${escapeHtml(extra.label)}</strong><small>${formatMoney(extra.price)} THB / month</small></span></label>`
  ).join("");
  const readSelectedExtraRentals = (form) => Object.fromEntries(extraRentalOptions.map((extra) => [
    extra.id, form.querySelector(`[data-extra-id="${extra.id}"]`).checked ? extra.price : 0
  ]));
  const coolingLabel = (cooling) => ({
    ac: "Air conditioning", fan: "Fan", none: "No AC or fan"
  })[cooling] || "Not set";
  const isExpiringSoon = (tenant) => {
    if (tenant.status !== "current" || !tenant.endDate) return false;
    const days = Math.ceil((new Date(`${tenant.endDate}T23:59:59`) - new Date()) / 86400000);
    return days >= 0 && days <= 30;
  };
  const daysUntil = (dateString) => Math.ceil((new Date(`${dateString}T23:59:59`) - new Date()) / 86400000);
  const avatar = (name, extraClass = "") => {
    const initials = String(name || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    const index = Math.abs(String(name || "").split("").reduce((sum, char) => sum + char.charCodeAt(0), 0)) % avatarColors.length;
    const [background, color] = avatarColors[index];
    return `<span class="avatar tenant-avatar ${extraClass}" style="background:${background};color:${color}" aria-hidden="true">${escapeHtml(initials)}</span>`;
  };
  const saveData = () => {
    try {
      localStorage.setItem(activeCloudUserId ? CLOUD_CACHE_KEY : STORAGE_KEY, JSON.stringify(data));
      if (activeCloudUserId) scheduleCloudSync();
      return true;
    } catch (error) {
      showToast(`Could not save your changes. ${error.message}`, true);
      return false;
    }
  };
  const showToast = (message, isError = false) => {
    const toast = document.createElement("div");
    toast.className = `toast${isError ? " error" : ""}`;
    toast.setAttribute("role", isError ? "alert" : "status");
    toast.textContent = message;
    toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), 4200);
  };
  const setCloudStatus = (message, state = "") => {
    const status = document.getElementById("cloud-status");
    const dot = document.getElementById("cloud-status-dot");
    const button = document.getElementById("cloud-account-button");
    const shareButton = document.getElementById("share-availability-button");
    status.textContent = message;
    dot.className = `secure-dot${state ? ` ${state}` : ""}`;
    button.textContent = activeCloudUserId ? "Cloud account" : "Connect cloud";
    shareButton.hidden = !activeCloudUserId;
  };
  const renderAvailabilityShareDialog = (shareUrl, roomCount, buildingCount) => {
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-header"><div><h2 id="modal-title">Client availability link</h2><p>Share this page with clients or add the link to your Grok bot’s reply instructions.</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header>
      <div class="confirm-copy"><p><strong>${roomCount} rooms</strong> across <strong>${buildingCount} buildings</strong> are in this published snapshot.</p><p>The link shows building names, room numbers, floors, room type, and monthly rent only. It does not show addresses, tenant details, bookings, or account access.</p><p>To refresh availability after changing room or tenant records, click <strong>Share availability</strong> again. The same link will show the newest snapshot and its update time.</p>
      <label class="form-field">Client link<input id="availability-share-url" type="text" readonly value="${escapeHtml(shareUrl)}" aria-label="Client availability share link"></label></div>
      <footer class="confirm-footer"><button class="danger-button" data-action="confirm-stop-sharing">Stop sharing</button><button class="secondary-button" data-action="close-modal">Close</button><button class="primary-button" data-action="copy-availability-link">Copy link</button></footer>
    </section></div>`;
    document.getElementById("availability-share-url").addEventListener("focus", (event) => event.target.select());
  };
  const publishAvailability = async () => {
    if (!cloudClient || !activeCloudUserId) {
      showToast("Sign in to your Haven cloud account before creating a client link.", true);
      return;
    }

    const button = document.getElementById("share-availability-button");
    button.disabled = true;
    button.textContent = "Updating link…";
    try {
      const today = dateAtOffset(0);
      const tomorrow = dateAtOffset(1);
      const buildings = data.buildings.map((building) => ({
        name: building.name,
        rooms: building.units
          .filter((unit) => !getCurrentTenant(unit.id)
            && !data.dailyBookings.some((booking) => booking.status !== "cancelled"
              && booking.unitId === unit.id
              && datesOverlap(today, tomorrow, booking.checkIn, booking.checkOut)))
          .map((unit) => ({
            number: unit.number,
            floor: unit.floor || "",
            rent: Number(unit.rent) || 0,
            cooling: unit.cooling
          }))
      })).filter((building) => building.rooms.length > 0);

      const { data: existingShare, error: lookupError } = await cloudClient
        .from("haven_public_availability")
        .select("share_token")
        .eq("user_id", activeCloudUserId)
        .maybeSingle();
      if (lookupError) throw lookupError;
      const shareToken = existingShare?.share_token || crypto.randomUUID();
      const { error: publishError } = await cloudClient.from("haven_public_availability").upsert({
        user_id: activeCloudUserId,
        share_token: shareToken,
        listing_data: buildings,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id" });
      if (publishError) throw publishError;

      const shareUrl = new URL("availability.html", new URL("./", window.location.href));
      shareUrl.searchParams.set("token", shareToken);
      const roomCount = buildings.reduce((total, building) => total + building.rooms.length, 0);
      renderAvailabilityShareDialog(shareUrl.href, roomCount, buildings.length);
    } catch (error) {
      console.error("Haven could not publish client availability:", error);
      modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title">
        <header class="modal-header"><div><h2 id="modal-title">Could not update the client link</h2><p>Your private Haven workspace was not changed.</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header>
        <div class="confirm-copy"><p>${escapeHtml(error.message)}</p><p>Check that the latest <strong>supabase-setup.sql</strong> setup has been run in your Supabase project, then try again.</p></div>
        <footer class="confirm-footer"><button class="secondary-button" data-action="close-modal">Close</button></footer>
      </section></div>`;
      showToast("The public availability link was not updated.", true);
    } finally {
      button.disabled = false;
      button.textContent = "Share availability";
    }
  };
  const stopSharingAvailability = async () => {
    if (!cloudClient || !activeCloudUserId) return;
    try {
      const { error } = await cloudClient.from("haven_public_availability").delete().eq("user_id", activeCloudUserId);
      if (error) throw error;
      closeModal();
      showToast("The public availability link has been turned off.");
    } catch (error) {
      console.error("Haven could not turn off public availability:", error);
      showToast(`Could not turn off the public link. ${error.message}`, true);
    }
  };
  const copyAvailabilityLink = async () => {
    const input = document.getElementById("availability-share-url");
    if (!input) return;
    try {
      await navigator.clipboard.writeText(input.value);
      closeModal();
      showToast("Client availability link copied.");
    } catch (error) {
      console.error("Haven could not copy the public availability link:", error);
      input.focus();
      input.select();
      showToast("The link is selected. Copy it with Ctrl+C.", true);
    }
  };
  const recordCounts = (records) => ({
    buildings: records.buildings.length,
    tenants: records.tenants.length,
    bookings: records.dailyBookings.length
  });
  const countDescription = (records) => {
    const counts = recordCounts(records);
    return `${counts.buildings} building${counts.buildings === 1 ? "" : "s"}, ${counts.tenants} tenant record${counts.tenants === 1 ? "" : "s"}, and ${counts.bookings} daily booking${counts.bookings === 1 ? "" : "s"}`;
  };
  const closeCloudPanel = () => {
    cloudRoot.hidden = true;
    cloudRoot.innerHTML = "";
    pendingImportData = null;
  };
  const cloudCard = (title, description, content) => {
    cloudRoot.innerHTML = `<section class="cloud-screen"><div class="cloud-card" role="dialog" aria-modal="true" aria-labelledby="cloud-title"><h2 id="cloud-title">${title}</h2><p>${description}</p>${content}</div></section>`;
    cloudRoot.hidden = false;
  };
  const renderCloudAuthForm = (mode = "signin", message = "", isError = false) => {
    const isSignup = mode === "signup";
    const supportedOrigin = ["http:", "https:"].includes(window.location.protocol);
    const unavailableMessage = !supportedOrigin
      ? "Cloud sign-in needs a website address (http or https). Open Haven from its hosted site or a local web server; file:// pages cannot sign in."
      : !window.supabase
        ? "The sign-in service did not load. Check your internet connection and reload Haven."
        : "";
    const form = supportedOrigin && window.supabase
      ? `<form class="cloud-form" id="cloud-auth-form">
          <label>Email address<input name="email" type="email" autocomplete="email" required></label>
          <label>Password<input name="password" type="password" minlength="6" autocomplete="${isSignup ? "new-password" : "current-password"}" required></label>
          <div class="cloud-actions"><button class="primary-button" type="submit" data-cloud-action="${isSignup ? "signup" : "signin"}">${isSignup ? "Create account" : "Sign in"}</button><button class="secondary-button" type="button" data-cloud-action="${isSignup ? "show-signin" : "show-signup"}">${isSignup ? "I already have an account" : "Create a new account"}</button></div>
        </form>`
      : "";
    const backupButton = `<button class="secondary-button" type="button" data-cloud-action="download-backup">Download this device's backup</button>`;
    const error = isError ? " error" : "";
    cloudCard(
      isSignup ? "Create your Haven account" : "Connect Haven to the cloud",
      "Use the same account on each of your devices. Your cloud workspace is private to your account.",
      `${unavailableMessage ? `<p class="cloud-message error">${escapeHtml(unavailableMessage)}</p>` : ""}
       ${form}
       ${message ? `<p class="cloud-message${error}">${escapeHtml(message)}</p>` : ""}
       <div class="cloud-actions">${backupButton}<button class="text-button" type="button" data-cloud-action="close">Continue on this device</button></div>
       <p class="cloud-footnote">Your device records will not be uploaded unless you choose to import them. Never share your password or a secret service key.</p>`
    );
  };
  const renderCloudWorkspaceChoice = (user, message = "", isError = false) => {
    const localRecords = (() => {
      try { return loadData(); } catch { return EMPTY_DATA(); }
    })();
    const error = isError ? " error" : "";
    cloudCard(
      "Choose your Haven workspace",
      `Signed in as ${escapeHtml(user.email || "your account")}. Choose how to create this account's cloud workspace. Your current device records will be kept unchanged unless you choose to copy them.`,
      `<div class="cloud-counts">On this device: ${escapeHtml(countDescription(localRecords))}</div>
       ${message ? `<p class="cloud-message${error}">${escapeHtml(message)}</p>` : ""}
       <div class="cloud-workspace-choice">
         <button class="primary-button" type="button" data-cloud-action="import-current">Copy this device's records to cloud</button>
         <button class="secondary-button" type="button" data-cloud-action="start-empty">Start an empty cloud workspace</button>
       </div>
       <label class="cloud-form cloud-backup-upload">Or choose a Haven backup file<input class="cloud-file-input" id="cloud-backup-file" type="file" accept="application/json,.json"></label>
       ${pendingImportData ? `<div class="cloud-counts">Backup selected: ${escapeHtml(countDescription(pendingImportData))}<div class="cloud-actions"><button class="primary-button" type="button" data-cloud-action="import-backup">Import this backup</button><button class="text-button" type="button" data-cloud-action="cancel-backup">Cancel</button></div></div>` : ""}
       <div class="cloud-actions"><button class="secondary-button" type="button" data-cloud-action="download-backup">Download this device's backup</button><button class="text-button" type="button" data-cloud-action="signout">Cancel and sign out</button></div>`
    );
  };
  const renderCloudBackupConfirmation = (records) => {
    cloudCard(
      "Replace cloud records with this backup?",
      "This import will replace the records in your cloud workspace with the selected backup. The copy saved on this device will not be changed.",
      `<div class="cloud-counts">Backup contains: ${escapeHtml(countDescription(records))}</div>
       <div class="cloud-actions"><button class="primary-button" type="button" data-cloud-action="replace-cloud-backup">Replace cloud records</button><button class="secondary-button" type="button" data-cloud-action="cancel-backup">Cancel</button></div>`
    );
  };
  const downloadBackup = () => {
    const backup = { format: "haven-apartment-manager", version: 1, data };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `haven-backup-${localDateValue(new Date())}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const parseBackup = (text) => {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.format !== "haven-apartment-manager" || parsed.version !== 1) {
      throw new Error("That file is not a supported Haven backup.");
    }
    return normalizeData(parsed.data);
  };
  const writeCloudWorkspace = async (user, workspaceData) => {
    const payload = {
      user_id: user.id,
      workspace_data: workspaceData,
      updated_at: new Date().toISOString()
    };
    const { error } = await cloudClient.from("haven_workspaces").upsert(payload, { onConflict: "user_id" });
    if (error) throw error;
    activeCloudUser = user;
    activeCloudUserId = user.id;
    pendingCloudUser = null;
    data = normalizeData(workspaceData);
    try {
      localStorage.setItem(CLOUD_CACHE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error("Haven could not cache the cloud workspace on this device:", error);
      showToast("Cloud records were saved, but this device could not keep a local cache.", true);
    }
    closeCloudPanel();
    render();
    setCloudStatus("Cloud synced");
  };
  const loadCloudWorkspace = async (user) => {
    if (!cloudClient || !user) return;
    pendingCloudUser = user;
    activeCloudUser = user;
    activeCloudUserId = null;
    setCloudStatus("Checking cloud…", "syncing");
    try {
      const { data: row, error } = await cloudClient
        .from("haven_workspaces")
        .select("workspace_data")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;
      if (!row) {
        renderCloudWorkspaceChoice(user);
        return;
      }
      data = normalizeData(row.workspace_data);
      activeCloudUserId = user.id;
      pendingCloudUser = null;
      try {
        localStorage.setItem(CLOUD_CACHE_KEY, JSON.stringify(data));
      } catch (error) {
        console.error("Haven could not cache the cloud workspace on this device:", error);
      }
      closeCloudPanel();
      render();
      setCloudStatus("Cloud synced");
    } catch (error) {
      console.error("Haven could not load the cloud workspace:", error);
      renderCloudAuthForm("signin", `Could not open your cloud workspace: ${error.message}. Check that the Haven database setup has been run, then try again.`, true);
      activeCloudUser = null;
      activeCloudUserId = null;
      pendingCloudUser = null;
      setCloudStatus("Cloud setup needed", "sync-error");
    }
  };
  const scheduleCloudSync = () => {
    if (!activeCloudUserId || !cloudClient) return;
    window.clearTimeout(cloudSyncTimer);
    setCloudStatus("Saving to cloud…", "syncing");
    cloudSyncTimer = window.setTimeout(() => {
      const ownerId = activeCloudUserId;
      const snapshot = JSON.parse(JSON.stringify(data));
      cloudSyncQueue = cloudSyncQueue.catch(() => {}).then(async () => {
        if (ownerId !== activeCloudUserId) return;
        const { error } = await cloudClient.from("haven_workspaces").upsert({
          user_id: ownerId,
          workspace_data: snapshot,
          updated_at: new Date().toISOString()
        }, { onConflict: "user_id" });
        if (error) throw error;
        if (ownerId === activeCloudUserId) setCloudStatus("Cloud synced");
      }).catch((error) => {
        console.error("Haven cloud sync failed:", error);
        if (ownerId === activeCloudUserId) {
          setCloudStatus("Cloud sync failed", "sync-error");
          showToast(`Your device copy is saved, but cloud sync failed. ${error.message}`, true);
        }
      });
    }, 500);
  };
  const initializeCloud = async () => {
    const config = window.HAVEN_SUPABASE_CONFIG;
    if (!config?.url || !config?.publishableKey || !["http:", "https:"].includes(window.location.protocol)) {
      setCloudStatus("Saved on this device");
      return;
    }
    if (!window.supabase?.createClient) {
      setCloudStatus("Cloud unavailable", "sync-error");
      return;
    }
    cloudClient = window.supabase.createClient(config.url, config.publishableKey);
    cloudClient.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        activeCloudUser = null;
        activeCloudUserId = null;
        pendingCloudUser = null;
        try {
          data = loadData();
          render();
        } catch (error) {
          console.error("Haven could not restore this device's records after sign-out:", error);
          showToast("You signed out, but local records could not be loaded.", true);
        }
        closeCloudPanel();
        setCloudStatus("Saved on this device");
      }
    });
    try {
      const { data: sessionData, error } = await cloudClient.auth.getSession();
      if (error) throw error;
      if (sessionData.session?.user) await loadCloudWorkspace(sessionData.session.user);
    } catch (error) {
      console.error("Haven could not check the cloud sign-in:", error);
      setCloudStatus("Cloud sign-in unavailable", "sync-error");
    }
  };
  const handleCloudAction = async (action) => {
    if (action === "close") {
      closeCloudPanel();
      return;
    }
    if (action === "show-signup" || action === "show-signin") {
      renderCloudAuthForm(action === "show-signup" ? "signup" : "signin");
      return;
    }
    if (action === "download-backup") {
      downloadBackup();
      return;
    }
    if (action === "cancel-backup") {
      pendingImportData = null;
      if (activeCloudUserId) {
        const user = activeCloudUser;
        cloudCard(
          "Haven cloud account",
          `Your records are stored in your private cloud workspace. Signed in as ${escapeHtml(user?.email || "your account")}.`,
          `<label class="cloud-form cloud-backup-upload">Import a Haven backup<input class="cloud-file-input" id="cloud-backup-file" type="file" accept="application/json,.json"></label>
           <div class="cloud-actions"><button class="secondary-button" type="button" data-cloud-action="download-backup">Download a backup</button><button class="danger-button" type="button" data-cloud-action="signout">Sign out and use this device</button><button class="text-button" type="button" data-cloud-action="close">Close</button></div>`
        );
      } else renderCloudWorkspaceChoice(pendingCloudUser);
      return;
    }
    if (action === "signout") {
      if (cloudClient) {
        const { error } = await cloudClient.auth.signOut();
        if (error) throw error;
      }
      return;
    }
    if (action === "import-current" || action === "start-empty" || action === "import-backup" || action === "replace-cloud-backup") {
      const user = pendingCloudUser || activeCloudUser;
      if (!user) throw new Error("Your sign-in session ended. Please connect again.");
      let workspaceData;
      if (action === "start-empty") workspaceData = EMPTY_DATA();
      else if (action === "import-backup" || action === "replace-cloud-backup") {
        if (!pendingImportData) throw new Error("Choose a Haven backup file first.");
        workspaceData = pendingImportData;
      } else workspaceData = loadData();
      try {
        await writeCloudWorkspace(user, workspaceData);
      } catch (error) {
        console.error("Haven could not create the cloud workspace:", error);
        renderCloudWorkspaceChoice(user, `Could not create the cloud workspace: ${error.message}. Your local records have not been changed.`, true);
      }
    }
  };
  document.getElementById("cloud-account-button").addEventListener("click", () => {
    if (activeCloudUserId) {
      pendingImportData = null;
      cloudCard(
        "Haven cloud account",
        `Your records are stored in your private cloud workspace. Signed in as ${escapeHtml(activeCloudUser?.email || "your account")}.`,
        `<label class="cloud-form cloud-backup-upload">Import a Haven backup<input class="cloud-file-input" id="cloud-backup-file" type="file" accept="application/json,.json"></label>
         <div class="cloud-actions"><button class="secondary-button" type="button" data-cloud-action="download-backup">Download a backup</button><button class="danger-button" type="button" data-cloud-action="signout">Sign out and use this device</button><button class="text-button" type="button" data-cloud-action="close">Close</button></div>`
      );
    } else if (pendingCloudUser) renderCloudWorkspaceChoice(pendingCloudUser);
    else renderCloudAuthForm();
  });
  cloudRoot.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-cloud-action]");
    if (!button || button.type === "submit") return;
    button.disabled = true;
    try {
      await handleCloudAction(button.dataset.cloudAction);
    } catch (error) {
      console.error("Haven cloud action failed:", error);
      if (pendingCloudUser) renderCloudWorkspaceChoice(pendingCloudUser, error.message, true);
      else renderCloudAuthForm("signin", error.message, true);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
  cloudRoot.addEventListener("change", async (event) => {
    if (event.target.id !== "cloud-backup-file" || !event.target.files?.[0]) return;
    try {
      pendingImportData = parseBackup(await event.target.files[0].text());
      if (activeCloudUserId) renderCloudBackupConfirmation(pendingImportData);
      else renderCloudWorkspaceChoice(pendingCloudUser);
    } catch (error) {
      console.error("Haven could not read the selected backup:", error);
      if (activeCloudUserId) {
        pendingImportData = null;
        cloudCard(
          "Haven cloud account",
          `Your records are stored in your private cloud workspace. Signed in as ${escapeHtml(activeCloudUser?.email || "your account")}.`,
          `<p class="cloud-message error">${escapeHtml(error.message)}</p>
           <label class="cloud-form cloud-backup-upload">Choose a valid Haven backup<input class="cloud-file-input" id="cloud-backup-file" type="file" accept="application/json,.json"></label>
           <div class="cloud-actions"><button class="text-button" type="button" data-cloud-action="close">Close</button></div>`
        );
      } else renderCloudWorkspaceChoice(pendingCloudUser, error.message, true);
    }
  });
  cloudRoot.addEventListener("submit", async (event) => {
    if (event.target.id !== "cloud-auth-form") return;
    event.preventDefault();
    const form = new FormData(event.target);
    const email = String(form.get("email")).trim();
    const password = String(form.get("password"));
    const action = event.submitter?.dataset.cloudAction || "signin";
    const submitButton = event.submitter;
    submitButton.disabled = true;
    try {
      if (action === "signup") {
        const { data: result, error } = await cloudClient.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` }
        });
        if (error) throw error;
        if (result.session?.user) await loadCloudWorkspace(result.session.user);
        else renderCloudAuthForm("signin", "Account created. Check your email for the confirmation link, then sign in here.");
      } else {
        const { data: result, error } = await cloudClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (result.user) await loadCloudWorkspace(result.user);
      }
    } catch (error) {
      console.error("Haven sign-in failed:", error);
      renderCloudAuthForm(action === "signup" ? "signup" : "signin", error.message, true);
    } finally {
      if (submitButton.isConnected) submitButton.disabled = false;
    }
  });

  const setHeader = (view) => {
    const names = { overview: "Overview", tenants: "Tenants", buildings: "Buildings", daily: "Daily rentals", history: "Past tenants" };
    document.getElementById("breadcrumb-current").textContent = names[view];
    document.getElementById("today-label").textContent = new Intl.DateTimeFormat(undefined, {
      weekday: "short", day: "numeric", month: "short", year: "numeric"
    }).format(new Date());
    document.getElementById("nav-tenant-count").textContent = data.tenants.filter((tenant) => tenant.status === "current").length;
    document.querySelectorAll(".nav-item").forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });
  };
  const pageHeading = (eyebrow, title, subtitle, buttonLabel, buttonAction = "add-tenant") => `
    <div class="page-heading">
      <div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="page-subtitle">${subtitle}</p></div>
      ${buttonLabel ? `<button class="primary-button" data-action="${buttonAction}"><span class="plus" aria-hidden="true">+</span>${buttonLabel}</button>` : ""}
    </div>`;

  const renderOverview = () => {
    if (!data.buildings.length) {
      return `${pageHeading("YOUR PROPERTY AT A GLANCE", "Welcome to Haven", "Keep your buildings, current tenants, and past rental records together.", "Add your first building", "add-building")}
        <section class="panel"><div class="empty-state"><div class="empty-icon" aria-hidden="true">⌂</div><h3>Let’s set up your first building</h3><p>Add a building and its rooms first. Then it’s easy to record who moves in, keep an eye on rental dates, and find past tenant records whenever you need them.</p><button class="primary-button" data-action="add-building"><span class="plus" aria-hidden="true">+</span>Add a building</button></div></section>`;
    }
    const current = data.tenants.filter((tenant) => tenant.status === "current");
    const past = data.tenants.filter((tenant) => tenant.status === "past");
    const allUnits = data.buildings.reduce((sum, building) => sum + building.units.length, 0);
    const occupied = data.buildings.reduce((sum, building) => sum + getOccupancy(building).occupied, 0);
    const monthlyIncome = current.reduce((sum, tenant) => sum + (Number(tenant.rent) || 0), 0);
    const monthlyExtraIncome = current.reduce((sum, tenant) => sum + getTenantExtrasTotal(tenant), 0);
    const expectedMonthlyIncome = monthlyIncome + monthlyExtraIncome;
    const potentialIncome = data.buildings.reduce((sum, building) => sum + getMonthlyRevenue(building).potential, 0);
    const dailyRoomIncome = (buildingId) => data.dailyBookings
      .filter((booking) => booking.status !== "cancelled" && (!buildingId || booking.buildingId === buildingId))
      .reduce((sum, booking) => sum + countNightsInMonth(booking.checkIn, booking.checkOut, dailyViewMonth) * Number(booking.nightlyRate), 0);
    const totalDailyIncome = dailyRoomIncome("");
    const extraIncomeByType = Object.fromEntries(extraRentalOptions.map((extra) => [
      extra.id, current.reduce((sum, tenant) => sum + getExtraRentalAmount(tenant, extra.id), 0)
    ]));
    const expiring = current.filter(isExpiringSoon).sort((a, b) => a.endDate.localeCompare(b.endDate));
    const recent = [...current].sort((a, b) => a.endDate.localeCompare(b.endDate)).slice(0, 4);
    const occupancyPercent = allUnits ? Math.round((occupied / allUnits) * 100) : 0;
    return `
      ${pageHeading("YOUR PROPERTY AT A GLANCE", `Good ${getGreeting()},`, "Here’s what’s happening across your properties today.", "Add a tenant")}
      <section class="stats-grid" aria-label="Property summary">
        <article class="stat-card"><div class="stat-top"><span class="stat-label">Current tenants</span><span class="stat-icon" aria-hidden="true">♙</span></div><div class="stat-value">${current.length}</div><span class="stat-note"><span class="positive">${data.buildings.length} properties</span> in your portfolio</span></article>
        <article class="stat-card"><div class="stat-top"><span class="stat-label">Rooms occupied</span><span class="stat-icon" aria-hidden="true">▥</span></div><div class="stat-value">${occupied}<span style="color:#9aa39e;font-size:16px;font-weight:500"> / ${allUnits}</span></div><span class="stat-note">${occupancyPercent}% of all your rooms</span></article>
        <article class="stat-card"><div class="stat-top"><span class="stat-label">Available rooms</span><span class="stat-icon" aria-hidden="true">⌂</span></div><div class="stat-value">${allUnits - occupied}</div><span class="stat-note">Ready for a new tenant</span></article>
        <article class="stat-card"><div class="stat-top"><span class="stat-label">Monthly room rent</span><span class="stat-icon" aria-hidden="true">¤</span></div><div class="stat-value">${formatMoney(monthlyIncome)}</div><span class="stat-note">Extras: ${formatMoney(monthlyExtraIncome)} THB · Potential rent: ${formatMoney(potentialIncome)}</span></article>
        <article class="stat-card"><div class="stat-top"><span class="stat-label">Leases ending soon</span><span class="stat-icon" style="color:#a6752d;background:#fbf3e3" aria-hidden="true">◷</span></div><div class="stat-value">${expiring.length}</div><span class="stat-note">${expiring.length ? "In the next 30 days" : "Nothing to follow up on"}</span></article>
      </section>
      <section class="dashboard-grid">
        <article class="panel">
          <div class="panel-header"><div><h2 class="panel-title">Current tenants</h2><p class="panel-caption">A quick look at who is living in your rooms</p></div><button class="text-button" data-view="tenants">See all <span aria-hidden="true">→</span></button></div>
          <div class="panel-body"><div class="tenant-list">${recent.length ? recent.map((tenant) => {
            const building = getBuilding(tenant.buildingId);
            const unit = getUnit(tenant.buildingId, tenant.unitId);
            return `<div class="tenant-list-item">${avatar(tenant.name)}<div class="tenant-brief"><strong>${escapeHtml(tenant.name)}</strong><span>${escapeHtml(tenant.nationality)} · ${escapeHtml(building?.name || "Unknown building")}</span></div><div class="tenant-detail"><strong>Unit ${escapeHtml(unit?.number || "—")}</strong><span>Until ${formatDate(tenant.endDate, { day: "numeric", month: "short" })}</span></div></div>`;
          }).join("") : `<div class="empty-small">No tenants yet. Add a tenant to get started.</div>`}</div></div>
        </article>
        <article class="panel expiry-panel">
          <div class="panel-header"><div><h2 class="panel-title">Coming up</h2><p class="panel-caption">Leases ending in the next 30 days</p></div><span class="status-pill ${expiring.length ? "soon" : ""}">${expiring.length} ${expiring.length === 1 ? "lease" : "leases"}</span></div>
          <div class="expiry-list">${expiring.length ? expiring.map((tenant) => {
            const unit = getUnit(tenant.buildingId, tenant.unitId);
            const left = daysUntil(tenant.endDate);
            return `<div class="expiry-item"><div class="expiry-date"><strong>${new Date(`${tenant.endDate}T00:00:00`).getDate()}</strong><span>${escapeHtml(new Intl.DateTimeFormat(undefined, { month: "short" }).format(new Date(`${tenant.endDate}T00:00:00`)))}</span></div><div class="expiry-info"><strong>${escapeHtml(tenant.name)}</strong><span>Unit ${escapeHtml(unit?.number || "—")} · ${left === 0 ? "Ends today" : left === 1 ? "1 day left" : `${left} days left`}</span></div></div>`;
          }).join("") : `<div class="empty-small">You’re all caught up.<br>No leases ending soon.</div>`}</div>
        </article>
      </section>
      <article class="panel occupancy-panel"><div class="occupancy-head"><strong>Portfolio occupancy</strong><span>${occupied} of ${allUnits} rooms occupied</span></div><div class="occupancy-bar" role="progressbar" aria-label="Portfolio occupancy" aria-valuenow="${occupancyPercent}" aria-valuemin="0" aria-valuemax="100"><div class="occupancy-fill" style="width:${occupancyPercent}%"></div></div><div class="occupancy-caption"><span>${occupancyPercent}% occupied</span><span>${data.buildings.length} buildings · ${past.length} past tenant records</span></div></article>
      <section class="panel income-overview">
        <div class="panel-header income-overview-header"><div><h2 class="panel-title">Monthly income by building</h2><p class="panel-caption">Room rent and selected extras from current tenants</p></div><div class="income-grand-total"><span>Total expected income</span><strong>${formatMoney(expectedMonthlyIncome)} THB</strong></div></div>
        <div class="table-scroll"><table class="income-table"><thead><tr><th>BUILDING</th><th>ROOMS OCCUPIED</th><th>ROOM RENT</th><th>EXTRAS</th><th>TOTAL / MONTH</th></tr></thead><tbody>${data.buildings.map((building) => {
          const buildingTenants = current.filter((tenant) => tenant.buildingId === building.id);
          const buildingOccupancy = getOccupancy(building);
          const roomRent = buildingTenants.reduce((sum, tenant) => sum + (Number(tenant.rent) || 0), 0);
          const extras = buildingTenants.reduce((sum, tenant) => sum + getTenantExtrasTotal(tenant), 0);
          return `<tr><th scope="row">${escapeHtml(building.name)}</th><td>${buildingOccupancy.occupied} / ${buildingOccupancy.total}</td><td>${formatMoney(roomRent)} THB</td><td>${formatMoney(extras)} THB</td><td><strong>${formatMoney(roomRent + extras)} THB</strong></td></tr>`;
        }).join("")}<tr class="income-total-row"><th scope="row">All buildings</th><td>${occupied} / ${allUnits}</td><td>${formatMoney(monthlyIncome)} THB</td><td>${formatMoney(monthlyExtraIncome)} THB</td><td><strong>${formatMoney(expectedMonthlyIncome)} THB</strong></td></tr></tbody></table></div>
        <div class="extra-income-breakdown"><div class="extra-income-heading"><strong>Monthly income from extras</strong><span>${formatMoney(monthlyExtraIncome)} THB total</span></div><div class="extra-income-grid">${extraRentalOptions.map((extra) => `<div class="extra-income-item"><span>${escapeHtml(extra.label)}</span><strong>${formatMoney(extraIncomeByType[extra.id])} THB</strong></div>`).join("")}</div></div>
      </section>
      <section class="panel income-overview daily-income-overview">
        <div class="panel-header income-overview-header"><div><h2 class="panel-title">Daily room income</h2><p class="panel-caption">Booked daily stays in ${escapeHtml(formatDate(`${dailyViewMonth}-01`, { month: "long", year: "numeric" }))}</p></div><div class="income-grand-total"><span>Expected daily income</span><strong>${formatMoney(totalDailyIncome)} THB</strong></div></div>
        <div class="table-scroll"><table class="income-table"><thead><tr><th>BUILDING</th><th>ROOM NIGHTS</th><th>DAILY ROOM INCOME</th></tr></thead><tbody>${data.buildings.map((building) => {
          const buildingBookings = data.dailyBookings.filter((booking) => booking.status !== "cancelled" && booking.buildingId === building.id);
          const nights = buildingBookings.reduce((sum, booking) => sum + countNightsInMonth(booking.checkIn, booking.checkOut, dailyViewMonth), 0);
          return `<tr><th scope="row">${escapeHtml(building.name)}</th><td>${nights}</td><td><strong>${formatMoney(dailyRoomIncome(building.id))} THB</strong></td></tr>`;
        }).join("")}<tr class="income-total-row"><th scope="row">All buildings</th><td>${data.dailyBookings.filter((booking) => booking.status !== "cancelled").reduce((sum, booking) => sum + countNightsInMonth(booking.checkIn, booking.checkOut, dailyViewMonth), 0)}</td><td><strong>${formatMoney(totalDailyIncome)} THB</strong></td></tr></tbody></table></div>
        <div class="income-footer"><span>Daily income is counted for nights within the selected month. Combined income across all rentals: <strong>${formatMoney(expectedMonthlyIncome + totalDailyIncome)} THB</strong>.</span><button class="secondary-button" data-view="daily">View daily rentals</button></div>
      </section>
    `;
  };
  function getGreeting() {
    const hour = new Date().getHours();
    return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  }

  const buildingOptions = (selected = "all") => [
    `<option value="all">All buildings</option>`,
    ...data.buildings.map((building) => `<option value="${escapeHtml(building.id)}" ${building.id === selected ? "selected" : ""}>${escapeHtml(building.name)}</option>`)
  ].join("");
  const termLength = (startDate, endDate) => {
    if (!startDate || !endDate) return "";
    const start = new Date(`${startDate}T00:00:00`);
    const endExclusive = new Date(`${endDate}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime()) || endExclusive < start) return "";
    const addMonths = (date, count) => {
      const result = new Date(date);
      const originalDay = date.getDate();
      result.setDate(1);
      result.setMonth(result.getMonth() + count);
      result.setDate(Math.min(originalDay, new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()));
      return result;
    };
    let months = (endExclusive.getFullYear() - start.getFullYear()) * 12 + endExclusive.getMonth() - start.getMonth();
    while (months > 0 && addMonths(start, months) > endExclusive) months -= 1;
    while (addMonths(start, months + 1) <= endExclusive) months += 1;
    const days = Math.max(0, Math.round((endExclusive - addMonths(start, months)) / 86400000));
    if (!months) return `${Math.max(1, days)} ${days === 1 ? "day" : "days"}`;
    const years = Math.floor(months / 12);
    const remainder = months % 12;
    return [
      years ? `${years} ${years === 1 ? "year" : "years"}` : "",
      remainder ? `${remainder} ${remainder === 1 ? "month" : "months"}` : "",
      days ? `${days} ${days === 1 ? "day" : "days"}` : ""
    ].filter(Boolean).join(" ");
  };
  const tenantStatus = (tenant) => {
    if (tenant.status === "past") return `<span class="status-pill past">Past tenant</span>`;
    if (isExpiringSoon(tenant)) {
      const days = daysUntil(tenant.endDate);
      return `<span class="status-pill soon">${days === 0 ? "Ends today" : `${days} ${days === 1 ? "day" : "days"} left`}</span>`;
    }
    return `<span class="status-pill">Current</span>`;
  };
  const tenantTableRows = (tenants, isHistory = false) => tenants.map((tenant) => {
    const building = getBuilding(tenant.buildingId);
    const unit = getUnit(tenant.buildingId, tenant.unitId);
    const endLabel = isHistory
      ? formatDate(tenant.endedDate || tenant.endDate)
      : formatDate(tenant.endDate, { day: "numeric", month: "short", year: "numeric" });
    return `<tr>
      <td><div class="table-person">${avatar(tenant.name)}<div><strong>${escapeHtml(tenant.name)}</strong><span>${escapeHtml(tenant.email || tenant.phone || "No contact details")}</span></div></div></td>
      <td class="nationality-cell">${escapeHtml(tenant.nationality || "—")}${tenant.dateOfBirth ? `<span>Age ${ageFromDateOfBirth(tenant.dateOfBirth) ?? "—"} · DOB ${formatDate(tenant.dateOfBirth)}</span>` : ""}${tenant.passportNumber ? `<span>Passport: ${escapeHtml(tenant.passportNumber)}</span>` : ""}</td>
      <td><div class="building-cell"><strong>${escapeHtml(building?.name || "Building removed")}</strong><span>Room ${escapeHtml(unit?.number || "—")}</span></div></td>
      <td>${formatDate(tenant.startDate)}</td><td>${endLabel}</td>
      <td>${tenantStatus(tenant)}</td>
      <td class="table-actions">${isHistory ? `<button class="text-button" data-action="view-tenant" data-tenant="${escapeHtml(tenant.id)}">View record</button>` : `<div class="row-actions"><button class="text-button" data-action="edit-tenant-stay" data-tenant="${escapeHtml(tenant.id)}">Edit stay</button><button class="text-button" data-action="edit-tenant-extras" data-tenant="${escapeHtml(tenant.id)}">Monthly extras</button><button class="more-button" aria-label="End lease for ${escapeHtml(tenant.name)}" title="End lease" data-action="end-lease" data-tenant="${escapeHtml(tenant.id)}">···</button></div>`}</td>
    </tr>`;
  }).join("");
  const pieChartPanel = (title, caption, values, emptyMessage) => {
    const total = values.reduce((sum, item) => sum + item.count, 0);
    const segments = values.filter((item) => item.count > 0);
    let angle = -90;
    const colors = ["#246b54", "#d09a45", "#6484a0", "#9a6d92", "#58a5a0", "#bd6b52", "#81934e", "#8874b5", "#cb788f", "#737d84", "#c1ae76", "#5281a0"];
    const slices = segments.map((item, index) => {
      const start = angle;
      const sweep = item.count / total * 360;
      angle += sweep;
      const color = colors[index % colors.length];
      if (sweep >= 359.999) return `<circle cx="100" cy="100" r="90" fill="${color}"><title>${escapeHtml(item.label)}: ${item.count} (100%)</title></circle>`;
      const point = (degrees) => {
        const radians = degrees * Math.PI / 180;
        return [100 + 90 * Math.cos(radians), 100 + 90 * Math.sin(radians)];
      };
      const [startX, startY] = point(start);
      const [endX, endY] = point(angle);
      const largeArc = sweep > 180 ? 1 : 0;
      return `<path d="M 100 100 L ${startX.toFixed(3)} ${startY.toFixed(3)} A 90 90 0 ${largeArc} 1 ${endX.toFixed(3)} ${endY.toFixed(3)} Z" fill="${color}"><title>${escapeHtml(item.label)}: ${item.count} (${(item.count / total * 100).toFixed(1)}%)</title></path>`;
    }).join("");
    const legend = segments.map((item, index) => `<li><span class="pie-legend-color" style="--pie-color:${colors[index % colors.length]}" aria-hidden="true"></span><span class="pie-legend-label">${escapeHtml(item.label)}</span><strong>${(item.count / total * 100).toFixed(1)}%</strong><span class="pie-legend-count">${item.count}</span></li>`).join("");
    return `<article class="panel tenant-chart-card"><div class="tenant-chart-heading"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(caption)}</p></div>${total ? `<div class="tenant-chart-content"><svg class="tenant-pie-chart" viewBox="0 0 200 200" role="img" aria-label="${escapeHtml(title)} for ${total} current tenants">${slices}</svg><ul class="pie-legend">${legend}</ul></div>` : `<p class="tenant-chart-empty">${escapeHtml(emptyMessage)}</p>`}</article>`;
  };
  const renderTenants = () => {
    const allCurrentTenants = data.tenants.filter((tenant) => tenant.status === "current");
    const nationalityCounts = new Map();
    allCurrentTenants.forEach((tenant) => {
      const nationality = String(tenant.nationality || "Not recorded").trim() || "Not recorded";
      nationalityCounts.set(nationality, (nationalityCounts.get(nationality) || 0) + 1);
    });
    const ageGroups = [
      { label: "Under 18", matches: (age) => age < 18 },
      { label: "18–29", matches: (age) => age >= 18 && age <= 29 },
      { label: "30–39", matches: (age) => age >= 30 && age <= 39 },
      { label: "40–49", matches: (age) => age >= 40 && age <= 49 },
      { label: "50–59", matches: (age) => age >= 50 && age <= 59 },
      { label: "60+", matches: (age) => age >= 60 }
    ];
    const ageCounts = ageGroups.map(({ label, matches }) => ({
      label,
      count: allCurrentTenants.filter((tenant) => {
        const age = ageFromDateOfBirth(tenant.dateOfBirth);
        return age !== null && matches(age);
      }).length
    }));
    ageCounts.push({
      label: "Date of birth not recorded",
      count: allCurrentTenants.filter((tenant) => ageFromDateOfBirth(tenant.dateOfBirth) === null).length
    });
    const nationalityData = [...nationalityCounts.entries()].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const tenants = allCurrentTenants
      .filter((tenant) => buildingFilter === "all" || tenant.buildingId === buildingFilter)
      .filter((tenant) => `${tenant.name} ${tenant.nationality} ${tenant.email} ${tenant.phone} ${getBuilding(tenant.buildingId)?.name || ""}`.toLowerCase().includes(tenantQuery.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    return `${pageHeading("PEOPLE", "Current tenants", "Keep track of who is living in each apartment.", "Add a tenant")}
      <section class="tenant-demographics" aria-label="Current tenant demographics across all buildings">
        ${pieChartPanel("Nationality", `All buildings · ${allCurrentTenants.length} current ${allCurrentTenants.length === 1 ? "tenant" : "tenants"}`, nationalityData, "No current tenants to summarize.")}
        ${pieChartPanel("Age group", `All buildings · ${allCurrentTenants.length} current ${allCurrentTenants.length === 1 ? "tenant" : "tenants"}`, ageCounts, "No current tenants to summarize.")}
      </section>
      <div class="toolbar"><div class="toolbar-left"><label class="search-wrap"><span class="search-icon" aria-hidden="true">⌕</span><input class="search-input" type="search" placeholder="Search by name, nationality or building" aria-label="Search current tenants" value="${escapeHtml(tenantQuery)}" data-input="tenant-search"></label><select class="filter-select" aria-label="Filter by building" data-filter="building">${buildingOptions(buildingFilter)}</select></div><span class="stat-note">${tenants.length} ${tenants.length === 1 ? "tenant" : "tenants"}</span></div>
      <section class="panel table-panel"><div class="table-scroll">${tenants.length ? `<table class="data-table"><thead><tr><th>TENANT</th><th>NATIONALITY</th><th>ROOM</th><th>MOVE-IN</th><th>LEASE ENDS</th><th>STATUS</th><th></th></tr></thead><tbody>${tenantTableRows(tenants)}</tbody></table>` : `<div class="empty-state"><div class="empty-icon" aria-hidden="true">♙</div><h3>${tenantQuery || buildingFilter !== "all" ? "No matching tenants" : "No tenants here yet"}</h3><p>${tenantQuery || buildingFilter !== "all" ? "Try another search or choose a different building." : "Add your first tenant and their room details to get started."}</p>${!tenantQuery && buildingFilter === "all" ? `<button class="primary-button" data-action="add-tenant"><span class="plus" aria-hidden="true">+</span>Add a tenant</button>` : ""}</div>`}</div><div class="table-footer"><span>Tenant records are saved as you go</span><span>${tenants.length} shown</span></div></section>`;
  };
  const renderHistory = () => {
    const tenants = data.tenants.filter((tenant) => tenant.status === "past")
      .filter((tenant) => historyBuildingFilter === "all" || tenant.buildingId === historyBuildingFilter)
      .filter((tenant) => `${tenant.name} ${tenant.nationality} ${tenant.email} ${tenant.phone} ${getBuilding(tenant.buildingId)?.name || ""}`.toLowerCase().includes(historyQuery.toLowerCase()))
      .sort((a, b) => b.endDate.localeCompare(a.endDate));
    return `${pageHeading("YOUR RECORDS", "Past tenants", "A complete history of people who have rented from you.", "", "")}
      <div class="toolbar"><div class="toolbar-left"><label class="search-wrap"><span class="search-icon" aria-hidden="true">⌕</span><input class="search-input" type="search" placeholder="Search past tenants" aria-label="Search past tenants" value="${escapeHtml(historyQuery)}" data-input="history-search"></label><select class="filter-select" aria-label="Filter past tenants by building" data-filter="history-building">${buildingOptions(historyBuildingFilter)}</select></div><span class="stat-note">${tenants.length} ${tenants.length === 1 ? "record" : "records"}</span></div>
      <section class="panel table-panel"><div class="table-scroll">${tenants.length ? `<table class="data-table"><thead><tr><th>TENANT</th><th>NATIONALITY</th><th>ROOM</th><th>MOVE-IN</th><th>LEFT ON</th><th>STATUS</th><th></th></tr></thead><tbody>${tenantTableRows(tenants, true)}</tbody></table>` : `<div class="empty-state"><div class="empty-icon" aria-hidden="true">◷</div><h3>${historyQuery || historyBuildingFilter !== "all" ? "No matching records" : "No past tenant records yet"}</h3><p>When you end a tenancy, its details stay here so you can look them up later.</p></div>`}</div><div class="table-footer"><span>Past records are kept for your reference</span><span>${tenants.length} ${tenants.length === 1 ? "record" : "records"}</span></div></section>`;
  };

  const dailyRoomOptions = (selectedId = "") => data.buildings.flatMap((building) => building.units
    .filter(isDailyRoomConfigured)
    .map((unit) => `<option value="${escapeHtml(building.id)}|${escapeHtml(unit.id)}" ${unit.id === selectedId ? "selected" : ""}>${escapeHtml(building.name)} · Room ${escapeHtml(unit.number)} · ${unit.bedType === "king" ? "King bed" : "Double bed"} · ${formatMoney(unit.dailyRate)} THB / night</option>`)).join("");
  const renderDailyRentals = () => {
    const allRooms = data.buildings.flatMap((building) => building.units.map((unit) => ({ building, unit })));
    const activeBookings = data.dailyBookings.filter((booking) => booking.status !== "cancelled");
    const monthBookings = data.dailyBookings.filter((booking) => countNightsInMonth(booking.checkIn, booking.checkOut, dailyViewMonth) > 0);
    const activeMonthBookings = monthBookings.filter((booking) => booking.status !== "cancelled");
    const monthlyIncome = activeMonthBookings.reduce((sum, booking) => sum + countNightsInMonth(booking.checkIn, booking.checkOut, dailyViewMonth) * Number(booking.nightlyRate), 0);
    const todaysBookings = activeBookings.filter((booking) => booking.checkIn <= dateAtOffset(0) && booking.checkOut > dateAtOffset(0)).length;
    const dailyOptions = allRooms.filter(({ unit }) => isDailyRoomConfigured(unit));
    const bookingRows = monthBookings.slice().sort((a, b) => a.checkIn.localeCompare(b.checkIn)).map((booking) => {
      const building = getBuilding(booking.buildingId);
      const unit = getUnit(booking.buildingId, booking.unitId);
      const nights = Math.round((new Date(`${booking.checkOut}T00:00:00`) - new Date(`${booking.checkIn}T00:00:00`)) / 86400000);
      const age = ageFromDateOfBirth(booking.dateOfBirth);
      const guestDetails = [booking.nationality, booking.dateOfBirth ? `Age ${age ?? "—"} · DOB ${formatDate(booking.dateOfBirth)}` : "", booking.passportNumber ? `Passport: ${booking.passportNumber}` : "", booking.phone].filter(Boolean);
      return `<tr><td><strong>${escapeHtml(booking.guestName)}</strong>${guestDetails.length ? `<span class="booking-guest-detail">${guestDetails.map(escapeHtml).join(" · ")}</span>` : ""}</td><td>${escapeHtml(building?.name || "Building removed")} · Room ${escapeHtml(unit?.number || "—")}</td><td>${formatDate(booking.checkIn)} – ${formatDate(booking.checkOut)}</td><td>${nights}</td><td>${booking.bedType === "king" ? "King bed" : "Double bed"}</td><td>${formatMoney(booking.nightlyRate)} THB</td><td><strong>${booking.status === "cancelled" ? "—" : `${formatMoney(getDailyBookingAmount(booking))} THB`}</strong></td><td>${booking.status === "cancelled" ? "Cancelled" : `<div class="row-actions"><button class="text-button" data-action="edit-daily-stay" data-booking="${escapeHtml(booking.id)}">Edit dates</button><button class="text-button" data-action="cancel-daily-booking" data-booking="${escapeHtml(booking.id)}">Cancel</button></div>`}</td></tr>`;
    }).join("");
    return `${pageHeading("SHORT STAYS", "Daily rentals", "Manage daily bookings for your building rooms without overlapping monthly tenancies.", dailyOptions.length ? "Add daily booking" : "", "add-daily-booking")}
      <section class="stats-grid daily-stats" aria-label="Daily rental summary">
        <article class="stat-card"><div class="stat-top"><span class="stat-label">Daily income this month</span><span class="stat-icon" aria-hidden="true">¤</span></div><div class="stat-value">${formatMoney(monthlyIncome)}</div><span class="stat-note">${escapeHtml(formatDate(`${dailyViewMonth}-01`, { month: "long", year: "numeric" }))} · THB</span></article>
        <article class="stat-card"><div class="stat-top"><span class="stat-label">Bookings this month</span><span class="stat-icon" aria-hidden="true">▣</span></div><div class="stat-value">${activeMonthBookings.length}</div><span class="stat-note">Active bookings with nights this month</span></article>
        <article class="stat-card"><div class="stat-top"><span class="stat-label">Rooms occupied today</span><span class="stat-icon" aria-hidden="true">▥</span></div><div class="stat-value">${todaysBookings}</div><span class="stat-note">Daily guests staying tonight</span></article>
        <article class="stat-card"><div class="stat-top"><span class="stat-label">Daily rooms set up</span><span class="stat-icon" aria-hidden="true">⌂</span></div><div class="stat-value">${dailyOptions.length}</div><span class="stat-note">Across ${data.buildings.length} buildings</span></article>
      </section>
      <section class="panel daily-inventory-panel"><div class="panel-header"><div><h2 class="panel-title">Daily room settings</h2><p class="panel-caption">Edit room details in the table. Select which rooms to offer for daily stays, then save your changes.</p></div></div>
        ${allRooms.length ? `<div class="room-sheet-tools daily-room-sheet-tools"><span>Edit cells and save with the button. Pasted bed type and price rows save automatically.</span><div><button class="primary-button" data-action="save-daily-room-settings">Save daily room changes</button></div></div><div class="room-sheet-wrap"><table class="room-sheet daily-room-table" id="daily-room-settings"><thead><tr><th scope="col">BUILDING / ROOM</th><th scope="col">OFFER DAILY</th><th scope="col">BED TYPE</th><th scope="col">PRICE / NIGHT</th><th scope="col">MONTHLY TENANCY</th><th scope="col">BOOKING</th></tr></thead><tbody>${allRooms.map(({ building, unit }) => {
          const enabled = isDailyRoomConfigured(unit);
          const monthlyTenant = data.tenants.find((tenant) => tenant.status === "current" && tenant.unitId === unit.id);
          return `<tr class="daily-room-setting-row" data-daily-building="${escapeHtml(building.id)}" data-daily-unit="${escapeHtml(unit.id)}"><th scope="row">${escapeHtml(building.name)} · Room ${escapeHtml(unit.number)}</th><td><label class="daily-room-toggle"><input type="checkbox" data-daily-enabled aria-label="Offer ${escapeHtml(building.name)} room ${escapeHtml(unit.number)} for daily rentals" ${enabled ? "checked" : ""}><span>Offer daily stays</span></label></td><td><select class="sheet-input" data-daily-field="bedType" aria-label="Bed type for ${escapeHtml(building.name)} room ${escapeHtml(unit.number)}" ${enabled ? "" : "disabled"}><option value="">Choose type</option><option value="king" ${unit.bedType === "king" ? "selected" : ""}>King bed</option><option value="double" ${unit.bedType === "double" ? "selected" : ""}>Double bed</option></select></td><td><input class="sheet-input" data-daily-field="dailyRate" type="text" inputmode="decimal" data-money-input aria-label="Nightly price for ${escapeHtml(building.name)} room ${escapeHtml(unit.number)}" placeholder="e.g. 1,200" value="${unit.dailyRate == null ? "" : escapeHtml(formatMoney(unit.dailyRate))}" ${enabled ? "" : "disabled"}></td><td>${monthlyTenant ? `Reserved ${formatDate(monthlyTenant.startDate)} – ${formatDate(monthlyTenant.endDate)}` : "No confirmed monthly tenant"}</td><td><div class="row-actions"><button class="text-button" data-action="edit-daily-room" data-building="${escapeHtml(building.id)}" data-unit="${escapeHtml(unit.id)}">${enabled ? "Edit daily room" : "Set up daily room"}</button>${enabled ? `<button class="secondary-button" data-action="daily-book-room" data-building="${escapeHtml(building.id)}" data-unit="${escapeHtml(unit.id)}">Book dates</button>` : ""}</div></td></tr>`;
        }).join("")}</tbody></table></div><p class="form-hint room-sheet-hint">Paste bed type and nightly price columns from Excel or Sheets. Valid pasted changes save automatically. Existing bookings keep their original rate and bed type.</p>` : `<div class="empty-state"><h3>Add building rooms first</h3><p>Create your buildings and room list before setting up daily rentals.</p><button class="primary-button" data-action="add-building"><span class="plus" aria-hidden="true">+</span>Add a building</button></div>`}
      </section>
      <section class="panel table-panel daily-bookings-panel"><div class="panel-header"><div><h2 class="panel-title">Daily bookings</h2><p class="panel-caption">Stays with at least one night in the selected month.</p></div><label class="daily-month-field">Summary month<input type="month" aria-label="Daily rental summary month" value="${escapeHtml(dailyViewMonth)}" data-input="daily-month"></label></div>
        <div class="table-scroll"><table class="data-table daily-bookings-table"><thead><tr><th>GUEST</th><th>BUILDING / ROOM</th><th>CHECK-IN – CHECK-OUT</th><th>NIGHTS</th><th>BED TYPE</th><th>RATE / NIGHT</th><th>BOOKING TOTAL</th><th></th></tr></thead><tbody>${bookingRows || `<tr><td colspan="8" class="daily-empty">No daily bookings for ${escapeHtml(formatDate(`${dailyViewMonth}-01`, { month: "long", year: "numeric" }))}.</td></tr>`}</tbody></table></div>
      </section>`;
  };

  const dailyBookingModal = (buildingId = "", unitId = "") => {
    const options = data.buildings.flatMap((building) => building.units
      .filter(isDailyRoomConfigured)
      .map((unit) => `<option value="${escapeHtml(building.id)}|${escapeHtml(unit.id)}" ${building.id === buildingId && unit.id === unitId ? "selected" : ""}>${escapeHtml(building.name)} · Room ${escapeHtml(unit.number)} · ${unit.bedType === "king" ? "King bed" : "Double bed"}</option>`)).join("");
    if (!options) {
      showToast("Set up at least one room for daily rentals first.", true);
      return;
    }
    const selectedUnit = unitId ? getUnit(buildingId, unitId) : data.buildings.flatMap((building) => building.units)
      .find(isDailyRoomConfigured);
    const initialRate = selectedUnit ? formatMoney(selectedUnit.dailyRate) : "";
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">Add a daily booking</h2><p>Choose check-in and check-out dates. Monthly tenancy and other daily bookings are protected from overlap.</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header>
      <form class="modal-form" id="daily-booking-form"><div class="form-grid">
        <div class="form-field full"><label for="daily-guest-name">Guest name <span aria-hidden="true">*</span></label><input id="daily-guest-name" name="guestName" required maxlength="100" autocomplete="name"></div>
        <div class="form-field"><label for="daily-guest-nationality">Nationality <span aria-hidden="true">*</span></label><select id="daily-guest-nationality" name="nationality" required><option value="">Choose nationality</option>${renderNationalityOptions()}</select></div>
        <div class="form-field" id="daily-guest-passport-field" hidden><label for="daily-guest-passport">Passport number <span aria-hidden="true">*</span></label><input id="daily-guest-passport" name="passportNumber" maxlength="50" autocomplete="off" placeholder="Enter passport number"></div>
        <div class="form-field"><label for="daily-guest-dob">Date of birth</label><input id="daily-guest-dob" name="dateOfBirth" type="date" max="${dateAtOffset(0)}"><span class="form-hint">Optional. Age is calculated from this date.</span></div>
        <div class="form-field"><label for="daily-guest-phone">Phone number</label><input id="daily-guest-phone" name="phone" type="tel" maxlength="40" autocomplete="tel"></div>
        <div class="form-field"><label for="daily-booking-room">Room <span aria-hidden="true">*</span></label><select id="daily-booking-room" name="room" required>${options}</select></div>
        <div class="form-field"><label for="daily-check-in">Check-in <span aria-hidden="true">*</span></label><input id="daily-check-in" name="checkIn" type="date" required value="${dateAtOffset(0)}"></div>
        <div class="form-field"><label for="daily-check-out">Check-out <span aria-hidden="true">*</span></label><input id="daily-check-out" name="checkOut" type="date" required value="${dateAtOffset(1)}"></div>
        <div class="form-field full daily-price-preview"><span>Nightly rate</span><strong id="daily-nightly-rate">${initialRate} THB</strong><span>Estimated total: <strong id="daily-booking-total">${initialRate} THB</strong></span></div>
        <div class="form-field full"><p class="form-hint">A stay uses the room from check-in up to (but not including) check-out. The monthly income summary counts each booked night in its calendar month.</p></div>
      </div><footer class="modal-footer"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button type="submit" class="primary-button">Save daily booking</button></footer></form></section></div>`;
    updateDailyBookingPreview();
  };

  const dailyRoomModal = (buildingId, unitId) => {
    const building = getBuilding(buildingId);
    const unit = getUnit(buildingId, unitId);
    if (!building || !unit) {
      showToast("This building room could not be found.", true);
      return;
    }
    const enabled = isDailyRoomConfigured(unit);
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">Edit daily room</h2><p>${escapeHtml(building.name)} · Room ${escapeHtml(unit.number)}</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header><form class="modal-form" id="daily-room-form" data-building="${escapeHtml(building.id)}" data-unit="${escapeHtml(unit.id)}"><div class="form-grid">
      <div class="form-field full"><label class="daily-room-toggle"><input type="checkbox" name="enabled" id="daily-room-enabled" ${enabled ? "checked" : ""}><span>Offer this room for daily stays</span></label><p class="form-hint">Turn this off if the room should be used for monthly tenants instead. Existing daily bookings will be kept and still block overlapping dates.</p></div>
      <div class="form-field"><label for="daily-room-rate">Price per night (THB) <span aria-hidden="true">*</span></label><input id="daily-room-rate" name="dailyRate" type="text" inputmode="decimal" data-money-input ${enabled ? "required" : "disabled"} value="${unit.dailyRate == null ? "" : escapeHtml(formatMoney(unit.dailyRate))}" placeholder="e.g. 1,200"></div>
      <div class="form-field"><label for="daily-room-bed">Bed type <span aria-hidden="true">*</span></label><select id="daily-room-bed" name="bedType" ${enabled ? "required" : "disabled"}><option value="">Choose bed type</option><option value="king" ${unit.bedType === "king" ? "selected" : ""}>King bed</option><option value="double" ${unit.bedType === "double" ? "selected" : ""}>Double bed</option></select></div>
      </div><footer class="modal-footer"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button type="submit" class="primary-button">Save daily room changes</button></footer></form></section></div>`;
  };

  const editTenantStayModal = (tenantId) => {
    const tenant = data.tenants.find((record) => record.id === tenantId && record.status === "current");
    if (!tenant) {
      showToast("This current tenant could not be found.", true);
      return;
    }
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">Edit tenant stay</h2><p>${escapeHtml(tenant.name)} · Change the move-in or lease end date.</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header><form class="modal-form" id="edit-tenant-stay-form" data-tenant="${escapeHtml(tenant.id)}"><div class="form-grid"><div class="form-field"><label for="edit-tenant-start">Move-in date <span aria-hidden="true">*</span></label><input id="edit-tenant-start" name="startDate" type="date" required value="${escapeHtml(tenant.startDate)}"></div><div class="form-field"><label for="edit-tenant-end">Lease end date <span aria-hidden="true">*</span></label><input id="edit-tenant-end" name="endDate" type="date" required value="${escapeHtml(tenant.endDate)}"></div><div class="form-field full"><p class="form-hint">Changing these dates also updates the room’s availability and rental term. Dates cannot overlap daily bookings.</p></div></div><footer class="modal-footer"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button type="submit" class="primary-button">Save stay dates</button></footer></form></section></div>`;
  };

  const editDailyStayModal = (bookingId) => {
    const booking = data.dailyBookings.find((record) => record.id === bookingId && record.status !== "cancelled");
    if (!booking) {
      showToast("This active daily booking could not be found.", true);
      return;
    }
    const unit = getUnit(booking.buildingId, booking.unitId);
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">Edit daily stay dates</h2><p>${escapeHtml(booking.guestName)} · ${escapeHtml(getBuilding(booking.buildingId)?.name || "Building")} · Room ${escapeHtml(unit?.number || "—")}</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header><form class="modal-form" id="edit-daily-stay-form" data-booking="${escapeHtml(booking.id)}"><div class="form-grid"><div class="form-field"><label for="edit-daily-check-in">Check-in <span aria-hidden="true">*</span></label><input id="edit-daily-check-in" name="checkIn" type="date" required value="${escapeHtml(booking.checkIn)}"></div><div class="form-field"><label for="edit-daily-check-out">Check-out <span aria-hidden="true">*</span></label><input id="edit-daily-check-out" name="checkOut" type="date" required value="${escapeHtml(booking.checkOut)}"></div><div class="form-field full"><p class="form-hint">The new dates must not overlap a monthly tenancy or another daily booking. The saved nightly rate stays the same.</p></div></div><footer class="modal-footer"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button type="submit" class="primary-button">Save stay dates</button></footer></form></section></div>`;
  };

  const updateDailyBookingPreview = () => {
    const roomSelect = document.getElementById("daily-booking-room");
    if (!roomSelect) return;
    const [buildingId, unitId] = roomSelect.value.split("|");
    const unit = getUnit(buildingId, unitId);
    const nights = Math.max(0, Math.round((new Date(`${document.getElementById("daily-check-out").value}T00:00:00`) - new Date(`${document.getElementById("daily-check-in").value}T00:00:00`)) / 86400000));
    const rate = Number(unit?.dailyRate) || 0;
    document.getElementById("daily-nightly-rate").textContent = `${formatMoney(rate)} THB`;
    document.getElementById("daily-booking-total").textContent = `${formatMoney(rate * nights)} THB (${nights} ${nights === 1 ? "night" : "nights"})`;
  };

  const buildingIllustration = () => `<svg viewBox="0 0 80 80" fill="none" aria-hidden="true"><path d="M17 68V25l22-12 24 12v43M11 68h58M31 68V53h17v15M26 30h7v7h-7zM47 30h7v7h-7zM26 43h7v7h-7zM47 43h7v7h-7z" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="m12 25 27-15 29 15" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const renderBuildings = () => `${pageHeading("YOUR PORTFOLIO", "Your buildings", "All your properties and rooms, together in one place.", "Add a building", "add-building")}
    ${data.buildings.length ? `<section class="building-grid">${data.buildings.map((building, index) => {
      const { occupied, total } = getOccupancy(building);
      const revenue = getMonthlyRevenue(building);
      return `<article class="building-card"><div class="building-visual variant-${index % 3}">${buildingIllustration()}</div><div class="building-content"><div class="building-title-row"><div><h2>${escapeHtml(building.name)}</h2><p class="building-address">${escapeHtml(building.address)}</p></div><div class="building-title-actions"><button class="secondary-button building-edit-button" data-action="edit-building" data-building="${escapeHtml(building.id)}">Edit building details</button><button class="secondary-button building-add-room-button" data-action="add-sheet-room" data-building="${escapeHtml(building.id)}">+ Add a room</button></div></div>
        <div class="building-stats"><div class="building-stat"><strong>${total}</strong><span>Rooms</span></div><div class="building-stat"><strong>${occupied}</strong><span>Occupied</span></div><div class="building-stat"><strong>${total - occupied}</strong><span>Available</span></div></div>
        <div class="building-progress" aria-label="${occupied} of ${total} rooms occupied"><span style="width:${total ? Math.round(occupied / total * 100) : 0}%"></span></div><div class="building-foot"><span>${total ? Math.round(occupied / total * 100) : 0}% occupied</span></div>
        <div class="building-revenue"><div><span>Current monthly income</span><strong>${formatMoney(revenue.current)}</strong></div><div><span>If all rooms rented</span><strong>${formatMoney(revenue.potential)}</strong></div></div>
        <details class="building-units" data-room-building="${escapeHtml(building.id)}"><summary>All room details in this building</summary>
          <div class="room-sheet-tools"><span>Click a cell to edit. Paste rows copied from Excel or Sheets, then save.</span><div><button class="secondary-button" data-action="add-sheet-room" data-building="${escapeHtml(building.id)}">+ Add room</button><button class="primary-button" data-action="save-room-sheet" data-building="${escapeHtml(building.id)}">Save room changes</button></div></div>
          <div class="room-sheet-wrap"><table class="room-sheet building-room-sheet"><thead><tr><th scope="col">ROOM NUMBER</th><th scope="col">FLOOR</th><th scope="col">MONTHLY PRICE</th><th scope="col">ROOM TYPE</th><th scope="col">OCCUPANCY</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${building.units.map((unit) => roomDetailRow(unit)).join("")}</tbody></table></div>
          <p class="form-hint room-sheet-hint">Copy the room number, floor, price, and room type columns in Excel or Sheets, then paste into the matching cell. Pasted changes save automatically.</p>
        </details></div></article>`;
    }).join("")}</section>` : `<section class="panel"><div class="empty-state"><div class="empty-icon" aria-hidden="true">▥</div><h3>Add your first building</h3><p>Create a building and list all its rooms. Then you can add tenants and keep every lease in one place.</p><button class="primary-button" data-action="add-building"><span class="plus" aria-hidden="true">+</span>Add a building</button></div></section>`}`;

  const render = () => {
    appContent.classList.toggle("buildings-page", currentView === "buildings");
    setHeader(currentView);
    appContent.innerHTML = currentView === "overview" ? renderOverview()
      : currentView === "tenants" ? renderTenants()
      : currentView === "buildings" ? renderBuildings()
      : currentView === "daily" ? renderDailyRentals()
      : renderHistory();
  };

  const tenantModal = () => {
    const available = data.buildings.flatMap((building) => building.units
      .filter((unit) => !getCurrentTenant(unit.id))
      .map((unit) => ({ building, unit })));
    if (!available.length) {
      showToast("There are no available rooms. Add a building or room first.", true);
      return;
    }
    const availableBuildings = data.buildings.filter((building) => building.units.some((unit) => !getCurrentTenant(unit.id)));
    const buildingOptions = availableBuildings.map((building) => `<option value="${escapeHtml(building.id)}">${escapeHtml(building.name)}</option>`).join("");
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">Add a tenant</h2><p>Add their details and rental dates. You can change these later.</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header>
      <form class="modal-form" id="tenant-form"><p class="form-section-title">TENANT DETAILS</p><div class="form-grid">
        <div class="form-field"><label for="tenant-name">Full name <span aria-hidden="true">*</span></label><input id="tenant-name" name="name" required maxlength="100" autocomplete="name" placeholder="e.g. Alex Morgan"></div>
        <div class="form-field"><label for="tenant-nationality">Nationality <span aria-hidden="true">*</span></label><select id="tenant-nationality" name="nationality" required><option value="">Choose nationality</option>${renderNationalityOptions()}</select></div>
        <div class="form-field" id="tenant-passport-field" hidden><label for="tenant-passport">Passport number <span aria-hidden="true">*</span></label><input id="tenant-passport" name="passportNumber" maxlength="50" autocomplete="off" placeholder="Enter passport number"></div>
        <div class="form-field"><label for="tenant-dob">Date of birth</label><input id="tenant-dob" name="dateOfBirth" type="date" max="${dateAtOffset(0)}"><span class="form-hint">Optional. Age is calculated from this date.</span></div>
        <div class="form-field"><label for="tenant-phone">Phone number</label><input id="tenant-phone" name="phone" type="tel" maxlength="40" autocomplete="tel" placeholder="Include country code if possible"></div>
        <div class="form-field"><label for="tenant-email">Email address</label><input id="tenant-email" name="email" type="email" maxlength="150" autocomplete="email" placeholder="name@example.com"></div>
        <div class="form-field"><label for="tenant-building">Building <span aria-hidden="true">*</span></label><select id="tenant-building" name="buildingId" required><option value="">Choose a building</option>${buildingOptions}</select></div>
        <div class="form-field"><label for="tenant-apartment">Room <span aria-hidden="true">*</span></label><select id="tenant-apartment" name="apartment" required disabled><option value="">Choose a building first</option></select></div>
      </div>
      <p class="form-section-title" style="margin-top:20px">RENTAL DETAILS</p><div class="form-grid">
        <div class="form-field"><label for="lease-start">Move-in date <span aria-hidden="true">*</span></label><input id="lease-start" name="startDate" type="date" required value="${dateAtOffset(0)}"></div>
        <div class="form-field"><label for="lease-end">Lease end date <span aria-hidden="true">*</span></label><input id="lease-end" name="endDate" type="date" required value="${dateAtMonthOffset(1)}"></div>
        <div class="form-field full"><div class="term-preview" id="term-preview">Rental term: <strong>1 month</strong></div><span class="form-hint">Choose any end date. The rental term is worked out for you.</span></div>
        <div class="form-field"><label for="tenant-rent">Monthly rent (local currency) <span aria-hidden="true">*</span></label><input id="tenant-rent" name="rent" type="text" required inputmode="decimal" data-money-input placeholder="e.g. 1,200"><span class="form-hint">Filled from the selected room’s listed price. Change it if the agreed rent is different.</span></div>
        <div class="form-field full"><fieldset class="extra-rentals-fieldset"><legend>Optional monthly extras</legend><p class="form-hint">Select anything this tenant rents in addition to the room.</p><div class="extra-rentals-grid">${renderExtraRentalOptions()}</div></fieldset></div>
        <div class="form-field"><label for="tenant-notes">Notes (optional)</label><input id="tenant-notes" name="notes" maxlength="300" placeholder="Anything helpful to remember"></div>
      </div>
      <footer class="modal-footer"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button type="submit" class="primary-button">Save tenant</button></footer></form></section></div>`;
    document.getElementById("tenant-name").focus();
  };

  const tenantRoomOptions = (buildingId) => {
    const building = getBuilding(buildingId);
    if (!building) return `<option value="">Choose a building first</option>`;
    const availableUnits = building.units.filter((unit) => !getCurrentTenant(unit.id));
    if (!availableUnits.length) return `<option value="">No rooms available in this building</option>`;
    return `<option value="">Choose a room</option>${availableUnits.map((unit) => `<option value="${escapeHtml(unit.id)}">${escapeHtml(unit.number)} · ${formatMoney(unit.rent)} monthly · Floor ${escapeHtml(unit.floor || "not set")} · ${coolingLabel(unit.cooling)}</option>`).join("")}`;
  };

  const buildingModal = (buildingId = "") => {
    const building = buildingId ? getBuilding(buildingId) : null;
    if (buildingId && !building) return;
    const editing = Boolean(building);
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal modal-wide ${editing ? "building-edit-modal" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">${editing ? "Edit building details" : "Add a building"}</h2><p>${editing ? "Change the building name or address. Room and tenant records will stay in place." : "Enter the building details, then list every room and its rent."}</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header>
      <form class="modal-form" id="building-form" data-building="${escapeHtml(building?.id || "")}"><div class="form-grid">
        <div class="form-field"><label for="building-name">Building name <span aria-hidden="true">*</span></label><input id="building-name" name="name" required maxlength="100" placeholder="e.g. Riverside Apartments" value="${escapeHtml(building?.name || "")}"></div>
        <div class="form-field"><label for="building-address">Address <span aria-hidden="true">*</span></label><input id="building-address" name="address" required maxlength="200" placeholder="Street, area, city" value="${escapeHtml(building?.address || "")}"></div>
      </div>
      ${editing ? "" : `<div class="room-sheet-heading"><div><h3>All room details in this building</h3><p>Add one line for every room. You can adjust the details later.</p></div><button type="button" class="secondary-button room-add-button" data-action="add-building-room"><span class="plus" aria-hidden="true">+</span>Add a room</button></div>
      <div class="room-sheet-wrap"><table class="room-sheet"><thead><tr><th scope="col">ROOM NUMBER</th><th scope="col">FLOOR</th><th scope="col">MONTHLY PRICE</th><th scope="col">ROOM TYPE</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody id="building-room-rows">${buildingRoomRow()}</tbody></table></div>
      <p class="form-hint room-sheet-hint">Enter the rent in your local currency. Room type can be air conditioning, fan, or no AC or fan.</p>`}
      <footer class="modal-footer"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button type="submit" class="primary-button">${editing ? "Save building details" : "Save building and rooms"}</button></footer></form></section></div>`;
    document.getElementById("building-name").focus();
  };

  const buildingRoomRow = () => `<tr class="building-room-row">
    <td><label class="visually-hidden">Room number</label><input class="sheet-input" name="roomNumber" required maxlength="30" placeholder="e.g. 101" aria-label="Room number"></td>
    <td><label class="visually-hidden">Floor</label><input class="sheet-input" name="roomFloor" required maxlength="30" placeholder="e.g. 1 or Ground" aria-label="Floor"></td>
    <td><label class="visually-hidden">Monthly price in local currency</label><input class="sheet-input" name="roomRent" required type="text" inputmode="decimal" data-money-input placeholder="e.g. 1,200" aria-label="Monthly price in local currency"></td>
    <td><label class="visually-hidden">Room type</label><select class="sheet-input" name="roomCooling" required aria-label="Room type"><option value="">Choose type</option><option value="ac">AC room</option><option value="fan">Fan room</option><option value="none">No AC or fan</option></select></td>
    <td><button type="button" class="sheet-remove" data-action="remove-building-room" aria-label="Remove room" title="Remove room" disabled>×</button></td>
  </tr>`;

  const roomDetailRow = (unit) => {
    const tenant = getCurrentTenant(unit.id);
    const isNew = unit.isDraft === true;
    return `<tr class="building-room-row" data-room-id="${escapeHtml(unit.id)}" ${isNew ? 'data-new-room="true"' : ""}>
      <td><input class="sheet-input" data-room-field="number" required maxlength="30" placeholder="e.g. 101" aria-label="Room number" value="${escapeHtml(unit.number || "")}"></td>
      <td><input class="sheet-input" data-room-field="floor" required maxlength="30" placeholder="e.g. 1 or Ground" aria-label="Floor" value="${escapeHtml(unit.floor || "")}"></td>
      <td><input class="sheet-input" data-room-field="rent" data-money-input required type="text" inputmode="decimal" placeholder="e.g. 1,200" aria-label="Monthly price in local currency" value="${escapeHtml(unit.rent === "" || unit.rent == null ? "" : formatMoney(unit.rent))}"></td>
      <td><select class="sheet-input" data-room-field="cooling" required aria-label="Room type"><option value="">Choose type</option><option value="ac" ${unit.cooling === "ac" ? "selected" : ""}>AC room</option><option value="fan" ${unit.cooling === "fan" ? "selected" : ""}>Fan room</option><option value="none" ${unit.cooling === "none" ? "selected" : ""}>No AC or fan</option></select></td>
      <td><span class="sheet-occupancy">${tenant ? `Occupied · ${escapeHtml(tenant.name)}` : "Available"}</span></td>
      <td>${isNew ? `<button type="button" class="sheet-remove" data-action="remove-sheet-room" aria-label="Remove new room" title="Remove room">×</button>` : ""}</td>
    </tr>`;
  };

  const updateBuildingRoomControls = () => {
    const rows = document.querySelectorAll("#building-room-rows .building-room-row");
    rows.forEach((row) => {
      row.querySelector('[data-action="remove-building-room"]').disabled = rows.length === 1;
    });
  };

  const normalizeCooling = (value) => {
    const label = value.trim().toLowerCase();
    if (/\b(no|without)\b/.test(label)) return "none";
    if (label.includes("fan")) return "fan";
    if (/\bac\b|\ba\/c\b|air ?con|air-condition/.test(label)) return "ac";
    if (["none", "no"].includes(label)) return "none";
    return "";
  };

  const saveRoomSheet = (buildingId, pasted = false) => {
    const building = getBuilding(buildingId);
    const details = [...document.querySelectorAll("[data-room-building]")].find((item) => item.dataset.roomBuilding === buildingId);
    const rows = [...(details?.querySelectorAll(".building-room-row") || [])];
    if (!building || !rows.length) {
      showToast("The room list could not be found. Please reopen the building and try again.", true);
      return false;
    }

    const rooms = rows.map((row) => {
      const getField = (name) => row.querySelector(`[data-room-field="${name}"]`);
      return {
        id: row.dataset.roomId,
        number: getField("number").value.trim(),
        floor: getField("floor").value.trim(),
        rent: parseMoney(getField("rent").value),
        cooling: getField("cooling").value
      };
    });
    if (rooms.some((room) => !room.number || !room.floor || !room.cooling || !Number.isFinite(room.rent) || room.rent < 0)) {
      const incompleteRow = rooms.findIndex((room) => !room.number || !room.floor || !room.cooling || !Number.isFinite(room.rent) || room.rent < 0);
      showToast(pasted
        ? "Pasted. Complete any blank or invalid room cells, then save the room changes."
        : "Complete the room number, floor, monthly price, and room type for every row before saving.", true);
      const firstMissingField = ["number", "floor", "rent", "cooling"].find((field) => {
        const room = rooms[incompleteRow];
        return field === "rent" ? !Number.isFinite(room.rent) || room.rent < 0 : !room[field];
      });
      rows[incompleteRow]?.querySelector(`[data-room-field="${firstMissingField}"]`)?.focus();
      return false;
    }
    rows.forEach((row) => row.querySelector('[data-room-field="number"]').setCustomValidity(""));
    if (new Set(rooms.map((room) => room.number.toLowerCase())).size !== rooms.length) {
      showToast("Room numbers must be unique within this building. Check the highlighted room numbers and try again.", true);
      rows.forEach((row) => {
        const input = row.querySelector('[data-room-field="number"]');
        input.setCustomValidity(rooms.filter((room) => room.number.toLowerCase() === input.value.trim().toLowerCase()).length > 1
          ? "This room number is used more than once in this building." : "");
      });
      rows.find((row) => row.querySelector('[data-room-field="number"]').validationMessage)?.querySelector('[data-room-field="number"]').reportValidity();
      return false;
    }

    const previousUnits = building.units.map((unit) => ({ ...unit }));
    building.units = rooms.map((room) => {
      const existing = previousUnits.find((unit) => unit.id === room.id);
      return {
        ...(existing || {}),
        id: room.id,
        number: room.number,
        floor: room.floor,
        rent: room.rent,
        cooling: room.cooling,
        bedrooms: existing?.bedrooms ?? 1
      };
    });
    if (!saveData()) {
      building.units = previousUnits;
      return false;
    }

    render();
    const updatedDetails = [...document.querySelectorAll("[data-room-building]")].find((item) => item.dataset.roomBuilding === buildingId);
    if (updatedDetails) updatedDetails.open = true;
    showToast(pasted ? "Pasted room details saved." : "All room details saved.");
    return true;
  };

  const unitModal = (buildingId, unitId = "") => {
    const building = getBuilding(buildingId);
    if (!building) return;
    const unit = unitId ? building.units.find((record) => record.id === unitId) : null;
    if (unitId && !unit) return;
    const editing = Boolean(unit);
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">${editing ? "Edit apartment details" : "Add an apartment"}</h2><p>${editing ? `Update unit ${escapeHtml(unit.number)} in ${escapeHtml(building.name)}.` : `Add a unit to ${escapeHtml(building.name)}.`}</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header>
      <form class="modal-form" id="unit-form" data-building="${escapeHtml(building.id)}" data-unit="${escapeHtml(unit?.id || "")}"><div class="form-grid">
        <div class="form-field"><label for="unit-number">Apartment number <span aria-hidden="true">*</span></label><input id="unit-number" name="number" required maxlength="30" placeholder="e.g. 301" value="${escapeHtml(unit?.number || "")}"></div>
        <div class="form-field"><label for="unit-bedrooms">Bedrooms <span aria-hidden="true">*</span></label><input id="unit-bedrooms" name="bedrooms" required type="number" min="0" max="50" step="1" value="${escapeHtml(unit?.bedrooms ?? 1)}"></div>
        <div class="form-field"><label for="unit-floor">Floor <span aria-hidden="true">*</span></label><input id="unit-floor" name="floor" required maxlength="30" placeholder="e.g. Ground, 2, or B1" value="${escapeHtml(unit?.floor || "")}"></div>
        <div class="form-field"><label for="unit-cooling">Room cooling <span aria-hidden="true">*</span></label><select id="unit-cooling" name="cooling" required><option value="">Choose one</option><option value="ac" ${unit?.cooling === "ac" ? "selected" : ""}>Air conditioning</option><option value="fan" ${unit?.cooling === "fan" ? "selected" : ""}>Fan</option><option value="none" ${unit?.cooling === "none" ? "selected" : ""}>No AC or fan</option></select></div>
        <div class="form-field full"><label for="unit-rent">Monthly rent (local currency) <span aria-hidden="true">*</span></label><input id="unit-rent" name="rent" required type="text" inputmode="decimal" data-money-input value="${escapeHtml(formatMoney(unit?.rent ?? 0))}"></div>
        ${editing && getCurrentTenant(unit.id) ? `<div class="form-field full"><span class="form-hint">Changing the listed rent updates the potential income. ${escapeHtml(getCurrentTenant(unit.id).name)}’s agreed rent stays unchanged.</span></div>` : ""}
      </div><footer class="modal-footer"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button type="submit" class="primary-button">${editing ? "Save changes" : "Save apartment"}</button></footer></form></section></div>`;
    document.getElementById("unit-number").focus();
  };

  const confirmEndLease = (tenantId) => {
    const tenant = data.tenants.find((record) => record.id === tenantId);
    if (!tenant) return;
    const building = getBuilding(tenant.buildingId);
    const unit = getUnit(tenant.buildingId, tenant.unitId);
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">End this tenancy?</h2><p>The tenant will move into your past tenant records.</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header>
      <div class="confirm-copy">This keeps their contact details and rental dates for your records, and marks apartment ${escapeHtml(unit?.number || "")} as available for a new tenant.</div><div class="confirm-summary"><strong>${escapeHtml(tenant.name)}</strong><span>${escapeHtml(building?.name || "")} · Unit ${escapeHtml(unit?.number || "—")}</span></div>
      <footer class="confirm-footer"><button class="secondary-button" data-action="close-modal">Keep tenant</button><button class="danger-button" data-action="confirm-end-lease" data-tenant="${escapeHtml(tenant.id)}">End tenancy</button></footer></section></div>`;
  };

  const showTenantRecord = (tenantId) => {
    const tenant = data.tenants.find((record) => record.id === tenantId);
    if (!tenant) return;
    const building = getBuilding(tenant.buildingId);
    const unit = getUnit(tenant.buildingId, tenant.unitId);
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">${escapeHtml(tenant.name)}</h2><p>Past tenant record</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header><div class="modal-form"><div class="form-grid">
      <div class="form-field"><label>Nationality</label><div>${escapeHtml(tenant.nationality || "Not recorded")}</div></div><div class="form-field"><label>Age / date of birth</label><div>${tenant.dateOfBirth ? `${ageFromDateOfBirth(tenant.dateOfBirth) ?? "—"} years · ${formatDate(tenant.dateOfBirth)}` : "Not recorded"}</div></div>${tenant.passportNumber ? `<div class="form-field"><label>Passport number</label><div>${escapeHtml(tenant.passportNumber)}</div></div>` : ""}<div class="form-field"><label>Phone</label><div>${escapeHtml(tenant.phone || "Not recorded")}</div></div>
      <div class="form-field"><label>Email</label><div>${escapeHtml(tenant.email || "Not recorded")}</div></div><div class="form-field"><label>Apartment</label><div>${escapeHtml(building?.name || "Building removed")} · ${escapeHtml(unit?.number || "—")}</div></div>
      <div class="form-field"><label>Move-in date</label><div>${formatDate(tenant.startDate)}</div></div><div class="form-field"><label>Lease end date</label><div>${formatDate(tenant.endDate)}</div></div>
      ${tenant.endedDate ? `<div class="form-field"><label>Moved out</label><div>${formatDate(tenant.endedDate)}</div></div>` : ""}
      <div class="form-field"><label>Monthly rent (local currency)</label><div>${formatMoney(tenant.rent)}</div></div><div class="form-field"><label>Rental term</label><div>${escapeHtml(termLength(tenant.startDate, tenant.endDate) || "Not recorded")}</div></div>
      <div class="form-field full"><label>Monthly extras</label><div>${extraRentalOptions.filter((extra) => getExtraRentalAmount(tenant, extra.id) > 0).map((extra) => `${escapeHtml(extra.label)} (${formatMoney(getExtraRentalAmount(tenant, extra.id))} THB/month)`).join(", ") || "None"} · Total: ${formatMoney(getTenantExtrasTotal(tenant))} THB/month</div></div>
      ${tenant.notes ? `<div class="form-field full"><label>Notes</label><div>${escapeHtml(tenant.notes)}</div></div>` : ""}
    </div><footer class="modal-footer"><button class="primary-button" data-action="close-modal">Done</button></footer></div></section></div>`;
  };

  const editTenantExtrasModal = (tenantId) => {
    const tenant = data.tenants.find((record) => record.id === tenantId && record.status === "current");
    if (!tenant) {
      showToast("This current tenant could not be found.", true);
      return;
    }
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">Monthly extras</h2><p>${escapeHtml(tenant.name)} · Select the extras they rent each month.</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header><form class="modal-form" id="tenant-extras-form" data-tenant="${escapeHtml(tenant.id)}"><fieldset class="extra-rentals-fieldset"><legend>Available monthly extras</legend><div class="extra-rentals-grid">${renderExtraRentalOptions(tenant.extraRentals || {})}</div></fieldset><footer class="modal-footer"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button type="submit" class="primary-button">Save monthly extras</button></footer></form></section></div>`;
  };

  const saveDailyRoomSettings = () => {
    const table = document.getElementById("daily-room-settings");
    const rows = [...(table?.querySelectorAll(".daily-room-setting-row") || [])].map((row) => {
      const unit = getUnit(row.dataset.dailyBuilding, row.dataset.dailyUnit);
      const enabled = row.querySelector("[data-daily-enabled]").checked;
      return {
        unit, enabled,
        dailyRate: parseMoney(row.querySelector('[data-daily-field="dailyRate"]').value),
        bedType: row.querySelector('[data-daily-field="bedType"]').value
      };
    });
    if (!table || !rows.length || rows.some(({ unit, enabled, dailyRate, bedType }) =>
      !unit || (enabled && (!Number.isFinite(dailyRate) || dailyRate < 0 || !["king", "double"].includes(bedType))))) {
      showToast("For each room offered daily, enter a valid nightly price and choose King bed or Double bed.", true);
      return;
    }

    const previousSettings = rows.map(({ unit }) => ({
      unit,
      hadRate: Object.prototype.hasOwnProperty.call(unit, "dailyRate"),
      dailyRate: unit.dailyRate,
      hadBedType: Object.prototype.hasOwnProperty.call(unit, "bedType"),
      bedType: unit.bedType
    }));
    rows.forEach(({ unit, enabled, dailyRate, bedType }) => {
      if (enabled) {
        unit.dailyRate = dailyRate;
        unit.bedType = bedType;
      } else {
        delete unit.dailyRate;
        delete unit.bedType;
      }
    });
    if (!saveData()) {
      previousSettings.forEach(({ unit, hadRate, dailyRate, hadBedType, bedType }) => {
        if (hadRate) unit.dailyRate = dailyRate;
        else delete unit.dailyRate;
        if (hadBedType) unit.bedType = bedType;
        else delete unit.bedType;
      });
      return;
    }
    render();
    showToast("Daily room settings saved.");
  };

  const closeModal = () => { modalRoot.innerHTML = ""; };
  const handleAction = (target, clickEvent) => {
    const action = target.dataset.action;
    if (action === "close-modal") {
      if (target.classList.contains("modal-backdrop") && target !== clickEvent.target) return;
      closeModal();
    } else if (action === "share-availability") publishAvailability();
    else if (action === "copy-availability-link") copyAvailabilityLink();
    else if (action === "confirm-stop-sharing") {
      modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title">
        <header class="modal-header"><div><h2 id="modal-title">Turn off the public link?</h2><p>Anyone using the current client link will no longer see your availability.</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header>
        <footer class="confirm-footer"><button class="secondary-button" data-action="close-modal">Keep sharing</button><button class="danger-button" data-action="stop-sharing-availability">Turn off link</button></footer>
      </section></div>`;
    } else if (action === "stop-sharing-availability") stopSharingAvailability();
    else if (action === "add-tenant") tenantModal();
    else if (action === "add-building") buildingModal();
    else if (action === "edit-building") buildingModal(target.dataset.building);
    else if (action === "add-daily-booking") dailyBookingModal();
    else if (action === "daily-book-room") dailyBookingModal(target.dataset.building, target.dataset.unit);
    else if (action === "edit-daily-room") dailyRoomModal(target.dataset.building, target.dataset.unit);
    else if (action === "save-daily-room-settings") saveDailyRoomSettings();
    else if (action === "cancel-daily-booking") {
      const booking = data.dailyBookings.find((record) => record.id === target.dataset.booking && record.status !== "cancelled");
      if (!booking) return;
      const unit = getUnit(booking.buildingId, booking.unitId);
      modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><div><h2 id="modal-title">Cancel daily booking?</h2><p>This keeps the booking record but frees the room dates.</p></div><button class="modal-close" type="button" aria-label="Close" data-action="close-modal">×</button></header><div class="confirm-copy">${escapeHtml(booking.guestName)} · Room ${escapeHtml(unit?.number || "—")} · ${formatDate(booking.checkIn)} – ${formatDate(booking.checkOut)}</div><footer class="confirm-footer"><button class="secondary-button" data-action="close-modal">Keep booking</button><button class="danger-button" data-action="confirm-cancel-daily-booking" data-booking="${escapeHtml(booking.id)}">Cancel booking</button></footer></section></div>`;
    }
    else if (action === "add-building-room") {
      const rows = document.querySelectorAll("#building-room-rows .building-room-row");
      if (rows.length >= 100) {
        showToast("A building can have up to 100 rooms in this form.", true);
        return;
      }
      document.getElementById("building-room-rows").insertAdjacentHTML("beforeend", buildingRoomRow());
      updateBuildingRoomControls();
      document.querySelector("#building-room-rows .building-room-row:last-child [name='roomNumber']").focus();
    } else if (action === "remove-building-room") {
      const row = target.closest(".building-room-row");
      if (!row || document.querySelectorAll("#building-room-rows .building-room-row").length <= 1) return;
      row.remove();
      updateBuildingRoomControls();
    } else if (action === "add-sheet-room") {
      const building = getBuilding(target.dataset.building);
      const details = [...document.querySelectorAll("[data-room-building]")].find((item) => item.dataset.roomBuilding === target.dataset.building);
      const tbody = details?.querySelector("tbody");
      const rowCount = details?.querySelectorAll(".building-room-row").length || 0;
      if (!building || !tbody) return;
      if (rowCount >= 1000) {
        showToast("A building can have up to 1,000 rooms.", true);
        return;
      }
      details.open = true;
      tbody.insertAdjacentHTML("beforeend", roomDetailRow({
        id: makeId("unit"), number: "", floor: "", rent: "", cooling: "", bedrooms: 1, isDraft: true
      }));
      details.querySelector(".building-room-row:last-child [data-room-field='number']").focus();
    } else if (action === "remove-sheet-room") {
      const row = target.closest(".building-room-row");
      if (!row?.dataset.newRoom) return;
      row.remove();
    } else if (action === "save-room-sheet") {
      saveRoomSheet(target.dataset.building);
    } else if (action === "add-unit") unitModal(target.dataset.building);
    else if (action === "edit-unit") unitModal(target.dataset.building, target.dataset.unit);
    else if (action === "edit-tenant-stay") editTenantStayModal(target.dataset.tenant);
    else if (action === "edit-daily-stay") editDailyStayModal(target.dataset.booking);
    else if (action === "edit-tenant-extras") editTenantExtrasModal(target.dataset.tenant);
    else if (action === "end-lease") confirmEndLease(target.dataset.tenant);
    else if (action === "view-tenant") showTenantRecord(target.dataset.tenant);
    else if (action === "confirm-end-lease") {
      const tenant = data.tenants.find((record) => record.id === target.dataset.tenant);
      if (!tenant || tenant.status !== "current") return;
      const previousEndedDate = tenant.endedDate;
      tenant.status = "past";
      tenant.endedDate = dateAtOffset(0);
      if (!saveData()) {
        tenant.status = "current";
        if (previousEndedDate === undefined) delete tenant.endedDate;
        else tenant.endedDate = previousEndedDate;
        return;
      }
      closeModal();
      render();
      showToast(`${tenant.name}'s record has been saved under past tenants.`);
    } else if (action === "confirm-cancel-daily-booking") {
      const booking = data.dailyBookings.find((record) => record.id === target.dataset.booking && record.status !== "cancelled");
      if (!booking) return;
      booking.status = "cancelled";
      if (!saveData()) {
        booking.status = "booked";
        return;
      }
      closeModal();
      render();
      showToast(`The daily booking for ${booking.guestName} was cancelled. The room dates are available again.`);
    } else if (target.dataset.view) {
      currentView = target.dataset.view;
      render();
    }
  };

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action], [data-view]");
    if (!target) return;
    handleAction(target, event);
  });
  document.addEventListener("paste", (event) => {
    const dailyCell = event.target.closest("[data-daily-field]");
    const dailyTable = dailyCell?.closest("#daily-room-settings");
    const clipboardText = event.clipboardData?.getData("text/plain");
    if (dailyCell && dailyTable && clipboardText) {
      const fieldNames = ["bedType", "dailyRate"];
      const startColumn = fieldNames.indexOf(dailyCell.dataset.dailyField);
      const rows = [...dailyTable.querySelectorAll(".daily-room-setting-row")];
      const startRow = rows.indexOf(dailyCell.closest(".daily-room-setting-row"));
      const pastedRows = clipboardText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      while (pastedRows.length && pastedRows[pastedRows.length - 1] === "") pastedRows.pop();
      const values = pastedRows.map((row) => row.split("\t"));
      const width = Math.max(...values.map((row) => row.length));
      if (startColumn < 0 || startRow < 0) return;
      event.preventDefault();
      if (startColumn + width > fieldNames.length || startRow + values.length > rows.length) {
        showToast("Copy no more columns or rows than the bed type and nightly price cells available.", true);
        return;
      }
      const updates = [];
      let invalidValue = false;
      values.forEach((pastedRow, rowIndex) => {
        pastedRow.forEach((value, columnIndex) => {
          const fieldName = fieldNames[startColumn + columnIndex];
          const cellValue = value.trim();
          if (fieldName === "bedType" && cellValue) {
            const normalized = cellValue.toLowerCase().includes("king") ? "king"
              : cellValue.toLowerCase().includes("double") ? "double" : "";
            if (!normalized) invalidValue = true;
            updates.push({ row: rows[startRow + rowIndex], fieldName, value: normalized });
          } else if (fieldName === "dailyRate" && cellValue) {
            const amount = parseMoney(cellValue);
            if (!Number.isFinite(amount) || amount < 0) invalidValue = true;
            updates.push({ row: rows[startRow + rowIndex], fieldName, value: Number.isFinite(amount) ? formatMoney(amount) : "" });
          } else {
            updates.push({ row: rows[startRow + rowIndex], fieldName, value: "" });
          }
        });
      });
      if (invalidValue) {
        showToast("Use King bed or Double bed for bed types, and valid numbers for nightly prices.", true);
        return;
      }
      updates.forEach(({ row, fieldName, value }) => {
        const input = row.querySelector(`[data-daily-field="${fieldName}"]`);
        row.querySelector("[data-daily-enabled]").checked = true;
        row.querySelectorAll("[data-daily-field]").forEach((field) => { field.disabled = false; });
        input.value = value;
      });
      saveDailyRoomSettings();
      return;
    }

    const cell = event.target.closest("[data-room-field]");
    const details = cell?.closest("[data-room-building]");
    if (!cell || !details || !clipboardText) return;

    const fieldNames = ["number", "floor", "rent", "cooling", "occupancy", "ignore"];
    const startColumn = fieldNames.indexOf(cell.dataset.roomField);
    const rows = [...details.querySelectorAll(".building-room-row")];
    const startRow = rows.indexOf(cell.closest(".building-room-row"));
    const pastedRows = clipboardText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    while (pastedRows.length && pastedRows[pastedRows.length - 1] === "") pastedRows.pop();
    const values = pastedRows.map((row) => row.split("\t"));
    const width = Math.max(...values.map((row) => row.length));
    if (!values.length || startColumn < 0 || startRow < 0) return;
    if (startColumn + width > fieldNames.length) {
      event.preventDefault();
      showToast("Start pasting in the first column needed for the copied room details.", true);
      return;
    }
    if (startRow + values.length > 1000) {
      event.preventDefault();
      showToast("A building can have up to 1,000 rooms. Copy fewer rows and try again.", true);
      return;
    }

    event.preventDefault();
    const tbody = details.querySelector("tbody");
    while (tbody.querySelectorAll(".building-room-row").length < startRow + values.length) {
      tbody.insertAdjacentHTML("beforeend", roomDetailRow({
        id: makeId("unit"), number: "", floor: "", rent: "", cooling: "", bedrooms: 1, isDraft: true
      }));
    }

    let unsupportedCooling = false;
    values.forEach((pastedRow, rowIndex) => {
      const row = tbody.querySelectorAll(".building-room-row")[startRow + rowIndex];
      pastedRow.forEach((value, columnIndex) => {
        const fieldName = fieldNames[startColumn + columnIndex];
        if (fieldName === "occupancy" || fieldName === "ignore") return;
        const input = row.querySelector(`[data-room-field="${fieldName}"]`);
        let cellValue = value.trim();
        if (fieldName === "cooling") {
          cellValue = normalizeCooling(cellValue);
          if (!cellValue) unsupportedCooling = true;
        } else if (fieldName === "rent") {
          cellValue = cellValue.replace(/,/g, "").replace(/^[^\d-]+/, "").replace(/[^\d.]+$/, "");
        }
        input.value = cellValue;
      });
    });
    if (unsupportedCooling) {
      showToast("Choose AC room, Fan room, or No AC or fan for each pasted room type.", true);
      return;
    }
    saveRoomSheet(details.dataset.roomBuilding, true);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
    if (event.key === "Tab" && modalRoot.querySelector('[role="dialog"]')) {
      const focusable = [...modalRoot.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])")];
      if (focusable.length && event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault();
        focusable[focusable.length - 1].focus();
      } else if (focusable.length && !event.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
        event.preventDefault();
        focusable[0].focus();
      }
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.dataset.input === "tenant-search") {
      tenantQuery = event.target.value;
      const position = event.target.selectionStart;
      render();
      const search = document.querySelector('[data-input="tenant-search"]');
      search.focus();
      search.setSelectionRange(position, position);
    } else if (event.target.dataset.input === "history-search") {
      historyQuery = event.target.value;
      const position = event.target.selectionStart;
      render();
      const search = document.querySelector('[data-input="history-search"]');
      search.focus();
      search.setSelectionRange(position, position);
    }
    if (event.target.id === "lease-start" || event.target.id === "lease-end") updateTermPreview();
  });
  document.addEventListener("change", (event) => {
    if (event.target.dataset.filter === "building") {
      buildingFilter = event.target.value;
      render();
    } else if (event.target.dataset.filter === "history-building") {
      historyBuildingFilter = event.target.value;
      render();
    }
    if (event.target.id === "tenant-building") {
      const roomSelect = document.getElementById("tenant-apartment");
      roomSelect.innerHTML = tenantRoomOptions(event.target.value);
      roomSelect.disabled = !event.target.value || !getBuilding(event.target.value)?.units.some((unit) => !getCurrentTenant(unit.id));
      document.getElementById("tenant-rent").value = "";
    }
    if (event.target.id === "tenant-apartment") {
      const buildingId = document.getElementById("tenant-building").value;
      const unitId = event.target.value;
      const unit = getUnit(buildingId, unitId);
      if (unit) document.getElementById("tenant-rent").value = formatMoney(unit.rent);
      else document.getElementById("tenant-rent").value = "";
    }
    if (["tenant-nationality", "daily-guest-nationality"].includes(event.target.id)) {
      const requiresPassport = event.target.value !== "" && event.target.value !== "Thai";
      const prefix = event.target.id === "tenant-nationality" ? "tenant" : "daily-guest";
      const passportField = document.getElementById(`${prefix}-passport-field`);
      const passportInput = document.getElementById(`${prefix}-passport`);
      passportField.hidden = !requiresPassport;
      passportInput.required = requiresPassport;
      if (!requiresPassport) passportInput.value = "";
    }
    if (event.target.matches("[data-daily-enabled]")) {
      const row = event.target.closest(".daily-room-setting-row");
      row.querySelectorAll("[data-daily-field]").forEach((field) => { field.disabled = !event.target.checked; });
    }
    if (event.target.id === "daily-room-enabled") {
      const form = event.target.form;
      const enabled = event.target.checked;
      const rate = form.elements.dailyRate;
      const bedType = form.elements.bedType;
      rate.disabled = !enabled;
      rate.required = enabled;
      bedType.disabled = !enabled;
      bedType.required = enabled;
    }
    if (event.target.dataset.input === "daily-month" && /^\d{4}-\d{2}$/.test(event.target.value)) {
      dailyViewMonth = event.target.value;
      render();
    }
    if (["daily-booking-room", "daily-check-in", "daily-check-out"].includes(event.target.id)) updateDailyBookingPreview();
  });
  const updateTermPreview = () => {
    const preview = document.getElementById("term-preview");
    if (!preview) return;
    const term = termLength(document.getElementById("lease-start").value, document.getElementById("lease-end").value);
    preview.innerHTML = term ? `Rental term: <strong>${escapeHtml(term)}</strong>` : `Rental term: <strong>Please check the dates</strong>`;
  };

  document.addEventListener("focusin", (event) => {
    if (event.target.matches("[data-money-input]")) {
      event.target.value = event.target.value.replace(/,/g, "");
    }
  });
  document.addEventListener("focusout", (event) => {
    if (event.target.matches("[data-money-input]") && event.target.value.trim() !== "") {
      const amount = parseMoney(event.target.value);
      if (Number.isFinite(amount) && amount >= 0) event.target.value = formatMoney(amount);
    }
  });

  document.addEventListener("submit", (event) => {
    if (event.target.id === "daily-room-form") {
      event.preventDefault();
      const unit = getUnit(event.target.dataset.building, event.target.dataset.unit);
      const form = new FormData(event.target);
      const enabled = form.get("enabled") === "on";
      const dailyRate = parseMoney(form.get("dailyRate"));
      const bedType = String(form.get("bedType"));
      if (!unit || (enabled && (!Number.isFinite(dailyRate) || dailyRate < 0 || !["king", "double"].includes(bedType)))) {
        showToast("Enter a valid nightly price and choose King bed or Double bed.", true);
        return;
      }
      const previousSettings = {
        hadRate: Object.prototype.hasOwnProperty.call(unit, "dailyRate"),
        dailyRate: unit.dailyRate,
        hadBedType: Object.prototype.hasOwnProperty.call(unit, "bedType"),
        bedType: unit.bedType
      };
      if (enabled) {
        unit.dailyRate = dailyRate;
        unit.bedType = bedType;
      } else {
        delete unit.dailyRate;
        delete unit.bedType;
      }
      if (!saveData()) {
        if (previousSettings.hadRate) unit.dailyRate = previousSettings.dailyRate;
        else delete unit.dailyRate;
        if (previousSettings.hadBedType) unit.bedType = previousSettings.bedType;
        else delete unit.bedType;
        return;
      }
      closeModal();
      render();
      showToast(enabled ? `Room ${unit.number} is set up for daily rentals.` : `Room ${unit.number} is no longer offered for daily rentals. Existing bookings are kept.`);
    } else if (event.target.id === "edit-tenant-stay-form") {
      event.preventDefault();
      const tenant = data.tenants.find((record) => record.id === event.target.dataset.tenant && record.status === "current");
      const form = new FormData(event.target);
      const startDate = String(form.get("startDate"));
      const endDate = String(form.get("endDate"));
      if (!tenant) {
        showToast("This current tenant could not be found.", true);
        return;
      }
      if (!startDate || !endDate || endDate <= startDate) {
        showToast("Enter a lease end date later than the move-in date.", true);
        return;
      }
      const otherTenantConflict = data.tenants.some((record) => record.id !== tenant.id && record.status === "current"
        && record.unitId === tenant.unitId && datesOverlap(startDate, endDate, record.startDate, record.endDate));
      const dailyConflict = data.dailyBookings.some((booking) => booking.status !== "cancelled" && booking.unitId === tenant.unitId
        && datesOverlap(startDate, endDate, booking.checkIn, booking.checkOut));
      if (otherTenantConflict || dailyConflict) {
        showToast(otherTenantConflict
          ? "Those dates overlap another current tenant in this room."
          : "Those dates overlap a confirmed daily booking. Choose dates that do not overlap.", true);
        return;
      }
      const previousDates = { startDate: tenant.startDate, endDate: tenant.endDate };
      tenant.startDate = startDate;
      tenant.endDate = endDate;
      if (!saveData()) {
        Object.assign(tenant, previousDates);
        return;
      }
      closeModal();
      render();
      showToast(`${tenant.name}’s stay dates have been updated.`);
    } else if (event.target.id === "edit-daily-stay-form") {
      event.preventDefault();
      const booking = data.dailyBookings.find((record) => record.id === event.target.dataset.booking && record.status !== "cancelled");
      const form = new FormData(event.target);
      const checkIn = String(form.get("checkIn"));
      const checkOut = String(form.get("checkOut"));
      if (!booking) {
        showToast("This active daily booking could not be found.", true);
        return;
      }
      if (!checkIn || !checkOut || checkOut <= checkIn) {
        showToast("Enter a check-out date later than the check-in date.", true);
        return;
      }
      const conflicts = dailyBookingConflicts(booking.unitId, checkIn, checkOut, booking.id);
      if (conflicts.monthlyConflict || conflicts.dailyConflict) {
        showToast(conflicts.monthlyConflict
          ? "Those dates overlap a confirmed monthly tenancy. Choose dates outside the monthly tenant’s stay."
          : "Those dates overlap another daily booking. Choose different dates.", true);
        return;
      }
      const previousDates = { checkIn: booking.checkIn, checkOut: booking.checkOut };
      booking.checkIn = checkIn;
      booking.checkOut = checkOut;
      if (!saveData()) {
        Object.assign(booking, previousDates);
        return;
      }
      closeModal();
      dailyViewMonth = checkIn.slice(0, 7);
      render();
      showToast(`${booking.guestName}’s stay dates have been updated.`);
    } else if (event.target.id === "daily-booking-form") {
      event.preventDefault();
      const form = new FormData(event.target);
      const [buildingId, unitId] = String(form.get("room")).split("|");
      const unit = getUnit(buildingId, unitId);
      const checkIn = String(form.get("checkIn"));
      const checkOut = String(form.get("checkOut"));
      const guestName = String(form.get("guestName")).trim();
      const nationality = String(form.get("nationality"));
      const passportNumber = String(form.get("passportNumber")).trim();
      const dateOfBirth = String(form.get("dateOfBirth"));
      if (!isDailyRoomConfigured(unit)) {
        showToast("That room is not currently set up for daily rentals. Please choose another room.", true);
        return;
      }
      if (!nationality || (nationality !== "Thai" && !passportNumber)) {
        showToast("Choose the guest’s nationality and enter a passport number for non-Thai guests.", true);
        return;
      }
      if (dateOfBirth && ageFromDateOfBirth(dateOfBirth) === null) {
        showToast("Enter a valid date of birth that is not in the future.", true);
        return;
      }
      if (!guestName || !checkIn || !checkOut || checkOut <= checkIn) {
        showToast("Enter the guest name and a check-out date after check-in.", true);
        return;
      }
      const conflicts = dailyBookingConflicts(unitId, checkIn, checkOut);
      if (conflicts.monthlyConflict || conflicts.dailyConflict) {
        showToast(conflicts.monthlyConflict
          ? "Those dates overlap a confirmed monthly tenancy. Choose dates outside the monthly tenant’s stay."
          : "Those dates overlap another daily booking. Choose different dates.", true);
        return;
      }
      const booking = {
        id: makeId("daily"), buildingId, unitId, guestName, nationality, passportNumber, dateOfBirth,
        phone: String(form.get("phone")).trim(), checkIn, checkOut,
        nightlyRate: Number(unit.dailyRate), bedType: unit.bedType, status: "booked"
      };
      data.dailyBookings.push(booking);
      if (!saveData()) {
        data.dailyBookings.pop();
        return;
      }
      closeModal();
      dailyViewMonth = checkIn.slice(0, 7);
      currentView = "daily";
      render();
      showToast(`Daily room booked for ${guestName} · ${formatMoney(getDailyBookingAmount(booking))} THB.`);
    } else if (event.target.id === "tenant-form") {
      event.preventDefault();
      const form = new FormData(event.target);
      const buildingId = String(form.get("buildingId"));
      const unitId = String(form.get("apartment"));
      const startDate = String(form.get("startDate"));
      const endDate = String(form.get("endDate"));
      const rent = parseMoney(form.get("rent"), true);
      const nationality = String(form.get("nationality"));
      const passportNumber = String(form.get("passportNumber")).trim();
      const dateOfBirth = String(form.get("dateOfBirth"));
      const building = getBuilding(buildingId);
      const unit = getUnit(buildingId, unitId);
      if (!unit || getCurrentTenant(unitId)) {
        showToast("That apartment is no longer available. Please choose another one.", true);
        tenantModal();
        return;
      }
      if (endDate < startDate) {
        document.getElementById("lease-end").setCustomValidity("The lease end date must be on or after the move-in date.");
        document.getElementById("lease-end").reportValidity();
        document.getElementById("lease-end").setCustomValidity("");
        return;
      }
      if (!Number.isFinite(rent) || rent < 0) {
        showToast("Enter a valid monthly rent.", true);
        return;
      }
      if (!nationality || (nationality !== "Thai" && !passportNumber)) {
        showToast("Choose the tenant’s nationality and enter a passport number for non-Thai nationals.", true);
        return;
      }
      if (dateOfBirth && ageFromDateOfBirth(dateOfBirth) === null) {
        showToast("Enter a valid date of birth that is not in the future.", true);
        return;
      }
      const dailyConflict = data.dailyBookings.some((booking) => booking.status !== "cancelled" && booking.unitId === unitId
        && datesOverlap(startDate, endDate, booking.checkIn, booking.checkOut));
      if (dailyConflict) {
        showToast("Those monthly dates overlap a confirmed daily booking. Choose another room or dates that do not overlap.", true);
        return;
      }
      const tenant = {
        id: makeId("tenant"), name: String(form.get("name")).trim(), nationality, passportNumber, dateOfBirth,
        phone: String(form.get("phone")).trim(), email: String(form.get("email")).trim(), buildingId: building.id,
        unitId, startDate, endDate, rent, extraRentals: readSelectedExtraRentals(event.target),
        notes: String(form.get("notes")).trim(), status: "current"
      };
      if (!tenant.name || !startDate || !endDate) {
        showToast("Please fill in the required tenant and rental details.", true);
        return;
      }
      data.tenants.push(tenant);
      if (!saveData()) {
        data.tenants.pop();
        return;
      }
      closeModal();
      currentView = "tenants";
      render();
      showToast(`${tenant.name} has been added to ${building.name}.`);
    } else if (event.target.id === "building-form") {
      event.preventDefault();
      const form = new FormData(event.target);
      const name = String(form.get("name")).trim();
      const address = String(form.get("address")).trim();
      const existingBuilding = event.target.dataset.building
        ? getBuilding(event.target.dataset.building)
        : null;
      if (existingBuilding) {
        if (!name || !address) {
          showToast("Please enter a building name and address.", true);
          return;
        }
        if (data.buildings.some((item) => item.id !== existingBuilding.id && item.name.toLowerCase() === name.toLowerCase())) {
          showToast("Another building already has this name.", true);
          return;
        }
        const oldName = existingBuilding.name;
        const oldAddress = existingBuilding.address;
        existingBuilding.name = name;
        existingBuilding.address = address;
        if (!saveData()) {
          existingBuilding.name = oldName;
          existingBuilding.address = oldAddress;
          return;
        }
        closeModal();
        render();
        showToast(`${existingBuilding.name} details updated.`);
        return;
      }
      const roomRows = [...event.target.querySelectorAll(".building-room-row")];
      if (!name || !address || roomRows.length < 1 || roomRows.length > 100) {
        showToast("Please enter the building details and add at least one room.", true);
        return;
      }
      const rooms = roomRows.map((row) => ({
        number: row.querySelector('[name="roomNumber"]').value.trim(),
        floor: row.querySelector('[name="roomFloor"]').value.trim(),
        rent: parseMoney(row.querySelector('[name="roomRent"]').value),
        cooling: row.querySelector('[name="roomCooling"]').value
      }));
      if (rooms.some((room) => !room.number || !room.floor || !room.cooling || !Number.isFinite(room.rent) || room.rent < 0)) {
        showToast("Please complete the room number, floor, monthly price, and room type for every room.", true);
        return;
      }
      if (new Set(rooms.map((room) => room.number.toLowerCase())).size !== rooms.length) {
        showToast("Each room number must be unique within the building.", true);
        return;
      }
      if (data.buildings.some((building) => building.name.toLowerCase() === name.toLowerCase())) {
        showToast("A building with this name already exists.", true);
        return;
      }
      const buildingId = makeId("building");
      const building = { id: buildingId, name, address, units: rooms.map((room) => ({
        id: makeId("unit"), number: room.number, bedrooms: 1, rent: room.rent, floor: room.floor, cooling: room.cooling
      })) };
      data.buildings.push(building);
      if (!saveData()) {
        data.buildings.pop();
        return;
      }
      closeModal();
      currentView = "buildings";
      render();
      showToast(`${building.name} and ${rooms.length} ${rooms.length === 1 ? "room" : "rooms"} added.`);
    } else if (event.target.id === "unit-form") {
      event.preventDefault();
      const form = new FormData(event.target);
      const building = getBuilding(event.target.dataset.building);
      const unitId = event.target.dataset.unit;
      const existingUnit = unitId ? building?.units.find((unit) => unit.id === unitId) : null;
      const number = String(form.get("number")).trim();
      const bedrooms = Number(form.get("bedrooms"));
      const floor = String(form.get("floor")).trim();
      const cooling = String(form.get("cooling"));
      const rent = parseMoney(form.get("rent"), true);
      if (!building || (unitId && !existingUnit) || !number || !Number.isInteger(bedrooms) || bedrooms < 0
        || !floor || !["ac", "fan", "none"].includes(cooling) || !Number.isFinite(rent) || rent < 0) {
        showToast("Please check the apartment details and try again.", true);
        return;
      }
      if (building.units.some((unit) => unit.id !== unitId && unit.number.toLowerCase() === number.toLowerCase())) {
        showToast("This apartment number already exists in this building.", true);
        return;
      }
      if (existingUnit) {
        const previousUnit = { ...existingUnit };
        Object.assign(existingUnit, { number, bedrooms, floor, cooling, rent });
        if (!saveData()) {
          Object.assign(existingUnit, previousUnit);
          return;
        }
      } else {
        building.units.push({ id: makeId("unit"), number, bedrooms, floor, cooling, rent });
        if (!saveData()) {
          building.units.pop();
          return;
        }
      }
      closeModal();
      render();
      showToast(existingUnit ? `Apartment ${number} details updated.` : `Apartment ${number} added to ${building.name}.`);
    } else if (event.target.id === "tenant-extras-form") {
      event.preventDefault();
      const tenant = data.tenants.find((record) => record.id === event.target.dataset.tenant && record.status === "current");
      if (!tenant) {
        showToast("This current tenant could not be found. Please refresh and try again.", true);
        return;
      }
      const previousExtras = tenant.extraRentals;
      tenant.extraRentals = readSelectedExtraRentals(event.target);
      if (!saveData()) {
        if (previousExtras === undefined) delete tenant.extraRentals;
        else tenant.extraRentals = previousExtras;
        return;
      }
      closeModal();
      render();
      showToast(`Monthly extras updated for ${tenant.name}.`);
    }
  });

  try {
    data = loadData();
    document.getElementById("today-label").textContent = "";
    render();
    if (localStorage.getItem(STORAGE_KEY) === null) saveData();
    setCloudStatus("Saved on this device");
    initializeCloud();
  } catch (error) {
    appContent.innerHTML = `<section class="panel"><div class="empty-state"><div class="empty-icon" aria-hidden="true">!</div><h3>We couldn’t open your saved records</h3><p>${escapeHtml(error.message)} Your existing records have not been changed. Please check this browser’s storage and reload the page.</p></div></section>`;
    showToast("Your saved records could not be loaded.", true);
    console.error("Haven could not load saved records:", error);
  }
})();
