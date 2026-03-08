const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const endTurnBtn = document.getElementById('endTurnBtn');
const selfTestBtn = document.getElementById('selfTestBtn');

const players = [
  { id: 0, name: 'Игрок', color: '#34c759' },
  { id: 1, name: 'ИИ', color: '#ff4d4f' }
];

const SELECTED_COUNTRIES = [
  'United States of America',
  'Russia',
  'China',
  'India',
  'Pakistan',
  'France',
  'United Kingdom',
  'Israel',
  'North Korea',
  'Iran',
  'Germany',
  'Brazil'
];

const COUNTRY_ALIASES = {
  'Russian Federation': 'Russia',
  'Dem. Rep. Korea': 'North Korea',
  'Korea, North': 'North Korea',
  'Iran (Islamic Republic of)': 'Iran',
  'Iran, Islamic Republic of': 'Iran',
  'United States': 'United States of America'
};

const state = {
  territories: [],
  territoryMap: new Map(),
  currentPlayer: 0,
  selectedAttackerId: null,
  gameOver: false,
  aiBusy: false,
  drag: null,
  view: { zoom: 1, panX: 0, panY: 0 },
  worldCircle: null
};

init();

async function init() {
  try {
    const loaded = await loadAnyMap(['countries.geojson']);
    state.territories = loaded;
    state.territoryMap.clear();
    state.territories.forEach((territory) => state.territoryMap.set(territory.id, territory));

    attachEvents();
    endTurnBtn.disabled = false;
    selfTestBtn.disabled = false;
    addLog('Карта загружена: 12 стран (ядерные + крупные).');
    addLog('Старт игры. Ваш ход.');
    updateStatus();
    render();
  } catch (error) {
    statusEl.textContent = `Ошибка: ${error.message}`;
    addLog('Ошибка загрузки карты. Откройте консоль браузера для деталей.');
  }
}

async function loadAnyMap(paths) {
  for (const path of paths) {
    try {
      const response = await fetchWithTimeout(path, 4000);
      if (!response.ok) continue;
      const data = await response.json();
      if (data.type === 'FeatureCollection') {
        const territories = buildTerritoriesFromGeoJson(data);
        if (territories.length === 12) return territories;
      }
    } catch {
      // пробуем следующий источник
    }
  }

  // fallback: встроенный GeoJSON на 12 стран, чтобы игра всегда запускалась.
  return buildTerritoriesFromGeoJson(buildBuiltinGeoJson12());
}

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { cache: 'no-cache', signal: controller.signal }).finally(() => clearTimeout(timer));
}

function buildTerritoriesFromGeoJson(geojson) {
  const selected = selectWantedFeatures(geojson.features || []);
  const projected = selected
    .map((feature, index) => {
      const points = projectFeatureToWorldPolygon(feature);
      if (!points || points.length < 3) return null;
      return {
        id: index + 1,
        name: normalizeCountryName(feature.properties?.ADMIN || feature.properties?.name || `Страна ${index + 1}`),
        points,
        neighbors: [],
        owner: index % 2,
        diceCount: 3
      };
    })
    .filter(Boolean);

  createAutoNeighbors(projected, 3);

  projected.forEach((territory) => {
    territory.center = polygonCenter(territory.points);
    territory.diceCount = 2 + Math.floor(Math.random() * 3);
  });

  return projected;
}

function selectWantedFeatures(features) {
  const normalizedWanted = new Set(SELECTED_COUNTRIES.map((name) => normalizeCountryName(name)));
  const selected = [];

  for (const feature of features) {
    const raw = feature.properties?.ADMIN || feature.properties?.name;
    const normalized = normalizeCountryName(raw || '');
    if (normalizedWanted.has(normalized)) selected.push(feature);
  }

  // если чего-то не нашли, дозаполняем первыми странами, но до 12
  if (selected.length < 12) {
    for (const feature of features) {
      if (selected.length >= 12) break;
      if (!selected.includes(feature)) selected.push(feature);
    }
  }

  return selected.slice(0, 12);
}

function normalizeCountryName(name) {
  return COUNTRY_ALIASES[name] || name;
}

function projectFeatureToWorldPolygon(feature) {
  const rings = flattenGeometryRings(feature.geometry);
  if (!rings.length) return null;

  let best = null;
  for (const ring of rings) {
    const cleaned = ring.filter((coord) => Array.isArray(coord) && coord.length >= 2);
    if (cleaned.length < 4) continue;

    const stride = Math.max(1, Math.floor(cleaned.length / 50));
    const points = [];

    for (let i = 0; i < cleaned.length; i += stride) {
      const [lon, lat] = cleaned[i];
      const p = projectLonLatToWorld(lat, lon);
      if (p) points.push(p);
    }

    const deduped = dedupeSequentialPoints(points);
    if (deduped.length >= 3 && (!best || polygonArea(deduped) > polygonArea(best))) {
      best = deduped;
    }
  }

  return best;
}

function projectLonLatToWorld(latDeg, lonDeg) {
  // Обычная карта мира: эквидистантная цилиндрическая проекция (plate carrée).
  const lon = ((lonDeg + 180) % 360 + 360) % 360 - 180;
  const lat = Math.max(-85, Math.min(85, latDeg));

  const marginX = 70;
  const marginY = 60;
  const mapW = canvas.width - marginX * 2;
  const mapH = canvas.height - marginY * 2;

  const x = marginX + ((lon + 180) / 360) * mapW;
  const y = marginY + ((90 - lat) / 180) * mapH;

  return [x, y];
}

function flattenGeometryRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates || [];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).flat();
  return [];
}

function dedupeSequentialPoints(points) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || distance(prev, p) > 1) out.push(p);
  }
  return out;
}

function createAutoNeighbors(territories, k) {
  const centers = territories.map((t) => polygonCenter(t.points));
  for (let i = 0; i < territories.length; i++) {
    const nearest = [];
    for (let j = 0; j < territories.length; j++) {
      if (i === j) continue;
      nearest.push({ id: territories[j].id, d: distance(centers[i], centers[j]) });
    }
    nearest.sort((a, b) => a.d - b.d);
    for (const n of nearest.slice(0, k)) {
      const a = territories[i];
      const b = territories.find((t) => t.id === n.id);
      if (!a.neighbors.includes(b.id)) a.neighbors.push(b.id);
      if (!b.neighbors.includes(a.id)) b.neighbors.push(a.id);
    }
  }
}

function attachEvents() {
  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('wheel', onWheelZoom, { passive: false });
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  endTurnBtn.addEventListener('click', () => {
    if (state.currentPlayer !== 0 || state.gameOver || state.aiBusy) return;
    endTurn();
  });

  selfTestBtn.addEventListener('click', runSelfTest);
}

function onWheelZoom(event) {
  event.preventDefault();
  state.view.zoom = clamp(state.view.zoom * (event.deltaY < 0 ? 1.08 : 0.92), 0.7, 2.5);
  render();
}

function onMouseDown(event) {
  if (event.button !== 0) return;
  state.drag = { x: event.clientX, y: event.clientY };
}

function onMouseMove(event) {
  if (!state.drag) return;
  state.view.panX += event.clientX - state.drag.x;
  state.view.panY += event.clientY - state.drag.y;
  state.drag = { x: event.clientX, y: event.clientY };
  render();
}

function onMouseUp() {
  state.drag = null;
}

function onCanvasClick(event) {
  if (state.currentPlayer !== 0 || state.gameOver || state.aiBusy) return;

  const { worldX, worldY } = canvasToWorld(event);
  const clicked = territoryAtPoint(worldX, worldY);
  if (!clicked) return;

  if (clicked.owner === 0 && clicked.diceCount > 1) {
    state.selectedAttackerId = clicked.id;
    render();
    return;
  }

  const attacker = getSelectedAttacker();
  if (!attacker) return;
  if (clicked.owner === 0) return;
  if (!attacker.neighbors.includes(clicked.id)) {
    addLog('Атаковать можно только соседа.');
    return;
  }

  resolveCombat(attacker, clicked);
}

function resolveCombat(attacker, defender) {
  const attackerRoll = rollDice(attacker.diceCount);
  const defenderRoll = rollDice(defender.diceCount);

  if (attackerRoll > defenderRoll) {
    defender.owner = attacker.owner;
    defender.diceCount = attacker.diceCount - 1;
    attacker.diceCount = 1;
    addLog(`${playerName(attacker.owner)} захватил ${defender.name} (${attackerRoll} vs ${defenderRoll}).`);
  } else {
    attacker.diceCount = 1;
    addLog(`${playerName(defender.owner)} отбил атаку на ${defender.name} (${attackerRoll} vs ${defenderRoll}).`);
  }

  state.selectedAttackerId = null;
  checkGameOver();
  updateStatus();
  render();
}

function endTurn() {
  applyReinforcement(state.currentPlayer);
  state.currentPlayer = (state.currentPlayer + 1) % players.length;
  state.selectedAttackerId = null;
  updateStatus();
  render();
  checkGameOver();
  if (state.currentPlayer === 1 && !state.gameOver) runAiTurn();
}

function applyReinforcement(playerId) {
  const bonus = largestConnectedRegionSize(playerId);
  const owned = state.territories.filter((territory) => territory.owner === playerId);
  for (let i = 0; i < bonus; i++) {
    const target = owned[Math.floor(Math.random() * owned.length)];
    if (target) target.diceCount += 1;
  }
  addLog(`${playerName(playerId)} получает +${bonus} подкрепления.`);
}

function largestConnectedRegionSize(playerId) {
  const visited = new Set();
  let largest = 0;

  for (const territory of state.territories) {
    if (territory.owner !== playerId || visited.has(territory.id)) continue;
    let size = 0;
    const stack = [territory.id];
    visited.add(territory.id);

    while (stack.length) {
      const id = stack.pop();
      size += 1;
      const current = state.territoryMap.get(id);
      for (const nId of current.neighbors) {
        const n = state.territoryMap.get(nId);
        if (n && n.owner === playerId && !visited.has(nId)) {
          visited.add(nId);
          stack.push(nId);
        }
      }
    }
    largest = Math.max(largest, size);
  }

  return largest;
}

async function runAiTurn() {
  state.aiBusy = true;
  endTurnBtn.disabled = true;

  let attacks = 0;
  const maxAttacks = 1 + Math.floor(Math.random() * 3);
  while (attacks < maxAttacks && !state.gameOver) {
    const options = aiAttackOptions();
    if (!options.length || Math.random() < 0.35) break;
    const choice = options[Math.floor(Math.random() * options.length)];
    resolveCombat(choice.attacker, choice.defender);
    attacks += 1;
    await sleep(300);
  }

  if (!state.gameOver) {
    await sleep(220);
    endTurn();
  }

  state.aiBusy = false;
  endTurnBtn.disabled = state.currentPlayer !== 0 || state.gameOver;
}

function aiAttackOptions() {
  const options = [];
  for (const territory of state.territories) {
    if (territory.owner !== 1 || territory.diceCount <= 1) continue;
    for (const nId of territory.neighbors) {
      const n = state.territoryMap.get(nId);
      if (n && n.owner !== 1) options.push({ attacker: territory, defender: n });
    }
  }
  return options;
}

function checkGameOver() {
  const owners = new Set(state.territories.map((territory) => territory.owner));
  if (owners.size > 1) return;
  state.gameOver = true;
  const winner = [...owners][0];
  statusEl.textContent = `Игра окончена: ${playerName(winner)}`;
  endTurnBtn.disabled = true;
}

function updateStatus() {
  if (state.gameOver) return;
  const p = players[state.currentPlayer];
  statusEl.textContent = `Ход: ${p.name}`;
  statusEl.style.background = p.id === 0 ? '#14532d' : '#7f1d1d';
  endTurnBtn.disabled = p.id !== 0 || state.aiBusy;
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawWorldBackground();

  for (const territory of state.territories) drawTerritory(territory);
  for (const territory of state.territories) {
    drawDiceLabel(territory);
    drawCountryName(territory);
  }
}


function drawWorldBackground() {
  const marginX = 70;
  const marginY = 60;
  const mapW = canvas.width - marginX * 2;
  const mapH = canvas.height - marginY * 2;

  const x = marginX * state.view.zoom + state.view.panX;
  const y = marginY * state.view.zoom + state.view.panY;
  const w = mapW * state.view.zoom;
  const h = mapH * state.view.zoom;

  ctx.fillStyle = '#071a44';
  ctx.fillRect(x, y, w, h);

  ctx.strokeStyle = '#2f4c89';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);

  ctx.strokeStyle = 'rgba(122, 156, 218, 0.35)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const yy = y + (h / 6) * i;
    ctx.beginPath();
    ctx.moveTo(x, yy);
    ctx.lineTo(x + w, yy);
    ctx.stroke();
  }
  for (let i = 1; i < 12; i++) {
    const xx = x + (w / 12) * i;
    ctx.beginPath();
    ctx.moveTo(xx, y);
    ctx.lineTo(xx, y + h);
    ctx.stroke();
  }
}

function drawTerritory(territory) {
  const selected = territory.id === state.selectedAttackerId;

  ctx.beginPath();
  territory.points.forEach(([x, y], i) => {
    const sx = x * state.view.zoom + state.view.panX;
    const sy = y * state.view.zoom + state.view.panY;
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.closePath();

  ctx.fillStyle = players[territory.owner].color;
  ctx.globalAlpha = selected ? 0.9 : 0.82;
  ctx.fill();
  ctx.globalAlpha = 1;

  const selectable = state.currentPlayer === 0 && territory.owner === 0 && territory.diceCount > 1;
  ctx.strokeStyle = selected ? '#ffe066' : selectable ? '#bef264' : '#203458';
  ctx.lineWidth = selected ? 3.5 : selectable ? 2.2 : 1;
  ctx.stroke();
}

function drawDiceLabel(territory) {
  const [x, y] = territory.center;
  const sx = x * state.view.zoom + state.view.panX;
  const sy = y * state.view.zoom + state.view.panY;

  ctx.beginPath();
  ctx.arc(sx, sy, 12, 0, Math.PI * 2);
  ctx.fillStyle = '#0b1b44';
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(territory.diceCount), sx, sy + 1);
}


function drawCountryName(territory) {
  const [x, y] = territory.center;
  const sx = x * state.view.zoom + state.view.panX;
  const sy = y * state.view.zoom + state.view.panY + 18;

  ctx.fillStyle = '#d7e3ff';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const short = territory.name
    .replace('United States of America', 'USA')
    .replace('United Kingdom', 'UK');
  ctx.fillText(short, sx, sy);
}
function canvasToWorld(event) {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  return { worldX: (x - state.view.panX) / state.view.zoom, worldY: (y - state.view.panY) / state.view.zoom };
}

function territoryAtPoint(x, y) {
  for (const territory of state.territories) {
    if (pointInPolygon([x, y], territory.points)) return territory;
  }
  return null;
}

function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function getSelectedAttacker() {
  if (state.selectedAttackerId == null) return null;
  return state.territoryMap.get(state.selectedAttackerId) || null;
}

function runSelfTest() {
  const ok =
    state.territories.length === 12 &&
    state.territories.every((territory) => territory.points.length >= 3) &&
    state.territories.every((territory) => territory.neighbors.length > 0);

  if (ok) {
    addLog('Проверка ОК: карта (12 стран) и соседи валидны.');
    alert('Проверка ОК ✅');
  } else {
    addLog('Проверка НЕ пройдена: карта загружена некорректно.');
    alert('Проверка НЕ пройдена ❌');
  }
}

function buildBuiltinGeoJson12() {
  const r = (name, points) => ({
    type: 'Feature',
    properties: { ADMIN: name },
    geometry: { type: 'Polygon', coordinates: [points] }
  });

  return {
    type: 'FeatureCollection',
    features: [
      r('United States of America', [[-124,32],[-124,42],[-122,48],[-111,49],[-103,49],[-95,49],[-88,48],[-83,46],[-75,45],[-67,44],[-69,41],[-74,40],[-77,36],[-81,31],[-90,29],[-98,27],[-106,30],[-114,32],[-124,32]]),
      r('Russia', [[30,59],[35,64],[44,68],[55,70],[72,72],[92,73],[112,72],[130,69],[146,67],[160,65],[170,62],[160,57],[148,55],[136,54],[122,53],[106,55],[90,57],[74,59],[58,58],[45,57],[30,59]]),
      r('China', [[74,18],[80,26],[86,31],[94,34],[102,38],[112,42],[122,45],[132,47],[134,42],[128,36],[121,31],[113,24],[106,21],[98,20],[90,22],[84,24],[79,23],[74,18]]),
      r('India', [[68,24],[73,28],[78,32],[83,34],[88,30],[90,25],[89,21],[86,16],[82,9],[78,8],[74,12],[71,18],[68,24]]),
      r('Pakistan', [[61,25],[64,29],[68,35],[73,36],[77,33],[75,29],[72,26],[69,24],[65,24],[61,25]]),
      r('France', [[-5,43],[-1,48],[2,50],[7,49],[8,46],[6,44],[3,43],[1,42],[-2,43],[-5,43]]),
      r('United Kingdom', [[-7,50],[-6,54],[-5,57],[-2,59],[0,57],[1,54],[-1,52],[-3,50],[-5,50],[-7,50]]),
      r('Israel', [[34.2,29.5],[34.4,31.0],[34.7,32.2],[35.2,33.0],[35.6,32.5],[35.4,31.3],[35.1,30.2],[34.8,29.6],[34.2,29.5]]),
      r('North Korea', [[124,38],[126,40],[128,42],[130,43],[130.5,41.5],[129,40],[127.5,39],[126,38.3],[124,38]]),
      r('Iran', [[44,26],[47,31],[50,35],[54,38],[59,39],[63,37],[62,32],[60,28],[56,26],[51,25],[47,25],[44,26]]),
      r('Germany', [[6,47],[8,49],[10,51],[13,54],[15,53],[14,50],[13,48],[11,47],[9,47],[7,47],[6,47]]),
      r('Brazil', [[-74,-33],[-69,-20],[-66,-10],[-60,-3],[-54,2],[-48,4],[-41,0],[-35,-6],[-38,-14],[-42,-20],[-46,-24],[-51,-29],[-58,-31],[-66,-32],[-74,-33]])
    ]
  };
}

function polygonCenter(points) {
  const sum = points.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(area / 2);
}

function rollDice(count) {
  let sum = 0;
  for (let i = 0; i < count; i++) sum += 1 + Math.floor(Math.random() * 6);
  return sum;
}

function playerName(id) {
  return players[id]?.name || `Игрок ${id}`;
}

function addLog(message) {
  const entry = document.createElement('p');
  entry.className = 'log-entry';
  entry.textContent = message;
  logEl.prepend(entry);
  while (logEl.children.length > 60) logEl.removeChild(logEl.lastChild);
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
