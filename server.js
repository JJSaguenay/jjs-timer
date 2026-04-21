const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));

// ─── État du timer ───────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  countdown: { duration: 300 },
  hiit:      { workDuration: 180, restDuration: 60, rounds: 5 },
  grappling: { roundDuration: 300, restDuration: 60, rounds: 5 }
};

function freshState() {
  return {
    mode:           'countdown',
    status:         'idle',      // idle | running | paused | finished
    phase:          'work',      // work | rest
    currentRound:   1,
    totalRounds:    1,
    phaseRemaining: 300,
    settings:       JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    event:          null         // started | paused | resumed | reset | phase_change | warning | finished
  };
}

let state = freshState();
let timerInterval = null;

// ─── Logique du timer ────────────────────────────────────────────────────────

function getPhaseSeconds(mode, phase, settings) {
  if (mode === 'countdown') return settings.countdown.duration;
  if (mode === 'hiit')
    return phase === 'work' ? settings.hiit.workDuration : settings.hiit.restDuration;
  if (mode === 'grappling')
    return phase === 'work' ? settings.grappling.roundDuration : settings.grappling.restDuration;
  return 300;
}

function getRounds(mode, settings) {
  if (mode === 'hiit')      return settings.hiit.rounds;
  if (mode === 'grappling') return settings.grappling.rounds;
  return 1;
}

function stopInterval() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function tick() {
  state.event = null;
  state.phaseRemaining--;

  if (state.phaseRemaining <= 0) {
    // Phase terminée
    if (state.mode === 'countdown') {
      state.phaseRemaining = 0;
      state.status = 'finished';
      state.event = 'finished';
      stopInterval();
    } else {
      if (state.phase === 'work') {
        // Passer au repos
        state.phase = 'rest';
        state.phaseRemaining = getPhaseSeconds(state.mode, 'rest', state.settings);
        state.event = 'phase_change';
      } else {
        // Repos terminé
        if (state.currentRound < state.totalRounds) {
          state.currentRound++;
          state.phase = 'work';
          state.phaseRemaining = getPhaseSeconds(state.mode, 'work', state.settings);
          state.event = 'phase_change';
        } else {
          state.phaseRemaining = 0;
          state.status = 'finished';
          state.event = 'finished';
          stopInterval();
        }
      }
    }
  } else if (state.phaseRemaining <= 3 && state.phaseRemaining > 0) {
    state.event = 'warning';
  }

  io.emit('state', state);
}

// ─── Gestion des commandes ───────────────────────────────────────────────────

function handleCommand(action, payload) {
  state.event = null;

  switch (action) {

    case 'start': {
      if (state.status === 'running') return; // déjà en cours

      if (state.status === 'paused') {
        // Reprendre
        state.status = 'running';
        state.event = 'resumed';
        timerInterval = setInterval(tick, 1000);
        break;
      }

      // Démarrage frais (idle ou finished)
      if (payload?.mode)     state.mode     = payload.mode;
      if (payload?.settings) state.settings = { ...state.settings, ...payload.settings };

      state.status        = 'running';
      state.phase         = 'work';
      state.currentRound  = 1;
      state.totalRounds   = getRounds(state.mode, state.settings);
      state.phaseRemaining = getPhaseSeconds(state.mode, 'work', state.settings);
      state.event         = 'started';
      timerInterval       = setInterval(tick, 1000);
      break;
    }

    case 'pause': {
      if (state.status !== 'running') return;
      stopInterval();
      state.status = 'paused';
      state.event  = 'paused';
      break;
    }

    case 'toggle': {
      // Pour la télécommande Fire Stick (touche OK)
      if (state.status === 'running') {
        handleCommand('pause', null);
        return;
      } else {
        handleCommand('start', payload);
        return;
      }
    }

    case 'reset': {
      stopInterval();
      const savedSettings = state.settings;
      const savedMode     = state.mode;
      state = freshState();
      state.settings = savedSettings;
      state.mode     = savedMode;
      state.phaseRemaining = getPhaseSeconds(state.mode, 'work', state.settings);
      state.event = 'reset';
      break;
    }

    default:
      return;
  }

  io.emit('state', state);
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Client connecté:', socket.id);
  socket.emit('state', state);

  socket.on('command', ({ action, payload }) => {
    handleCommand(action, payload);
  });

  socket.on('disconnect', () => {
    console.log('Client déconnecté:', socket.id);
  });
});

// ─── Démarrage ───────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`JJS Timer en écoute sur le port ${PORT}`);
});
