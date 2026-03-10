// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyAXYwvw4yfBuKlGWFoxlzMTuSZhcBvmXWE",
  authDomain: "smart-irrigation-system-f1a43.firebaseapp.com",
  projectId: "smart-irrigation-system-f1a43",
  storageBucket: "smart-irrigation-system-f1a43.firebasestorage.app",
  messagingSenderId: "304687490129",
  appId: "1:304687490129:web:c63814c6e06bbce9420470",
  measurementId: "G-KG7PJCF9N6"
};

// Initialize Firebase
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();

// --- SETTINGS & DEFAULTS ---
const CITY = "Chennai";
const PUMP_FLOW_RATE = 5.0; // Liters per minute
const FETCH_TIMEOUT_MS = 3000;

// Default Zones
const DEFAULT_ZONES = [
    { id: 'zone1', name: 'Front Yard', ip: 'http://10.213.45.183' },
    { id: 'zone2', name: 'Greenhouse', ip: 'http://10.213.45.184' }
];

// State Management
let zones = JSON.parse(localStorage.getItem('zones')) || DEFAULT_ZONES;
let currentZoneId = localStorage.getItem('currentZoneId') || zones[0].id;
let zonesData = {};
let pollInterval, weatherInterval;
let currentMoistureValue = 0, currentTankLevel = 0;
let isAutoMode = localStorage.getItem('isAutoMode') === 'true';
let rainProbability = 0;
let customThresholds = JSON.parse(localStorage.getItem('customThresholds') || '{}');
let waterRate = parseFloat(localStorage.getItem('waterRate') || '0.05');
let usageStats = JSON.parse(localStorage.getItem('usageStats') || '{}');

const moistureCrops = {
  "Rice": { min: 70, max: 90 }, "Banana": { min: 65, max: 80 }, "Sugarcane": { min: 60, max: 75 },
  "Cotton": { min: 45, max: 60 }, "Groundnut": { min: 40, max: 55 }, "Coconut": { min: 55, max: 70 },
  "Tomato": { min: 50, max: 65 }, "Chilli": { min: 45, max: 60 }, "Turmeric": { min: 60, max: 80 },
  "Ginger": { min: 60, max: 80 }, "Papaya": { min: 60, max: 70 }, "Mango": { min: 40, max: 60 },
  "Brinjal": { min: 50, max: 65 }, "Cabbage": { min: 60, max: 75 }, "Cauliflower": { min: 60, max: 75 },
  "Carrot": { min: 55, max: 70 }, "Potato": { min: 60, max: 70 }, "Wheat": { min: 45, max: 60 },
  "Millet": { min: 40, max: 55 }, "Ragi": { min: 40, max: 55 }, "Barley": { min: 45, max: 60 },
  "Peas": { min: 55, max: 70 }, "Beans": { min: 50, max: 65 }
};

// --- CORE APP INITIALIZATION ---
auth.onAuthStateChanged(async (user) => {
    document.getElementById('loading-overlay').classList.add('hidden');
    if (user) {
        document.getElementById('auth-container').classList.add('hidden');
        document.getElementById('dashboard-screen').classList.remove('hidden');
        document.getElementById('profile-email').innerText = user.email;
        document.getElementById('profile-name').innerText = user.displayName || "User";
        document.getElementById('water-rate-input').value = waterRate;

        initializeApp();
    } else {
        document.getElementById('dashboard-screen').classList.add('hidden');
        document.getElementById('auth-container').classList.remove('hidden');
        stopSystem();
    }
});

function initializeApp() {
    applySavedTheme();
    renderZoneSelector();
    renderZonesMgmt();
    updateModeUI();
    initCharts();
    loadSchedule();
    updateUsageUI();
    loadHistory();
    loadDiaryEntries(); // Load local diary

    // Event Listeners
    const diaryBtn = document.getElementById('add-diary-entry-btn');
    if (diaryBtn) diaryBtn.onclick = handleAddDiaryEntry;

    const diaryPhotoInput = document.getElementById('diary-photo-input');
    if (diaryPhotoInput) {
        diaryPhotoInput.onchange = function() {
            const fileName = this.files[0] ? this.files[0].name : "Attach Photo";
            const label = document.getElementById('file-chosen');
            if (label) label.innerText = fileName.length > 20 ? fileName.substring(0, 17) + "..." : fileName;
        };
    }

    startSystem();
}

function applySavedTheme() {
    const theme = localStorage.getItem('theme') || 'light';
    document.body.className = theme + '-theme';
}

// --- DIARY FEATURE (LOCAL STORAGE & BASE64) ---
async function handleAddDiaryEntry() {
    const noteInput = document.getElementById('diary-note-input');
    const photoInput = document.getElementById('diary-photo-input');
    const btn = document.getElementById('add-diary-entry-btn');
    const user = auth.currentUser;

    if (!user) return alert("Error: User session not found.");
    const noteText = noteInput.value.trim();
    if (!noteText) return alert("Please enter a note.");

    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "Saving...";

    try {
        let photoBase64 = null;
        const file = photoInput.files[0];

        if (file) {
            // Convert to Base64
            photoBase64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = (e) => reject(e);
                reader.readAsDataURL(file);
            });
        }

        const newEntry = {
            id: Date.now(),
            note: noteText,
            photoURL: photoBase64,
            timestamp: new Date().toISOString()
        };

        // Save locally keyed by user UID
        const key = `diary_entries_${user.uid}`;
        const entries = JSON.parse(localStorage.getItem(key) || '[]');
        entries.unshift(newEntry);
        localStorage.setItem(key, JSON.stringify(entries));

        // Reset UI
        noteInput.value = '';
        photoInput.value = '';
        const fileLabel = document.getElementById('file-chosen');
        if (fileLabel) fileLabel.innerText = "Attach Photo";

        loadDiaryEntries(); // Refresh timeline immediately

    } catch (err) {
        console.error("Diary Save Error:", err);
        alert("Failed to save entry: " + err.message);
    } finally {
        btn.disabled = false;
        btn.innerText = originalText;
    }
}

function loadDiaryEntries() {
    const container = document.getElementById('diary-timeline-container');
    const user = auth.currentUser;
    if (!user || !container) return;

    const key = `diary_entries_${user.uid}`;
    const entries = JSON.parse(localStorage.getItem(key) || '[]');

    if (entries.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #666;">
                <i class="fas fa-book-open" style="font-size: 3rem; margin-bottom: 15px; opacity: 0.2;"></i>
                <p>No diary entries found. Add your first note above!</p>
            </div>`;
        return;
    }

    container.innerHTML = '';
    entries.forEach(data => {
        const dateStr = new Date(data.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
        const item = document.createElement('div');
        item.className = 'card diary-timeline-item';
        item.style = "position: relative; border-left: 5px solid #6a1b9a !important; margin-bottom: 20px;";
        item.innerHTML = `
            <button class="delete-entry-btn" data-id="${data.id}" style="position: absolute; top: 15px; right: 15px; background: none; border: none; color: #999; cursor: pointer;">
                <i class="fas fa-trash-alt"></i>
            </button>
            <div style="margin-bottom: 10px;">
                <small style="color: #6a1b9a; font-weight: 700;">${dateStr}</small>
            </div>
            <p style="margin-bottom: 15px; white-space: pre-wrap; color: var(--text-main); line-height: 1.6;">${data.note}</p>
            ${data.photoURL ? `<div style="border-radius: 12px; overflow: hidden; background: #eee;"><img src="${data.photoURL}" style="width: 100%; display: block; max-height: 400px; object-fit: cover;"></div>` : ''}
        `;
        container.appendChild(item);
    });

    // Delete handling
    container.querySelectorAll('.delete-entry-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            if (confirm("Delete this entry forever?")) {
                const idToDelete = parseInt(btn.dataset.id);
                const updatedEntries = entries.filter(e => e.id !== idToDelete);
                localStorage.setItem(key, JSON.stringify(updatedEntries));
                loadDiaryEntries();
            }
        };
    });
}

// --- REST OF CORE SYSTEM FUNCTIONS ---
async function fetchZoneData(zone) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(`${zone.ip}/sensor-data`, { method: 'GET', mode: 'cors', signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.ok) {
            const data = await response.json();
            if (data.pump_status === "ON") trackUsage(zone.id, 5000);
            return { id: zone.id, data: { ...data, online: true } };
        }
    } catch (err) { } finally { clearTimeout(timeoutId); }
    return { id: zone.id, data: { online: false } };
}

async function fetchAllZonesData() {
    const results = await Promise.all(zones.map(zone => fetchZoneData(zone)));
    results.forEach(res => {
        zonesData[res.id] = res.data;
        if (res.id === currentZoneId && res.data.online) {
            currentMoistureValue = res.data.soil_moisture;
            currentTankLevel = res.data.tank_level;
            updateDashboardUI(res.data);
            updateCharts(res.data.soil_moisture, res.data.temperature);
        }
    });
    renderUnifiedGrid();
    updateMoistureAdvisor();
    updateUsageUI();
    setSystemStatus(zonesData[currentZoneId]?.online || false);
}

function trackUsage(zoneId, durationMs) {
    const today = new Date().toLocaleDateString();
    if (!usageStats[today]) usageStats[today] = {};
    if (!usageStats[today][zoneId]) usageStats[today][zoneId] = 0;
    usageStats[today][zoneId] += durationMs;
    localStorage.setItem('usageStats', JSON.stringify(usageStats));
}

function updateUsageUI() {
    const today = new Date().toLocaleDateString();
    const msToday = (usageStats[today] && usageStats[today][currentZoneId]) || 0;
    const litersToday = (msToday / 60000) * PUMP_FLOW_RATE;
    const costToday = litersToday * waterRate;
    if (document.getElementById('usage-val')) document.getElementById('usage-val').innerText = `${litersToday.toFixed(1)} L`;
    if (document.getElementById('cost-val')) document.getElementById('cost-val').innerText = `₹${costToday.toFixed(2)}`;
}

function renderUnifiedGrid() {
    const grid = document.getElementById('zones-unified-grid');
    if (!grid) return;
    grid.innerHTML = zones.map(z => {
        const d = zonesData[z.id];
        const moisture = d?.online ? `${d.soil_moisture}%` : '--';
        const pump = d?.online ? (d.pump_status === 'ON' ? 'ACTIVE' : 'OFF') : 'OFFLINE';
        return `
            <div class="card sensor-card" style="padding: 15px; border-left: 5px solid ${d?.online ? 'var(--primary)' : 'var(--danger)'}">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <h4 style="margin: 0;">${z.name}</h4>
                    <span class="value ${d?.online ? 'status-on' : 'status-off'}" style="font-size: 0.7rem; padding: 2px 8px;">${d?.online ? 'ONLINE' : 'OFFLINE'}</span>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div style="text-align: left;"><small style="color: var(--text-muted);">Moisture</small><div style="font-size: 1.2rem; font-weight: 700;">${moisture}</div></div>
                    <div style="text-align: right;"><small style="color: var(--text-muted);">Pump</small><div style="font-size: 1.2rem; font-weight: 700; color: ${pump === 'ACTIVE' ? 'var(--success)' : 'inherit'}">${pump}</div></div>
                </div>
            </div>
        `;
    }).join('');
}

function renderZoneSelector() {
    const select = document.getElementById('zone-select');
    if (!select) return;
    select.innerHTML = zones.map(z => `<option value="${z.id}" ${z.id === currentZoneId ? 'selected' : ''}>${z.name}</option>`).join('');
    updateDashboardForSelectedZone();
}

function updateDashboardForSelectedZone() {
    const zone = zones.find(z => z.id === currentZoneId);
    if (zone) document.getElementById('current-zone-detail-name').innerText = `Details: ${zone.name}`;
    if (zonesData[currentZoneId]) updateDashboardUI(zonesData[currentZoneId]);
}

function updateDashboardUI(data) {
    if (!data) return;
    document.getElementById('moisture-val').innerText = `${data.soil_moisture}%`;
    document.getElementById('temp-val').innerText = `${data.temperature}°C`;
    document.getElementById('humidity-val').innerText = `${data.humidity}%`;
    document.getElementById('tank-val').innerText = `${data.tank_level}%`;
    const bar = document.getElementById('tank-progress-bar');
    if (bar) { bar.style.width = `${data.tank_level}%`; bar.style.backgroundColor = data.tank_level < 20 ? "var(--danger)" : "#0288d1"; }
    if (document.getElementById('pump-toggle')) document.getElementById('pump-toggle').checked = data.pump_status === "ON";
    document.getElementById('pump-status-text').innerText = data.pump_status === "ON" ? "PUMP ACTIVE" : "PUMP INACTIVE";
}

function setSystemStatus(online) {
    const pill = document.getElementById('connection-status');
    if (pill) pill.className = `status-pill ${online ? 'connected' : 'disconnected'}`;
    document.getElementById('status-text').innerText = online ? "Connected" : "Disconnected";
    document.getElementById('stat-esp').innerText = online ? "Online" : "Offline";
    document.getElementById('stat-esp').className = `value ${online ? 'status-on' : 'status-off'}`;
}

async function fetchWeather() {
    try {
        const res = await fetch(`https://wttr.in/${CITY}?format=j1`);
        const data = await res.json();
        const current = data.current_condition[0];
        document.getElementById('weather-temp').innerText = `${current.temp_C}°C`;
        document.getElementById('weather-desc').innerText = current.weatherDesc[0].value;
        if (data.weather && data.weather[0].hourly) {
            rainProbability = parseInt(data.weather[0].hourly[0].chanceofrain);
            document.getElementById('rain-prob').innerText = `${rainProbability}%`;
        }
        for(let i=0; i<3; i++) {
            const dayData = data.weather[i];
            const fDay = document.getElementById(`f-day-${i+1}`);
            if (fDay) fDay.innerText = i === 0 ? "Today" : (i === 1 ? "Tomorrow" : dayData.date);
            const fTemp = document.getElementById(`f-temp-${i+1}`);
            if (fTemp) fTemp.innerText = `${dayData.avgtempC}°C`;
        }
    } catch (e) {}
}

async function togglePump(zoneId, on) {
    const zone = zones.find(z => z.id === zoneId);
    if (!zone) return;
    try {
        const response = await fetch(`${zone.ip}/control-pump?status=${on ? 'ON' : 'OFF'}`, { method: 'GET' });
        if (response.ok) fetchAllZonesData();
    } catch (err) { }
}

function startSystem() {
    fetchAllZonesData(); fetchWeather();
    pollInterval = setInterval(() => { fetchAllZonesData(); checkSchedule(); }, 5000);
    weatherInterval = setInterval(fetchWeather, 600000);
}
function stopSystem() { clearInterval(pollInterval); clearInterval(weatherInterval); }

function saveSchedule() {
    const time = document.getElementById('sched-time').value;
    const duration = document.getElementById('sched-duration').value;
    if (!time || !duration) return alert("Please set time and duration");
    localStorage.setItem('activeSchedule', JSON.stringify({ time, duration, lastRun: null }));
    loadSchedule();
    alert("Timer set successfully!");
}

function loadSchedule() {
    const saved = localStorage.getItem('activeSchedule');
    const labelPara = document.querySelector('#active-schedule p');
    if (saved) {
        const schedule = JSON.parse(saved);
        document.getElementById('active-schedule').classList.remove('hidden');
        if (labelPara) labelPara.innerText = `EVERYDAY ${schedule.time}`;
        document.getElementById('sched-display-text').innerText = `${schedule.duration} MINUTES`;
    } else { document.getElementById('active-schedule').classList.add('hidden'); }
}

function checkSchedule() {
    const saved = localStorage.getItem('activeSchedule');
    if (!saved) return;
    const schedule = JSON.parse(saved);
    const now = new Date();
    const currentTime = now.getHours().toString().padStart(2, '0') + ":" + now.getMinutes().toString().padStart(2, '0');
    if (currentTime === schedule.time && schedule.lastRun !== now.toLocaleDateString()) {
        if (rainProbability > 60) {
            schedule.lastRun = now.toLocaleDateString();
            localStorage.setItem('activeSchedule', JSON.stringify(schedule));
            return;
        }
        schedule.lastRun = now.toLocaleDateString();
        localStorage.setItem('activeSchedule', JSON.stringify(schedule));
        togglePump(currentZoneId, true);
        setTimeout(() => togglePump(currentZoneId, false), schedule.duration * 60000);
    }
}

function updateMoistureAdvisor() {
    const appliedCrop = localStorage.getItem('appliedCrop');
    if (!appliedCrop) return;
    const threshold = customThresholds[appliedCrop] || moistureCrops[appliedCrop];
    document.getElementById('moisture-advisor-result').classList.remove('hidden');
    document.getElementById('m-res-crop-name').innerText = appliedCrop;
    document.getElementById('m-res-current').innerText = `${currentMoistureValue}%`;
    const statusBadge = document.getElementById('m-status-indicator');
    if (currentMoistureValue < threshold.min) { statusBadge.innerText = "Status: Soil is DRY"; statusBadge.className = "status-badge status-dry"; }
    else if (currentMoistureValue > threshold.max) { statusBadge.innerText = "Status: TOO WET"; statusBadge.className = "status-badge status-high"; }
    else { statusBadge.innerText = "Status: OPTIMAL"; statusBadge.className = "status-badge status-optimal"; }

    if (isAutoMode && rainProbability <= 60) {
        if (currentMoistureValue < threshold.min) togglePump(currentZoneId, true);
        else if (currentMoistureValue >= threshold.max) togglePump(currentZoneId, false);
    }
}

function updateModeUI() {
    if (document.getElementById('mode-status-text'))
        document.getElementById('mode-status-text').innerText = isAutoMode ? "AUTO MODE ACTIVE" : "MANUAL CONTROL";
}

function renderZonesMgmt() {
    const list = document.getElementById('zones-mgmt-list');
    if (!list) return;
    list.innerHTML = zones.map(z => `<div class="zone-mgmt-item" style="padding: 10px; background: #fff; border: 1px solid #eee; margin-bottom: 5px;"><strong>${z.name}</strong> - ${z.ip}</div>`).join('');
}

function addZone() {
    const name = document.getElementById('new-zone-name').value;
    const ip = document.getElementById('new-zone-ip').value;
    if (!name || !ip) return alert("Enter name and IP");
    zones.push({ id: 'zone_' + Date.now(), name, ip: ip.startsWith('http') ? ip : 'http://' + ip });
    localStorage.setItem('zones', JSON.stringify(zones));
    renderZoneSelector(); renderZonesMgmt();
}

// --- Universal Click Handler ---
document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.tab-btn');
    if (tabBtn) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        tabBtn.classList.add('active');
        const targetTab = tabBtn.getAttribute('data-tab');
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('hidden', content.id !== `${targetTab}-tab`);
        });
        if (targetTab === 'charts') initCharts();
        if (targetTab === 'diary') loadDiaryEntries();
    }

    if (e.target.closest('.theme-toggle-btn')) {
        const theme = e.target.closest('.theme-toggle-btn').dataset.theme;
        document.body.className = theme + '-theme';
        localStorage.setItem('theme', theme);
    }

    if (e.target.id === 'add-zone-btn') addZone();
});
