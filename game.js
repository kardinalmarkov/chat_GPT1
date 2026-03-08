const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const endTurnBtn = document.getElementById('end-turn');
const currentPlayerEl = document.getElementById('current-player');
const statusEl = document.getElementById('status');

const PLAYER_COLORS = ['#22c55e', '#ef4444'];
const PLAYER_NAMES = ['Human', 'AI'];
const MAX_DICE = 8;

const game = {
  territories: [],
  currentPlayer: 0,
  selectedSource: null,
  winner: null,
  isBusy: true,
  view: {
    zoom: 1,
    minZoom: 0.7,
    maxZoom: 2.0,
    offsetX: 0,
    offsetY: 0,
    panning: false,
    lastX: 0,
    lastY: 0
  }
};

function setStatus(message) {
  statusEl.textContent = message;
}

function territoryById(id) {
  return game.territories.find((t) => t.id === id) || null;
}

function getCenter(points) {
  const sum = points.reduce((acc, p) => {
    acc.x += p[0];
    acc.y += p[1];
    return acc;
  }, { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0], yi = points[i][1];
    const xj = points[j][0], yj = points[j][1];
    const intersect = ((yi > y) !== (yj > y))
      && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function getSelectableTargets() {
  if (!game.selectedSource) return [];
  return game.selectedSource.neighbors
    .map((id) => territoryById(id))
    .filter((t) => t && t.owner !== game.currentPlayer);
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(game.view.offsetX, game.view.offsetY);
  ctx.scale(game.view.zoom, game.view.zoom);

  const selectableTargets = new Set(getSelectableTargets().map((t) => t.id));

  for (const territory of game.territories) {
    const isOwned = territory.owner === game.currentPlayer;
    const selectable = game.currentPlayer === 0 && isOwned && territory.diceCount > 1;
    const selected = game.selectedSource && game.selectedSource.id === territory.id;
    const isTarget = selectableTargets.has(territory.id);

    ctx.beginPath();
    territory.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    });
    ctx.closePath();

    ctx.fillStyle = PLAYER_COLORS[territory.owner] || '#64748b';
    ctx.fill();

    ctx.lineWidth = selected ? 6 : (isTarget ? 5 : (selectable ? 4 : 2));
    ctx.strokeStyle = selected ? '#fde047' : (isTarget ? '#e2e8f0' : (selectable ? '#a3e635' : '#0b1020'));
    ctx.stroke();

    const center = getCenter(territory.points);
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(center.x, center.y, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 18px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(territory.diceCount), center.x, center.y + 1);
  }

  ctx.restore();

  currentPlayerEl.textContent = `Current: ${PLAYER_NAMES[game.currentPlayer]}`;
  currentPlayerEl.style.background = game.currentPlayer === 0 ? '#14532d' : '#7f1d1d';
  endTurnBtn.disabled = game.currentPlayer !== 0 || game.winner !== null || game.isBusy;
}

function screenToWorld(x, y) {
  return {
    x: (x - game.view.offsetX) / game.view.zoom,
    y: (y - game.view.offsetY) / game.view.zoom
  };
}

function getTerritoryAt(x, y) {
  const world = screenToWorld(x, y);
  return game.territories.find((t) => pointInPolygon(world.x, world.y, t.points)) || null;
}

function rollDice(count) {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += Math.floor(Math.random() * 6) + 1;
  }
  return sum;
}

function resolveAttack(source, target, attacker) {
  const attackDice = source.diceCount;
  const defendDice = target.diceCount;
  const attackSum = rollDice(attackDice);
  const defendSum = rollDice(defendDice);

  if (attackSum > defendSum) {
    const moved = Math.max(1, source.diceCount - 1);
    source.diceCount = 1;
    target.owner = attacker;
    target.diceCount = moved;
    setStatus(`${PLAYER_NAMES[attacker]} won ${attackSum} vs ${defendSum} and captured territory ${target.id}.`);
  } else {
    source.diceCount = 1;
    setStatus(`${PLAYER_NAMES[attacker]} lost ${attackSum} vs ${defendSum}.`);
  }
}

function getOwned(player) {
  return game.territories.filter((t) => t.owner === player);
}

function getLargestConnectedRegionSize(player) {
  const ownedIds = new Set(getOwned(player).map((t) => t.id));
  let best = 0;
  const visited = new Set();

  for (const id of ownedIds) {
    if (visited.has(id)) continue;
    let size = 0;
    const queue = [id];
    visited.add(id);

    while (queue.length) {
      const current = queue.shift();
      size++;
      const territory = territoryById(current);
      for (const n of territory.neighbors) {
        if (ownedIds.has(n) && !visited.has(n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
    best = Math.max(best, size);
  }

  return best;
}

function reinforce(player) {
  const reinforcement = getLargestConnectedRegionSize(player);
  const owned = getOwned(player);
  if (!owned.length || reinforcement <= 0) return;

  for (let i = 0; i < reinforcement; i++) {
    const candidates = owned.filter((t) => t.diceCount < MAX_DICE);
    if (!candidates.length) break;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    pick.diceCount += 1;
  }

  setStatus(`${PLAYER_NAMES[player]} reinforced with ${reinforcement} dice.`);
}

function checkWinner() {
  const owners = new Set(game.territories.map((t) => t.owner));
  if (owners.size === 1) {
    game.winner = game.territories[0].owner;
    game.isBusy = true;
    setStatus(`${PLAYER_NAMES[game.winner]} wins the game!`);
    return true;
  }
  return false;
}

function getValidAttacks(player) {
  const attacks = [];
  for (const t of game.territories) {
    if (t.owner !== player || t.diceCount <= 1) continue;
    for (const neighborId of t.neighbors) {
      const n = territoryById(neighborId);
      if (n && n.owner !== player) {
        attacks.push({ source: t, target: n });
      }
    }
  }
  return attacks;
}

function endTurn() {
  reinforce(game.currentPlayer);
  if (checkWinner()) {
    render();
    return;
  }

  game.selectedSource = null;
  game.currentPlayer = (game.currentPlayer + 1) % 2;
  game.isBusy = game.currentPlayer === 1;
  render();

  if (game.currentPlayer === 1) {
    setTimeout(runAiTurn, 550);
  }
}

function runAiTurn() {
  let steps = 0;

  const loop = () => {
    if (game.winner !== null) return;

    const valid = getValidAttacks(1);
    const shouldEnd = !valid.length || Math.random() < 0.35 || steps > 20;
    if (shouldEnd) {
      game.isBusy = false;
      endTurn();
      return;
    }

    const pick = valid[Math.floor(Math.random() * valid.length)];
    resolveAttack(pick.source, pick.target, 1);
    steps += 1;

    if (checkWinner()) {
      render();
      return;
    }

    render();
    setTimeout(loop, 600);
  };

  loop();
}

function handleBoardClick(event) {
  if (game.currentPlayer !== 0 || game.winner !== null || game.isBusy) return;

  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const y = (event.clientY - rect.top) * (canvas.height / rect.height);
  const clicked = getTerritoryAt(x, y);

  if (!clicked) {
    game.selectedSource = null;
    render();
    return;
  }

  if (!game.selectedSource) {
    if (clicked.owner === 0 && clicked.diceCount > 1) {
      game.selectedSource = clicked;
      setStatus(`Selected territory ${clicked.id}. Choose an adjacent enemy territory to attack.`);
    }
    render();
    return;
  }

  if (clicked.id === game.selectedSource.id) {
    game.selectedSource = null;
    setStatus('Selection cleared.');
    render();
    return;
  }

  const isNeighbor = game.selectedSource.neighbors.includes(clicked.id);
  if (isNeighbor && clicked.owner !== 0) {
    resolveAttack(game.selectedSource, clicked, 0);
    if (!checkWinner() && game.selectedSource.diceCount <= 1) {
      game.selectedSource = null;
    }
    render();
    return;
  }

  if (clicked.owner === 0 && clicked.diceCount > 1) {
    game.selectedSource = clicked;
    setStatus(`Selected territory ${clicked.id}.`);
  }

  render();
}

function attachPanZoom() {
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = Math.sign(e.deltaY) * -0.1;
    const newZoom = Math.min(game.view.maxZoom, Math.max(game.view.minZoom, game.view.zoom + delta));
    if (newZoom === game.view.zoom) return;

    const rect = canvas.getBoundingClientRect();
    const sx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const sy = (e.clientY - rect.top) * (canvas.height / rect.height);

    const wx = (sx - game.view.offsetX) / game.view.zoom;
    const wy = (sy - game.view.offsetY) / game.view.zoom;

    game.view.zoom = newZoom;
    game.view.offsetX = sx - wx * game.view.zoom;
    game.view.offsetY = sy - wy * game.view.zoom;
    render();
  }, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    game.view.panning = true;
    game.view.lastX = e.clientX;
    game.view.lastY = e.clientY;
  });

  window.addEventListener('mouseup', () => {
    game.view.panning = false;
  });

  window.addEventListener('mousemove', (e) => {
    if (!game.view.panning) return;
    const dx = (e.clientX - game.view.lastX) * (canvas.width / canvas.getBoundingClientRect().width);
    const dy = (e.clientY - game.view.lastY) * (canvas.height / canvas.getBoundingClientRect().height);
    game.view.lastX = e.clientX;
    game.view.lastY = e.clientY;
    game.view.offsetX += dx;
    game.view.offsetY += dy;
    render();
  });
}

async function loadMap() {
  const response = await fetch('map.json');
  if (!response.ok) throw new Error(`Failed map load (${response.status})`);
  const data = await response.json();
  if (!data.territories || !Array.isArray(data.territories)) {
    throw new Error('Invalid map format');
  }

  game.territories = data.territories.map((t) => ({
    id: t.id,
    points: t.points,
    neighbors: t.neighbors,
    owner: t.owner ?? Math.floor(Math.random() * 2),
    diceCount: t.diceCount ?? 1
  }));
}

async function init() {
  try {
    await loadMap();
    game.isBusy = false;
    setStatus('Your turn. Attack as many times as you like, then press End Turn.');
    render();
  } catch (err) {
    setStatus(`Could not load map.json: ${err.message}`);
    console.error(err);
  }
}

canvas.addEventListener('click', handleBoardClick);
endTurnBtn.addEventListener('click', endTurn);
attachPanZoom();
init();
