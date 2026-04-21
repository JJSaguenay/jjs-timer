const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/tv',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));
app.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));

// ─── État du timer ───────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  countdown: { duration: 300 },
  hiit:      { workDuration: 180, restDuration: 60, rounds: 5 },
  grappling: { roundDuration: 300, restDuration: 60, rounds: 5 }
};

function freshState() {
  return {
    mode:               'countdown',
    status:             'idle',       // idle | countdown | running | paused | finished
    phase:              'work',       // work | rest
    currentRound:       1,
    totalRounds:        1,
    phaseRemaining:     300,
    countdownRemaining: 0,            // 3 → 2 → 1 avant le départ
    settings:           JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    event:              null,
    eventSeq:           0             // incrémenté à chaque événement pour distinguer les répétitions
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

function setEvent(name) {
  state.event    = name;
  state.eventSeq = (state.eventSeq + 1) % 100000;
}

function tick() {

  // ── Phase de compte à rebours 3-2-1 ──────────────────────────────────────
  if (state.status === 'countdown') {
    state.countdownRemaining--;
    if (state.countdownRemaining <= 0) {
      // Transition vers le vrai timer
      state.status = 'running';
      setEvent('started');
    } else {
      setEvent('countdown_tick');
    }
    io.emit('state', state);
    return;
  }

  // ── Tick normal ───────────────────────────────────────────────────────────
  state.event = null;
  state.phaseRemaining--;

  if (state.phaseRemaining <= 0) {
    // Phase terminée
    if (state.mode === 'countdown') {
      state.phaseRemaining = 0;
      state.status = 'finished';
      setEvent('finished');
      stopInterval();
    } else {
      if (state.phase === 'work') {
        state.phase          = 'rest';
        state.phaseRemaining = getPhaseSeconds(state.mode, 'rest', state.settings);
        setEvent('phase_change');
      } else {
        if (state.currentRound < state.totalRounds) {
          state.currentRound++;
          state.phase          = 'work';
          state.phaseRemaining = getPhaseSeconds(state.mode, 'work', state.settings);
          setEvent('phase_change');
        } else {
          state.phaseRemaining = 0;
          state.status         = 'finished';
          setEvent('finished');
          stopInterval();
        }
      }
    }
  } else if (state.phaseRemaining <= 3) {
    // Bips des 3 dernières secondes — eventSeq garantit l'unicité
    setEvent('warning');
  }

  io.emit('state', state);
}

// ─── Gestion des commandes ───────────────────────────────────────────────────

function handleCommand(action, payload) {

  switch (action) {

    case 'start': {
      if (state.status === 'running' || state.status === 'countdown') return;

      if (state.status === 'paused') {
        // Reprendre sans countdown
        state.status = 'running';
        setEvent('resumed');
        timerInterval = setInterval(tick, 1000);
        break;
      }

      // Démarrage frais (idle ou finished)
      if (payload?.mode)     state.mode     = payload.mode;
      if (payload?.settings) state.settings = { ...state.settings, ...payload.settings };

      state.status             = 'countdown';
      state.countdownRemaining = 3;
      state.phase              = 'work';
      state.currentRound       = 1;
      state.totalRounds        = getRounds(state.mode, state.settings);
      state.phaseRemaining     = getPhaseSeconds(state.mode, 'work', state.settings);
      setEvent('countdown_tick');
      timerInterval = setInterval(tick, 1000);
      break;
    }

    case 'pause': {
      if (state.status !== 'running') return;
      stopInterval();
      state.status = 'paused';
      setEvent('paused');
      break;
    }

    case 'toggle': {
      if (state.status === 'running') {
        handleCommand('pause', null);
        return;
      } else if (state.status === 'countdown') {
        // Annuler le countdown = reset
        handleCommand('reset', null);
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
      state          = freshState();
      state.settings = savedSettings;
      state.mode     = savedMode;
      state.phaseRemaining = getPhaseSeconds(state.mode, 'work', state.settings);
      setEvent('reset');
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
