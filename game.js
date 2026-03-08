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

// Встроенная аварийная карта: игра стартует даже если внешние файлы недоступны.
const builtinMap = {
  territories: [
    { id: 1, points: [[90, 90], [350, 90], [330, 250], [100, 270]], neighbors: [2, 4] },
    { id: 2, points: [[360, 90], [620, 100], [600, 250], [340, 250]], neighbors: [1, 3, 5] },
    { id: 3, points: [[630, 110], [1060, 130], [1020, 280], [610, 250]], neighbors: [2, 6] },
    { id: 4, points: [[100, 280], [330, 260], [350, 470], [80, 490]], neighbors: [1, 5, 7] },
    { id: 5, points: [[350, 250], [600, 250], [620, 470], [350, 470]], neighbors: [2, 4, 6, 8] },
    { id: 6, points: [[610, 250], [1020, 280], [1060, 500], [620, 470]], neighbors: [3, 5, 9] },
    { id: 7, points: [[80, 500], [350, 470], [330, 700], [100, 700]], neighbors: [4, 8] },
    { id: 8, points: [[350, 470], [620, 470], [600, 700], [330, 700]], neighbors: [5, 7, 9] },
    { id: 9, points: [[620, 470], [1060, 500], [1080, 710], [600, 700]], neighbors: [6, 8] }
  ]
};

init();

async function init() {
  try {
    // 1) Локальные файлы на хостинге.
    // 2) Ссылка на публичный GeoJSON как последний fallback.
    const source = await loadAnyMap([
      'countries.geojson',
      'world.geojson',
      'map.json',
      'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson'
    ]);

    state.territories = source.territories;
    state.territories.forEach((territory) => state.territoryMap.set(territory.id, territory));

    attachEvents();
    endTurnBtn.disabled = false;
    selfTestBtn.disabled = false;

    addLog(`Карта загружена: ${source.label}. Территорий: ${state.territories.length}.`);
    addLog('Старт. Ход игрока.');
    updateStatus();
    render();
  } catch (error) {
    statusEl.textContent = `Ошибка загрузки: ${error.message}`;
    addLog('Не удалось загрузить карту. Проверьте наличие countries.geojson / world.geojson / map.json рядом с index.html.');
  }
}

async function loadAnyMap(paths) {
  for (const path of paths) {
    try {
      // Таймаут защищает от зависания загрузки на внешнем URL.
      const response = await fetchWithTimeout(path, 4500);
      if (!response.ok) continue;
      const data = await response.json();

      if (data.type === 'FeatureCollection') {
        const territories = buildTerritoriesFromGeoJson(data);
        if (territories.length > 10) return { territories, label: path };
      }

      if (Array.isArray(data.territories)) {
        const territories = buildTerritoriesFromJson(data);
        if (territories.length > 0) return { territories, label: path };
      }
    } catch {
      // Пробуем следующий источник.
    }
  }

  // Полный fallback: стартуем на встроенной карте.
  return {
    territories: buildTerritoriesFromJson(builtinMap),
    label: 'встроенная fallback-карта'
  };
}

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    cache: 'no-cache',
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
}

function buildTerritoriesFromJson(data) {
  return data.territories.map((territory, index) => {
    const points = territory.points;
    return {
      id: territory.id,
      points,
      neighbors: Array.isArray(territory.neighbors) ? territory.neighbors : [],
      owner: index % 2,
      diceCount: 2 + Math.floor(Math.random() * 3),
      center: polygonCenter(points),
      name: `Территория ${territory.id}`
    };
  });
}

function buildTerritoriesFromGeoJson(geojson) {
  const projected = projectGeoJsonUNStyle(geojson);
  createAutoNeighbors(projected, 4);

  return projected.map((territory, index) => ({
    ...territory,
    owner: index % 2,
    diceCount: 2 + Math.floor(Math.random() * 3),
    center: polygonCenter(territory.points)
  }));
}

function projectGeoJsonUNStyle(geojson) {
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2 + 20;
  const r = Math.min(w, h) * 0.43;
  const maxSouthLat = -60; // как в эмблеме ООН

  state.worldCircle = { cx, cy, r };

  const territories = [];
  let idCounter = 1;

  for (const feature of geojson.features || []) {
    const geometry = feature.geometry;
    if (!geometry) continue;

    const candidateRings = flattenGeometryRings(geometry);

    let best = null;
    for (const ring of candidateRings) {
      const filtered = ring.filter((coord) => coord[1] >= maxSouthLat);
      if (filtered.length < 4) continue;

      const stride = Math.max(1, Math.floor(filtered.length / 40));
      const projectedPoints = [];

      for (let i = 0; i < filtered.length; i += stride) {
        const [lon, lat] = filtered[i];
        const p = azimuthalEquidistantUN(lat, lon, cx, cy, r);
        if (p) projectedPoints.push(p);
      }

      if (projectedPoints.length >= 4) {
        const clean = dedupeSequentialPoints(projectedPoints);
        if (clean.length >= 4 && (!best || polygonArea(clean) > polygonArea(best))) {
          best = clean;
        }
      }
    }

    if (!best) continue;

    territories.push({
      id: idCounter++,
      points: best,
      neighbors: [],
      name: feature.properties?.ADMIN || feature.properties?.name || `T${idCounter}`
    });
  }

  return territories;
}

function flattenGeometryRings(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

function azimuthalEquidistantUN(latDeg, lonDeg, cx, cy, radius) {
  // Азимутальная равнопромежуточная проекция с центром в Северном полюсе.
  // Это база для карт, похожих на эмблему ООН.
  const lat = degToRad(latDeg);
  const lon = degToRad(lonDeg);
  const lon0 = 0; // Гринвич внизу, в духе UN-проекции

  const rho = radius * (Math.PI / 2 - lat) / (Math.PI / 2 - degToRad(-60));
  if (!Number.isFinite(rho)) return null;

  const theta = lon - lon0;
  const x = cx + rho * Math.sin(theta);
  const y = cy + rho * Math.cos(theta);

  return [x, y];
}

function dedupeSequentialPoints(points) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || distance(prev, p) > 0.75) out.push(p);
  }
  return out;
}

function createAutoNeighbors(territories, k) {
  const centers = territories.map((t) => polygonCenter(t.points));
  const boxes = territories.map((t) => bboxOfPolygon(t.points));

  for (let i = 0; i < territories.length; i++) {
    const ranked = [];
    for (let j = 0; j < territories.length; j++) {
      if (i === j) continue;
      const centerDist = distance(centers[i], centers[j]);
      const boxDist = bboxDistance(boxes[i], boxes[j]);
      const score = centerDist + boxDist * 0.85;
      ranked.push({ j, score });
    }

    ranked.sort((a, b) => a.score - b.score);
    for (const candidate of ranked.slice(0, k)) {
      const a = territories[i];
      const b = territories[candidate.j];
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
  const factor = event.deltaY < 0 ? 1.1 : 0.9;
  state.view.zoom = clamp(state.view.zoom * factor, 0.7, 3);
  render();
}

function onMouseDown(event) {
  if (event.button !== 0) return;
  state.drag = { x: event.clientX, y: event.clientY };
}

function onMouseMove(event) {
  if (!state.drag) return;
  const dx = event.clientX - state.drag.x;
  const dy = event.clientY - state.drag.y;
  state.drag = { x: event.clientX, y: event.clientY };
  state.view.panX += dx;
  state.view.panY += dy;
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

  if (clicked.owner === 0) {
    state.selectedAttackerId = clicked.diceCount > 1 ? clicked.id : null;
    render();
    return;
  }

  if (!attacker.neighbors.includes(clicked.id)) {
    addLog('Можно атаковать только соседнюю территорию.');
    return;
  }

  resolveCombat(attacker, clicked);
}

function resolveCombat(attacker, defender) {
  if (attacker.owner !== state.currentPlayer || attacker.diceCount <= 1 || defender.owner === attacker.owner) {
    state.selectedAttackerId = null;
    return;
  }

  const attackerRoll = rollDice(attacker.diceCount);
  const defenderRoll = rollDice(defender.diceCount);

  if (attackerRoll > defenderRoll) {
    const movingDice = attacker.diceCount - 1;
    defender.owner = attacker.owner;
    defender.diceCount = movingDice;
    attacker.diceCount = 1;
    addLog(`${playerName(attacker.owner)} захватил #${defender.id} (${attackerRoll} vs ${defenderRoll}).`);
  } else {
    attacker.diceCount = 1;
    addLog(`${playerName(defender.owner)} отбил атаку на #${defender.id} (${attackerRoll} vs ${defenderRoll}).`);
  }

  state.selectedAttackerId = null;
  checkGameOver();
  updateStatus();
  render();
}

function endTurn() {
  if (state.gameOver) return;

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
  if (bonus <= 0) return;

  const owned = state.territories.filter((territory) => territory.owner === playerId);
  for (let i = 0; i < bonus; i++) {
    const target = owned[Math.floor(Math.random() * owned.length)];
    if (target) target.diceCount += 1;
  }
  addLog(`${playerName(playerId)} получает подкрепление: +${bonus}.`);
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
      for (const neighborId of current.neighbors) {
        const neighbor = state.territoryMap.get(neighborId);
        if (neighbor && neighbor.owner === playerId && !visited.has(neighborId)) {
          visited.add(neighborId);
          stack.push(neighborId);
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
  addLog('Ход ИИ...');

  let attacks = 0;
  const maxAttacks = 1 + Math.floor(Math.random() * 4);

  while (!state.gameOver && attacks < maxAttacks) {
    const options = aiAttackOptions();
    if (!options.length || Math.random() < 0.35) break;

    const choice = options[Math.floor(Math.random() * options.length)];
    resolveCombat(choice.attacker, choice.defender);
    attacks += 1;
    await sleep(320);
  }

  if (!state.gameOver) {
    await sleep(160);
    endTurn();
  }

  state.aiBusy = false;
  endTurnBtn.disabled = state.currentPlayer !== 0 || state.gameOver;
}

function aiAttackOptions() {
  const options = [];
  for (const territory of state.territories) {
    if (territory.owner !== 1 || territory.diceCount <= 1) continue;
    for (const neighborId of territory.neighbors) {
      const neighbor = state.territoryMap.get(neighborId);
      if (neighbor && neighbor.owner !== 1) options.push({ attacker: territory, defender: neighbor });
    }
  }
  return options;
}

function checkGameOver() {
  const owners = new Set(state.territories.map((territory) => territory.owner));
  if (owners.size > 1) return;

  state.gameOver = true;
  const winner = [...owners][0];
  statusEl.textContent = `Игра окончена! Победитель: ${playerName(winner)}`;
  endTurnBtn.disabled = true;
  addLog(`Игра окончена! ${playerName(winner)} контролирует карту.`);
}

function updateStatus() {
  if (state.gameOver) return;
  const player = players[state.currentPlayer];
  statusEl.textContent = `Ход: ${player.name}`;
  statusEl.style.background = player.id === 0 ? '#14532d' : '#7f1d1d';
  endTurnBtn.disabled = player.id !== 0 || state.aiBusy;
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.worldCircle) {
    ctx.beginPath();
    ctx.arc(
      state.worldCircle.cx * state.view.zoom + state.view.panX,
      state.worldCircle.cy * state.view.zoom + state.view.panY,
      state.worldCircle.r * state.view.zoom,
      0,
      Math.PI * 2
    );
    ctx.fillStyle = '#06163b';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2f4c89';
    ctx.stroke();
  }

  for (const territory of state.territories) drawTerritory(territory);
  for (const territory of state.territories) drawDiceLabel(territory);
}

function drawTerritory(territory) {
  const selected = territory.id === state.selectedAttackerId;
  const ownerStyle = players[territory.owner]?.color || '#777';

  ctx.beginPath();
  territory.points.forEach(([x, y], index) => {
    const sx = x * state.view.zoom + state.view.panX;
    const sy = y * state.view.zoom + state.view.panY;
    if (index === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.closePath();

  ctx.fillStyle = ownerStyle;
  ctx.globalAlpha = selected ? 0.88 : 0.8;
  ctx.fill();
  ctx.globalAlpha = 1;

  const selectable = state.currentPlayer === 0 && !state.gameOver && territory.owner === 0 && territory.diceCount > 1;
  ctx.lineWidth = selected ? 3.6 : selectable ? 2.4 : 1;
  ctx.strokeStyle = selected ? '#ffe066' : selectable ? '#bef264' : '#203458';
  ctx.stroke();

  if (state.selectedAttackerId && state.currentPlayer === 0) {
    const attacker = getSelectedAttacker();
    if (attacker && attacker.neighbors.includes(territory.id) && territory.owner !== 0) {
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = '#facc15';
      ctx.stroke();
    }
  }
}

function drawDiceLabel(territory) {
  const [x, y] = territory.center;
  const sx = x * state.view.zoom + state.view.panX;
  const sy = y * state.view.zoom + state.view.panY;

  const radius = state.view.zoom < 0.9 ? 9 : 11;
  ctx.beginPath();
  ctx.arc(sx, sy, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#0b1b44';
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.font = state.view.zoom < 0.9 ? 'bold 13px sans-serif' : 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(territory.diceCount), sx, sy + 1);
}

function canvasToWorld(event) {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  return {
    worldX: (x - state.view.panX) / state.view.zoom,
    worldY: (y - state.view.panY) / state.view.zoom
  };
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
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }

  return inside;
}

function getSelectedAttacker() {
  if (state.selectedAttackerId == null) return null;
  return state.territoryMap.get(state.selectedAttackerId) || null;
}

function runSelfTest() {
  const hasTerritories = state.territories.length > 0;
  const allHaveNeighbors = state.territories.every((territory) => territory.neighbors.length > 0);
  const allHavePoints = state.territories.every((territory) => territory.points.length >= 3);
  const twoPlayers = new Set(state.territories.map((territory) => territory.owner)).size === 2;

  if (hasTerritories && allHaveNeighbors && allHavePoints && twoPlayers) {
    addLog('Проверка ОК: карта, соседи и начальная расстановка валидны.');
    alert('Проверка ОК ✅\nИгра работает корректно.');
  } else {
    addLog('Проверка НЕ пройдена: структура карты некорректна.');
    alert('Проверка НЕ пройдена ❌\nПроверьте files/URL карты и консоль браузера.');
  }
}

function polygonCenter(points) {
  const sum = points.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
  }
  return Math.abs(area * 0.5);
}

function bboxOfPolygon(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return { minX, minY, maxX, maxY };
}

function bboxDistance(a, b) {
  const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
  return Math.hypot(dx, dy);
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

  while (logEl.children.length > 70) {
    logEl.removeChild(logEl.lastChild);
  }
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
