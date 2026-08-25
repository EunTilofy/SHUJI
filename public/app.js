/* global io */
'use strict';

const socket = io();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { mode: 'solo', room: null, selectedResultPlayer: null };

const elements = {
  home: $('#homeView'), game: $('#gameView'), lobby: $('#lobbyView'), play: $('#playView'),
  results: $('#resultsView'), startForm: $('#startForm'), startButton: $('#startButton'),
  name: $('#nameInput'), code: $('#codeInput'), targets: $('#targetInput'), length: $('#lengthInput'),
  targetValue: $('#targetValue'), lengthValue: $('#lengthValue'), roundPreview: $('#roundPreview'),
  roomLabel: $('#roomLabel'), roundNow: $('#roundNow'), roundLimit: $('#roundLimit'),
  solvedNow: $('#solvedNow'), targetCount: $('#targetCount'), lobbyPlayers: $('#lobbyPlayerList'),
  lobbyCount: $('#lobbyCount'), copyCode: $('#copyCode'), begin: $('#beginButton'),
  waiting: $('#waitingText'), boards: $('#boards'), status: $('#statusStrip'),
  guessForm: $('#guessForm'), guessInput: $('#guessInput'), guessLength: $('#guessLength'),
  resultTabs: $('#resultTabs'), resultBoards: $('#resultBoards'), answers: $('#answers'),
  dialog: $('#infoDialog'), dialogContent: $('#dialogContent'), toast: $('#toast')
};

function calculateRoundLimit(targetCount, length) {
  return Math.min(24, Math.max(6, targetCount + Math.ceil(Math.log2(length)) + 3));
}

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { elements.toast.className = 'toast'; }, 2400);
}

function request(event, payload) {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (response) => {
      if (response?.ok) resolve(response);
      else reject(new Error(response?.error || '网络连接失败'));
    });
  });
}

async function loadFixedIdentity() {
  try {
    const response = await request('identity:get', {});
    if (!response.name) return;
    elements.name.value = response.name;
    $('#fixedIdentityName').textContent = response.name;
    $('#identityField').classList.add('hidden');
    $('#fixedIdentity').classList.remove('hidden');
  } catch {
    // The editable field remains available if identity lookup is temporarily unavailable.
  }
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function updatePreview() {
  elements.targetValue.textContent = elements.targets.value;
  elements.lengthValue.textContent = elements.length.value;
  elements.roundPreview.textContent = calculateRoundLimit(Number(elements.targets.value), Number(elements.length.value));
}

function showGame() {
  elements.home.classList.add('hidden');
  elements.game.classList.remove('hidden');
}

function setBoardSize(room) {
  const available = Math.min(window.innerWidth - 48, 1240);
  const boardGaps = Math.max(0, room.targetCount - 1) * 12;
  const cellGaps = room.targetCount * Math.max(0, room.length - 1) * 2;
  const size = Math.max(18, Math.min(28,
    Math.floor((available - boardGaps - cellGaps) / (room.targetCount * room.length))));
  elements.boards.style.setProperty('--tile-size', `${size}px`);
  elements.resultBoards.style.setProperty('--tile-size', `${size}px`);
}

function createTileRow(value, feedback, length, locked = false) {
  const row = document.createElement('div');
  row.className = 'board-row';
  row.style.setProperty('--length', length);
  for (let index = 0; index < length; index += 1) {
    const tile = document.createElement('div');
    tile.className = `tile ${feedback?.[index] || (locked ? 'locked' : '')}`;
    tile.textContent = feedback ? value[index] : '';
    row.appendChild(tile);
  }
  return row;
}

function renderBoards(container, player, room) {
  container.replaceChildren();
  for (let targetIndex = 0; targetIndex < room.targetCount; targetIndex += 1) {
    const board = document.createElement('section');
    board.className = `board${player.solved[targetIndex] ? ' solved' : ''}`;
    const title = document.createElement('div');
    title.className = 'board-title';
    const solvedLabel = player.solved[targetIndex] ? `<b>第 ${player.solvedAt[targetIndex]} 轮找到</b>` : '';
    title.innerHTML = `<span>轨迹 ${String(targetIndex + 1).padStart(2, '0')}</span>${solvedLabel}`;
    const grid = document.createElement('div');
    grid.className = 'board-grid';
    let solvedBefore = false;

    for (let round = 0; round < room.roundLimit; round += 1) {
      const guess = player.guesses?.[round];
      const feedback = guess?.feedback?.[targetIndex];
      if (feedback) {
        grid.appendChild(createTileRow(guess.value, feedback, room.length));
        if (feedback.every((item) => item === 'correct')) solvedBefore = true;
      } else {
        grid.appendChild(createTileRow('', null, room.length, solvedBefore));
      }
    }
    board.append(title, grid);
    container.appendChild(board);
  }
}

function renderLobby(room) {
  elements.lobby.classList.remove('hidden');
  elements.play.classList.add('hidden');
  elements.results.classList.add('hidden');
  elements.copyCode.textContent = room.code;
  elements.lobbyCount.textContent = room.players.length;
  elements.lobbyPlayers.replaceChildren();
  room.players.forEach((player) => {
    const pill = document.createElement('span');
    pill.className = `player-pill${player.id === room.hostId ? ' host' : ''}${player.connected ? '' : ' offline'}`;
    pill.textContent = player.name;
    elements.lobbyPlayers.appendChild(pill);
  });
  const isHost = room.viewerId === room.hostId;
  elements.begin.classList.toggle('hidden', !isHost);
  elements.waiting.classList.toggle('hidden', isHost);
}

function renderStatus(room) {
  elements.status.replaceChildren();
  room.players.forEach((player, index) => {
    const chip = document.createElement('div');
    chip.className = `rank-chip${player.id === room.viewerId ? ' me' : ''}${player.failed ? ' failed' : ''}`;
    const progress = player.failed ? '已失败' : `${player.solvedCount}/${room.targetCount} · ${player.guessesUsed}轮`;
    chip.innerHTML = `<b>#${index + 1}</b>${escapeHtml(player.name)} · ${progress}`;
    elements.status.appendChild(chip);
  });
}

function renderPlay(room) {
  elements.lobby.classList.add('hidden');
  elements.play.classList.remove('hidden');
  elements.results.classList.add('hidden');
  elements.roundNow.textContent = room.viewer.guessesUsed;
  elements.solvedNow.textContent = room.viewer.solvedCount;
  renderStatus(room);
  renderBoards(elements.boards, room.viewer, room);
  const disabled = Boolean(room.viewer.finishedAt);
  elements.guessInput.disabled = disabled;
  elements.guessForm.querySelector('button').disabled = disabled;
  if (!disabled) setTimeout(() => elements.guessInput.focus(), 0);
}

function renderResults(room) {
  elements.lobby.classList.add('hidden');
  elements.play.classList.add('hidden');
  elements.results.classList.remove('hidden');
  const own = room.players.find((player) => player.id === room.viewerId) || room.players[0];
  const won = own?.solvedCount === room.targetCount;
  $('#resultTitle').textContent = own?.failed ? '已退出，本局失败' : won ? '全部轨迹已找到' : '追迹告一段落';
  $('#resultCopy').textContent = room.mode === 'multi'
    ? '点击玩家 ID，查看每个人留下的完整推理轨迹。'
    : `${own?.guessesUsed || 0} 轮猜测，${own?.solvedCount || 0} 个目标被成功锁定。`;

  elements.resultTabs.replaceChildren();
  room.players.forEach((player, index) => {
    const button = document.createElement('button');
    const selectedId = state.selectedResultPlayer || own.id;
    button.className = `result-tab${selectedId === player.id ? ' active' : ''}`;
    button.textContent = `#${index + 1} ${player.name} · ${player.failed ? '失败' : `${player.solvedCount}/${room.targetCount}`}`;
    button.addEventListener('click', () => {
      state.selectedResultPlayer = player.id;
      renderResults(room);
    });
    elements.resultTabs.appendChild(button);
  });

  const selected = room.players.find((player) => player.id === (state.selectedResultPlayer || own.id)) || own;
  renderBoards(elements.resultBoards, selected, room);
  elements.answers.replaceChildren();
  (room.secrets || []).forEach((answer, index) => {
    const span = document.createElement('span');
    span.className = 'answer';
    span.textContent = `${index + 1}. ${answer}`;
    elements.answers.appendChild(span);
  });
}

function applyRoom(room) {
  state.room = room;
  showGame();
  setBoardSize(room);
  elements.name.value = room.viewer?.name || elements.name.value;
  elements.roomLabel.textContent = room.mode === 'solo' ? '单人挑战' : `房间 ${room.code}`;
  elements.roundLimit.textContent = room.roundLimit;
  elements.targetCount.textContent = room.targetCount;
  elements.guessLength.textContent = room.length;
  elements.guessInput.maxLength = room.length;
  elements.guessInput.placeholder = '0'.repeat(room.length);
  if (room.status === 'lobby') renderLobby(room);
  else if (room.status === 'playing') renderPlay(room);
  else renderResults(room);
}

$$('.mode-tab').forEach((button) => {
  button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    $$('.mode-tab').forEach((item) => item.classList.toggle('active', item === button));
    $$('.join-only').forEach((item) => item.classList.toggle('hidden', state.mode !== 'join'));
    $$('.config-only').forEach((item) => item.classList.toggle('hidden', state.mode === 'join'));
    elements.startButton.querySelector('span').textContent =
      state.mode === 'join' ? '进入房间' : state.mode === 'create' ? '创建竞赛' : '开始追迹';
  });
});

[elements.targets, elements.length].forEach((input) => input.addEventListener('input', updatePreview));
elements.startForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.startButton.disabled = true;
  try {
    const payload = {
      name: elements.name.value,
      targetCount: Number(elements.targets.value),
      length: Number(elements.length.value),
      code: elements.code.value
    };
    const eventName = state.mode === 'solo' ? 'game:solo' : state.mode === 'create' ? 'room:create' : 'room:join';
    applyRoom((await request(eventName, payload)).room);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.startButton.disabled = false;
  }
});

elements.begin.addEventListener('click', async () => {
  try {
    await request('room:start', { code: state.room.code, token: state.room.viewer.token });
  } catch (error) {
    showToast(error.message, true);
  }
});

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for browsers that expose the API but deny clipboard permission.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('浏览器拒绝了剪贴板访问');
}

elements.copyCode.addEventListener('click', async () => {
  try {
    await copyText(state.room.code);
    showToast(`房间号 ${state.room.code} 已复制`);
  } catch (error) {
    showToast(`${error.message}，请长按房间号手动复制`, true);
  }
});

elements.guessInput.addEventListener('input', () => {
  elements.guessInput.value = elements.guessInput.value.replace(/\D/g, '').slice(0, state.room?.length || 10);
});

elements.guessForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const guess = elements.guessInput.value;
  if (guess.length !== state.room.length) {
    showToast(`请输入 ${state.room.length} 位数字`, true);
    return;
  }
  const button = elements.guessForm.querySelector('button');
  button.disabled = true;
  try {
    await request('game:guess', { code: state.room.code, token: state.room.viewer.token, guess });
    elements.guessInput.value = '';
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

socket.on('room:update', applyRoom);

async function leaveAndReturnHome() {
  if (state.room?.viewer?.token) {
    try {
      await request('room:leave', { code: state.room.code, token: state.room.viewer.token });
    } catch {
      // Navigating away disconnects the socket and applies the same failure rule.
    }
  }
  location.href = '/';
}

$('#homeButton').addEventListener('click', leaveAndReturnHome);
$('#backButton').addEventListener('click', leaveAndReturnHome);

$('#helpButton').addEventListener('click', () => {
  elements.dialogContent.innerHTML = `
    <h2>如何留下数迹</h2>
    <p>系统会生成 N 个互不相同、可含前导零的 M 位数字。每轮输入一个 M 位数字，它会同时作用于所有尚未找到的目标。</p>
    <div class="legend"><span class="green">绿色 · 数字与位置都正确</span><span class="orange">橙色 · 数字存在但位置错误</span><span class="gray">灰色 · 不存在或数量已用尽</span></div>
    <p>重复数字严格按出现次数判定。猜中一个目标后，该列整行变绿，之后不再显示提示。找到全部目标即可获胜。</p>
    <p><b>轮次公式：</b>N + ⌈log₂(M)⌉ + 3，最少 6、最多 24。它以反馈的信息论下界为基础，再加入重复数字定位、逐个命中与人类操作余量。</p>`;
  elements.dialog.showModal();
});

$$('[data-close]').forEach((button) => button.addEventListener('click', () => elements.dialog.close()));
elements.dialog.addEventListener('click', (event) => {
  if (event.target === elements.dialog) elements.dialog.close();
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === 'light';
  $('#themeButton').textContent = light ? '☾ 深色' : '☀ 浅色';
  $('#themeButton').setAttribute('aria-label', light ? '切换深色模式' : '切换浅色模式');
  document.querySelector('meta[name="theme-color"]').content = light ? '#f5f8fb' : '#0a0f1b';
}

$('#themeButton').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('shuji:theme', next);
  applyTheme(next);
});

window.addEventListener('resize', () => {
  if (state.room) setBoardSize(state.room);
});

applyTheme(localStorage.getItem('shuji:theme') || 'dark');
updatePreview();
socket.on('connect', loadFixedIdentity);
