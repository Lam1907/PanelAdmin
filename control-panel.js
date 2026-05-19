/**
 * ═══════════════════════════════════════════════════════════════════════
 * CONTROL PANEL — Danzad Malditos
 * Módulo: control-panel.js
 *
 * Responsabilidades:
 *   - Inicializar Firebase y gestionar conexión
 *   - Leer/escribir estados en Realtime Database
 *   - Controlar temporizador basado en Firebase (timerEnd)
 *   - Gestionar participantes (nombre, imagen)
 *   - Consolidar parejas por votación
 *   - Controlar acciones sobre parejas (eliminar, intercambiar)
 *   - Manejar rondas, historial y borrado de datos
 *   - Sincronizar UI en tiempo real sin re-renders masivos
 * ═══════════════════════════════════════════════════════════════════════
 */

// ─── Firebase Imports ──────────────────────────────────────────────────
import { initializeApp }          from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js';
import { getDatabase, ref, set, update, push, remove, onValue, get, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-database.js';

// ─── Firebase Init ─────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            'AIzaSyCxd2sdNJZaQ0Rq_mF6Sn1wLQra4Eabp1U',
  authDomain:        'danzad-maldit0s.firebaseapp.com',
  databaseURL:       'https://danzad-maldit0s-default-rtdb.firebaseio.com',
  projectId:         'danzad-maldit0s',
  storageBucket:     'danzad-maldit0s.firebasestorage.app',
  messagingSenderId: '774607843671',
  appId:             '1:774607843671:web:ec64876ba81b6b50acce12',
};

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ─── Constantes ────────────────────────────────────────────────────────
const ADMIN_PASSWORD    = 'DanzadMalditos26';
const TOTAL_PARTICIPANTS = 10;
const PAIR_COLORS = ['#e04060','#3a8fd5','#e0a020','#40c080','#a060d0'];

// ─── Estado local ──────────────────────────────────────────────────────
let state = {
  firebase:     { votingOpen: false, votingEnded: false, waitingRoom: true },
  participants: {},          // { participant_1: { name, image, number } }
  votes:        {},          // { pair_X: { [combo]: count } }
  pairs:        {},          // { pair_1: { participants:[n1,n2], eliminated:false } }
  round:        1,
  timerEnd:     null,        // timestamp ms
  voteCount:    0,
  unsubscribers: [],         // para limpiar listeners
};

let timerInterval    = null;  // setInterval del countdown
let pendingImageSlot = null;  // { participantId } para modal de imagen
let pendingSwap      = null;  // { pairKey, slotIndex } para intercambio

// ─── Referencias UI (cacheadas) ────────────────────────────────────────
const $ = id => document.getElementById(id);

const UI = {
  dotFirebase:      $('dotFirebase'),
  labelFirebase:    $('labelFirebase'),
  displayRound:     $('displayRound'),
  displayVotes:     $('displayVotes'),
  displayTimer:     $('displayTimer'),
  statePreVoting:   $('statePreVoting'),
  statePostVoting:  $('statePostVoting'),
  participantsGrid: $('participantsGrid'),
  pairsGrid:        $('pairsGrid'),
  inputDuration:    $('inputDuration'),
  loadingOverlay:   $('loadingOverlay'),
  loadingText:      $('loadingText'),
  toastContainer:   $('toastContainer'),
};

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 1 — UTILIDADES GENERALES
// ══════════════════════════════════════════════════════════════════════

/**
 * Muestra/oculta overlay de loading con texto personalizado
 */
function setLoading(visible, text = 'ACTUALIZANDO...') {
  UI.loadingText.textContent = text;
  UI.loadingOverlay.classList.toggle('cp-loading-overlay--hidden', !visible);
}

/**
 * Bloquea todos los botones de acción durante operaciones Firebase
 */
function setButtonsDisabled(disabled) {
  document.querySelectorAll('.cp-btn').forEach(btn => {
    if (!btn.classList.contains('cp-btn--ghost') || btn.id.startsWith('modal')) return;
    btn.disabled = disabled;
  });
}

/**
 * Muestra un toast de notificación temporal
 * @param {string} msg  - Mensaje a mostrar
 * @param {'success'|'error'|'info'|'warning'} type
 */
function showToast(msg, type = 'info') {
  const icons = { success: '✓', error: '✕', info: '◉', warning: '⚠' };
  const el = document.createElement('div');
  el.className = `cp-toast cp-toast--${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  UI.toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(30px)';
    el.style.transition = 'all 300ms ease';
    setTimeout(() => el.remove(), 310);
  }, 3200);
}

/**
 * Formatea segundos a MM:SS
 */
function fmtTime(secs) {
  if (secs <= 0) return '00:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

/**
 * Envuelve operación Firebase con loading + manejo de errores
 */
async function withLoading(fn, text = 'ACTUALIZANDO...') {
  setLoading(true, text);
  setButtonsDisabled(true);
  try {
    await fn();
  } catch (err) {
    console.error('[CP] Error Firebase:', err);
    showToast('Error al actualizar Firebase: ' + err.message, 'error');
  } finally {
    setLoading(false);
    setButtonsDisabled(false);
  }
}

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 2 — MODALES
// ══════════════════════════════════════════════════════════════════════

/**
 * Abre/cierra un modal por ID
 */
function openModal(id)  { $(id)?.classList.add('is-open'); }
function closeModal(id) { $(id)?.classList.remove('is-open'); }

/**
 * Modal de confirmación reutilizable.
 * Devuelve una Promise que resuelve con true/false.
 */
function confirmAction({ title = 'CONFIRMAR', body = '¿Estás seguro?', icon = '⚠', yesLabel = 'SÍ, CONFIRMAR', yesClass = 'cp-btn--primary' } = {}) {
  return new Promise(resolve => {
    $('modalConfirmTitle').textContent = title;
    $('modalConfirmBody').textContent  = body;
    $('modalConfirmIcon').textContent  = icon;
    $('modalConfirmYes').textContent   = yesLabel;
    $('modalConfirmYes').className     = `cp-btn ${yesClass}`;

    openModal('modalConfirm');

    const yes = $('modalConfirmYes');
    const no  = $('modalConfirmNo');

    const cleanup = val => {
      closeModal('modalConfirm');
      yes.replaceWith(yes.cloneNode(true)); // limpia listeners
      no.replaceWith(no.cloneNode(true));
      // Re-cachear después de clonar
      $('modalConfirmYes').addEventListener('click', () => {});
      resolve(val);
    };

    // Usar clones para evitar acumulación de listeners
    const freshYes = yes.cloneNode(true);
    const freshNo  = no.cloneNode(true);
    yes.replaceWith(freshYes);
    no.replaceWith(freshNo);
    freshYes.textContent = yesLabel;
    freshYes.className   = `cp-btn ${yesClass}`;
    freshYes.addEventListener('click', () => cleanup(true));
    freshNo.addEventListener( 'click', () => cleanup(false));
  });
}

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 3 — ESTADO VISUAL (PRE / POST)
// ══════════════════════════════════════════════════════════════════════

/**
 * Cambia entre estado PRE y POST votación con transición suave.
 * @param {'pre'|'post'} which
 */
function showState(which) {
  const pre  = UI.statePreVoting;
  const post = UI.statePostVoting;

  if (which === 'pre') {
    post.classList.add('cp-state--hidden');
    pre.classList.remove('cp-state--hidden');
  } else {
    pre.classList.add('cp-state--hidden');
    post.classList.remove('cp-state--hidden');
  }
}

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 4 — CONEXIÓN FIREBASE
// ══════════════════════════════════════════════════════════════════════

/**
 * Monitorea estado de conexión a Firebase
 */
function initFirebaseConnection() {
  const connRef = ref(db, '.info/connected');
  onValue(connRef, snap => {
    const connected = !!snap.val();
    UI.dotFirebase.className  = `cp-status-dot ${connected ? 'connected' : 'disconnected'}`;
    UI.labelFirebase.textContent = connected ? 'FIREBASE ●' : 'FIREBASE ○';
  });

  // Fallback con navigator.onLine
  window.addEventListener('online',  () => UI.dotFirebase.classList.add('connected'));
  window.addEventListener('offline', () => {
    UI.dotFirebase.classList.remove('connected');
    UI.dotFirebase.classList.add('disconnected');
  });
}

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 5 — LISTENERS REALTIME FIREBASE
// ══════════════════════════════════════════════════════════════════════

/**
 * Inicializa todos los listeners de Firebase.
 * Guarda unsubscribers para limpiarlos si es necesario.
 */
function initFirebaseListeners() {
  // /state
  const unsubState = onValue(ref(db, 'state'), snap => {
    const s = snap.val() || {};
    state.firebase = {
      votingOpen:  !!s.votingOpen,
      votingEnded: !!s.votingEnded,
      waitingRoom: s.waitingRoom !== false,
    };
    state.timerEnd = s.timerEnd || null;
    state.round    = s.round    || 1;

    UI.displayRound.textContent = String(state.round).padStart(2, '0');

    // Cambio automático de estado visual
    if (state.firebase.votingEnded) {
      showState('post');
      stopTimer();
    } else if (state.firebase.votingOpen) {
      showState('pre');
      startTimerDisplay();
    } else {
      showState('pre');
      stopTimer();
      UI.displayTimer.textContent = '--:--';
    }
  });

  // /participants
  const unsubPart = onValue(ref(db, 'participants'), snap => {
    state.participants = snap.val() || {};
    renderParticipants();
    // Actualizar slots en parejas también (nombres e imágenes pueden haber cambiado)
    if (state.firebase.votingEnded) renderPairs();
  });

  // /votes — solo contamos para mostrar en header
  const unsubVotes = onValue(ref(db, 'votes'), snap => {
    const v = snap.val() || {};
    state.votes = v;
    let total = 0;
    // Los votos tienen estructura /votes/pair_X/combo: count
    Object.values(v).forEach(pairVotes => {
      if (typeof pairVotes === 'object') {
        Object.values(pairVotes).forEach(c => { total += (c || 0); });
      }
    });
    state.voteCount = total;
    UI.displayVotes.textContent = String(total).padStart(3, '0');
  });

  // /results/currentRound/pairs
  const unsubPairs = onValue(ref(db, 'results/currentRound/pairs'), snap => {
    state.pairs = snap.val() || {};
    if (state.firebase.votingEnded) renderPairs();
  });

  state.unsubscribers = [unsubState, unsubPart, unsubVotes, unsubPairs];
}

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 6 — TEMPORIZADOR
// ══════════════════════════════════════════════════════════════════════

/**
 * Inicia el display del countdown basado en state.timerEnd (Firebase timestamp)
 */
function startTimerDisplay() {
  stopTimer();
  if (!state.timerEnd) return;

  timerInterval = setInterval(() => {
    const remaining = Math.max(0, (state.timerEnd - Date.now()) / 1000);
    UI.displayTimer.textContent = fmtTime(remaining);
    if (remaining <= 0) {
      stopTimer();
      handleTimerExpired();
    }
  }, 500);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

/**
 * Llamado cuando el timer llega a 0 en este cliente.
 * Escribe en Firebase para cerrar votación.
 */
async function handleTimerExpired() {
  // Solo actúa si la votación sigue abierta (evita race conditions)
  if (!state.firebase.votingOpen) return;
  try {
    await update(ref(db, 'state'), {
      votingOpen:  false,
      votingEnded: true,
    });
  } catch (e) {
    console.error('[CP] handleTimerExpired error:', e);
  }
}

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 7 — RENDER PARTICIPANTES
// ══════════════════════════════════════════════════════════════════════

/**
 * Renderiza las tarjetas de participantes.
 * Usa diff mínimo: solo crea elementos que no existen.
 */
function renderParticipants() {
  const grid = UI.participantsGrid;

  for (let i = 1; i <= TOTAL_PARTICIPANTS; i++) {
    const pid  = `participant_${i}`;
    const data = state.participants[pid] || { name: '', image: '', number: i };
    let card = grid.querySelector(`[data-pid="${pid}"]`);

    if (!card) {
      card = createParticipantCard(pid, data);
      grid.appendChild(card);
    } else {
      updateParticipantCard(card, data);
    }
  }
}

/**
 * Crea el elemento DOM de una tarjeta de participante
 */
function createParticipantCard(pid, data) {
  const card = document.createElement('div');
  card.className = 'cp-participant-card';
  card.dataset.pid = pid;
  card.innerHTML = buildParticipantCardHTML(pid, data);

  // Listener: editar nombre (debounce)
  const nameInput = card.querySelector('.cp-card__name-input');
  let nameTimeout;
  nameInput.addEventListener('input', () => {
    clearTimeout(nameTimeout);
    nameTimeout = setTimeout(() => saveParticipantName(pid, nameInput.value), 600);
  });

  // Listener: click en imagen → abrir modal
  card.querySelector('.cp-card__image-wrap').addEventListener('click', () => {
    openImageModal(pid);
  });

  return card;
}

/**
 * Actualiza solo los datos dinámicos de una tarjeta existente (diff mínimo)
 */
function updateParticipantCard(card, data) {
  const img   = card.querySelector('.cp-card__img');
  const noImg = card.querySelector('.cp-card__no-image');
  const nameInput = card.querySelector('.cp-card__name-input');

  // Imagen
  if (data.image) {
    if (img) {
      if (img.src !== data.image) img.src = data.image;
    } else {
      if (noImg) noImg.style.display = 'none';
      const newImg = document.createElement('img');
      newImg.className = 'cp-card__img';
      newImg.src = data.image;
      newImg.alt = data.name || '';
      card.querySelector('.cp-card__image-wrap').prepend(newImg);
    }
    if (noImg) noImg.style.display = 'none';
  } else {
    if (img) img.remove();
    if (noImg) noImg.style.display = '';
  }

  // Nombre (no pisar si el input tiene foco)
  if (document.activeElement !== nameInput) {
    nameInput.value = data.name || '';
  }
}

function buildParticipantCardHTML(pid, data) {
  const num = data.number || pid.split('_')[1];
  const imgHtml = data.image
    ? `<img class="cp-card__img" src="${data.image}" alt="${data.name || ''}" loading="lazy" />`
    : '';
  const noImgHtml = data.image ? 'style="display:none"' : '';

  return `
    <div class="cp-card__number">#${String(num).padStart(2,'0')}</div>
    <div class="cp-card__image-wrap">
      ${imgHtml}
      <div class="cp-card__no-image" ${noImgHtml}>
        <span class="cp-card__no-image-icon">○</span>
        <span class="cp-card__no-image-text">SIN IMAGEN</span>
      </div>
      <div class="cp-card__image-overlay">◉ CAMBIAR</div>
    </div>
    <div class="cp-card__body">
      <input
        class="cp-card__name-input"
        type="text"
        placeholder="Nombre participante..."
        value="${(data.name || '').replace(/"/g, '&quot;')}"
        maxlength="40"
      />
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 8 — RENDER PAREJAS
// ══════════════════════════════════════════════════════════════════════

/**
 * Renderiza las 5 tarjetas de parejas en el estado post-votación.
 * Reconstruye solo si hay cambios estructurales.
 */
function renderPairs() {
  const grid = UI.pairsGrid;
  grid.innerHTML = ''; // Parejas cambian poco → reconstruir es seguro

  for (let i = 1; i <= 5; i++) {
    const key  = `pair_${i}`;
    const pair = state.pairs[key];
    const card = buildPairCard(key, i, pair);
    grid.appendChild(card);
  }
}

/**
 * Construye el elemento DOM completo de una tarjeta de pareja
 */
function buildPairCard(pairKey, pairNum, pairData) {
  const card = document.createElement('div');
  card.className = 'cp-pair-card';
  card.dataset.pair = pairNum;

  const eliminated = pairData?.eliminated ?? false;
  if (eliminated) card.classList.add('cp-pair-card--eliminated');

  const participants = pairData?.participants || [null, null];

  card.innerHTML = `
    <div class="cp-pair__header">
      <span class="cp-pair__title">PAREJA ${pairNum}</span>
      <div class="cp-pair__actions">
        ${!eliminated ? `
          <button class="cp-btn cp-btn--warning cp-btn--sm" data-action="eliminate-pair" data-pair="${pairKey}" title="Eliminar pareja">✕ ELIMINAR</button>
        ` : ''}
      </div>
    </div>
    <div class="cp-pair__participants">
      ${buildSlot(pairKey, 0, participants[0])}
      ${buildSlot(pairKey, 1, participants[1])}
    </div>
  `;

  // Listeners de acciones de la pareja
  if (!eliminated) {
    card.querySelector('[data-action="eliminate-pair"]')?.addEventListener('click', () => {
      handleEliminatePair(pairKey);
    });

    // Listeners de slots
    card.querySelectorAll('.cp-slot[data-slot]').forEach(slot => {
      const slotIdx = parseInt(slot.dataset.slot);
      const partNum = parseInt(slot.dataset.participant);

      slot.addEventListener('click', () => {
        if (!isNaN(partNum)) {
          openSlotContextMenu(slot, pairKey, slotIdx, partNum);
        }
      });
    });
  }

  return card;
}

/**
 * Construye un slot de participante dentro de una pareja
 */
function buildSlot(pairKey, slotIndex, participantNumber) {
  if (!participantNumber) {
    return `
      <div class="cp-slot cp-slot--empty" data-slot="${slotIndex}" data-pair="${pairKey}">
        <div class="cp-slot__empty-label">— VACÍO —</div>
      </div>
    `;
  }

  const pid  = `participant_${participantNumber}`;
  const data = state.participants[pid] || { name: `#${participantNumber}`, image: '', number: participantNumber };

  const imgHtml = data.image
    ? `<img class="cp-slot__img" src="${data.image}" alt="${data.name}" loading="lazy" />`
    : `<div style="position:absolute;inset:0;background:var(--col-surface-3);display:flex;align-items:center;justify-content:center;font-size:2rem;color:var(--col-text-dim)">○</div>`;

  return `
    <div class="cp-slot" data-slot="${slotIndex}" data-pair="${pairKey}" data-participant="${participantNumber}" title="Haz clic para acciones">
      ${imgHtml}
      <div class="cp-slot__number">#${String(participantNumber).padStart(2,'0')}</div>
      <div class="cp-slot__name">${data.name || `Participante ${participantNumber}`}</div>
      <div class="cp-slot__overlay">
        <button class="cp-btn cp-btn--warning cp-btn--sm" data-action="swap" data-pair="${pairKey}" data-slot="${slotIndex}" data-participant="${participantNumber}">⇄ MOVER</button>
        <button class="cp-btn cp-btn--danger cp-btn--sm"  data-action="eliminate-slot" data-pair="${pairKey}" data-slot="${slotIndex}" data-participant="${participantNumber}">✕ ELIMINAR</button>
      </div>
    </div>
  `;
}

/**
 * Abre el mini-menu contextual de un slot (implementado como event delegation)
 */
function openSlotContextMenu(slotEl, pairKey, slotIndex, participantNumber) {
  // Los botones del overlay ya tienen listeners via delegation
}

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 9 — GUARDAR DATOS PARTICIPANTES
// ══════════════════════════════════════════════════════════════════════

async function saveParticipantName(pid, name) {
  try {
    await update(ref(db, `participants/${pid}`), { name: name.trim() });
  } catch (e) {
    showToast('Error guardando nombre', 'error');
  }
}

async function saveParticipantImage(pid, imageUrl) {
  await withLoading(async () => {
    await update(ref(db, `participants/${pid}`), { image: imageUrl });
    showToast('Imagen actualizada', 'success');
  }, 'GUARDANDO IMAGEN...');
}

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 10 — MODAL DE IMAGEN
// ══════════════════════════════════════════════════════════════════════

function openImageModal(pid) {
  pendingImageSlot = pid;
  $('inputImageUrl').value = '';
  $('modalImageClose').onclick = () => closeModal('modalImage');
  openModal('modalImage');
}

$('btnImageUpload').addEventListener('click', () => {
  $('fileImageInput').click();
});

$('fileImageInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file || !pendingImageSlot) return;

  // Convertir a base64 Data URL (almacenado en Firebase)
  const reader = new FileReader();
  reader.onload = async ev => {
    await saveParticipantImage(pendingImageSlot, ev.target.result);
    closeModal('modalImage');
    pendingImageSlot = null;
  };
  reader.readAsDataURL(file);
  e.target.value = ''; // reset input
});

$('btnImageUrl').addEventListener('click', async () => {
  const url = $('inputImageUrl').value.trim();
  if (!url) { showToast('Introduce una URL válida', 'warning'); return; }
  if (!pendingImageSlot) return;
  await saveParticipantImage(pendingImageSlot, url);
  closeModal('modalImage');
  pendingImageSlot = null;
});

$('btnImageRemove').addEventListener('click', async () => {
  if (!pendingImageSlot) return;
  const confirmed = await confirmAction({
    title: 'ELIMINAR IMAGEN',
    body: '¿Eliminar la imagen de este participante?',
    icon: '✕',
    yesLabel: 'ELIMINAR',
    yesClass: 'cp-btn--danger',
  });
  if (!confirmed) return;
  await saveParticipantImage(pendingImageSlot, '');
  closeModal('modalImage');
  pendingImageSlot = null;
});

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 11 — INICIAR VOTACIÓN
// ══════════════════════════════════════════════════════════════════════

$('btnStartVoting').addEventListener('click', async () => {
  const confirmed = await confirmAction({
    title: '¿INICIAR VOTACIÓN?',
    body: '¿Estás seguro de iniciar la votación? El temporizador comenzará inmediatamente.',
    icon: '▶',
    yesLabel: 'SÍ, INICIAR',
    yesClass: 'cp-btn--primary',
  });
  if (!confirmed) return;

  const duration = parseInt(UI.inputDuration.value) || 120;
  const timerEnd = Date.now() + duration * 1000;

  await withLoading(async () => {
    await update(ref(db, 'state'), {
      votingOpen:  true,
      votingEnded: false,
      waitingRoom: false,
      timerEnd:    timerEnd,
    });
    showToast('¡Votación iniciada!', 'success');
  }, 'INICIANDO VOTACIÓN...');
});

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 12 — REINICIAR VOTACIÓN
// ══════════════════════════════════════════════════════════════════════

async function doRestartVoting() {
  const confirmed = await confirmAction({
    title: 'REINICIAR VOTACIÓN',
    body: 'Se limpiarán votos y parejas. Los participantes se mantienen. ¿Continuar?',
    icon: '↺',
    yesLabel: 'SÍ, REINICIAR',
    yesClass: 'cp-btn--warning',
  });
  if (!confirmed) return;

  await withLoading(async () => {
    // Limpiar votos
    await remove(ref(db, 'votes'));
    // Limpiar parejas actuales
    await remove(ref(db, 'results/currentRound/pairs'));
    // Volver a sala de espera manteniendo ronda
    await update(ref(db, 'state'), {
      votingOpen:  false,
      votingEnded: false,
      waitingRoom: true,
      timerEnd:    null,
    });
    showToast('Votación reiniciada', 'info');
  }, 'REINICIANDO...');
}

$('btnRestartVoting').addEventListener('click',  doRestartVoting);
$('btnRestartVoting2').addEventListener('click', doRestartVoting);

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 13 — BORRAR DATOS
// ══════════════════════════════════════════════════════════════════════

async function doClearData() {
  // Mostrar modal de contraseña
  $('inputPassword').value = '';
  $('passwordError').textContent = '';
  openModal('modalPassword');
}

$('btnClearData').addEventListener('click',  doClearData);
$('btnClearData2').addEventListener('click', doClearData);

$('modalPasswordNo').addEventListener('click', () => closeModal('modalPassword'));

$('modalPasswordYes').addEventListener('click', async () => {
  const pwd = $('inputPassword').value;
  if (pwd !== ADMIN_PASSWORD) {
    $('passwordError').textContent = '✕ Contraseña incorrecta';
    $('inputPassword').style.borderColor = 'var(--col-danger)';
    setTimeout(() => { $('inputPassword').style.borderColor = ''; }, 2000);
    return;
  }

  closeModal('modalPassword');

  const confirmed = await confirmAction({
    title: '⚠ BORRAR TODOS LOS DATOS',
    body: 'Esta acción es IRREVERSIBLE. Se borrarán votos, parejas, rondas, resultados y estados.',
    icon: '⛔',
    yesLabel: '⚠ BORRAR TODO',
    yesClass: 'cp-btn--danger',
  });
  if (!confirmed) return;

  await withLoading(async () => {
    // Borrar nodos seleccionados, conservar participantes
    await remove(ref(db, 'votes'));
    await remove(ref(db, 'results'));
    await remove(ref(db, 'history'));
    await set(ref(db, 'state'), {
      votingOpen:  false,
      votingEnded: false,
      waitingRoom: true,
      round:       1,
      timerEnd:    null,
    });
    showToast('Todos los datos han sido borrados', 'warning');
  }, 'BORRANDO DATOS...');
});

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 14 — CONSOLIDAR PAREJAS
// ══════════════════════════════════════════════════════════════════════

/**
 * Lee los votos actuales y calcula las 5 mejores combinaciones sin repetición.
 * Estructura votos esperada:
 *   /votes/pair_X/[combo_N_M]: count
 *   donde combo = "1_5" significa participante 1 y 5
 */
$('btnConsolidate').addEventListener('click', async () => {
  const confirmed = await confirmAction({
    title: 'CONSOLIDAR PAREJAS',
    body: 'Se calcularán las parejas ganadoras basadas en los votos. ¿Continuar?',
    icon: '⊕',
    yesLabel: 'CONSOLIDAR',
    yesClass: 'cp-btn--accent',
  });
  if (!confirmed) return;

  await withLoading(async () => {
    const pairs = consolidatePairs(state.votes);
    if (!pairs) {
      showToast('No hay votos suficientes para consolidar', 'warning');
      return;
    }
    await set(ref(db, 'results/currentRound/pairs'), pairs);
    showToast('Parejas consolidadas correctamente', 'success');
  }, 'CONSOLIDANDO PAREJAS...');
});

/**
 * Algoritmo de consolidación greedy:
 * 1. Agrega todos los combos de todos los cuadros con sus totales
 * 2. Ordena por votos descendente
 * 3. Selecciona combinaciones sin repetir participantes
 * 4. Genera exactamente 5 parejas
 */
function consolidatePairs(votesData) {
  // Agregar votos por combo globalmente
  const tally = {}; // { "N_M": totalVotos }

  Object.values(votesData || {}).forEach(pairVotes => {
    if (typeof pairVotes !== 'object') return;
    Object.entries(pairVotes).forEach(([combo, count]) => {
      tally[combo] = (tally[combo] || 0) + (count || 0);
    });
  });

  // Ordenar combos por votos
  const sorted = Object.entries(tally)
    .map(([combo, votes]) => {
      const [a, b] = combo.split('_').map(Number);
      return { a, b, votes };
    })
    .sort((x, y) => y.votes - x.votes);

  const used    = new Set();
  const result  = {};
  let pairIndex = 1;

  // Greedy: tomar mejor combo que no use participantes ya asignados
  for (const { a, b } of sorted) {
    if (pairIndex > 5) break;
    if (used.has(a) || used.has(b)) continue;
    used.add(a);
    used.add(b);
    result[`pair_${pairIndex}`] = {
      participants: [a, b],
      eliminated:   false,
    };
    pairIndex++;
  }

  // Si no hay suficientes combos votados, rellenar con participantes sin asignar
  if (pairIndex <= 5) {
    const allNums = Array.from({ length: TOTAL_PARTICIPANTS }, (_, i) => i + 1);
    const available = allNums.filter(n => !used.has(n));
    while (pairIndex <= 5 && available.length >= 2) {
      const a = available.shift();
      const b = available.shift();
      result[`pair_${pairIndex}`] = { participants: [a, b], eliminated: false };
      pairIndex++;
    }
  }

  return pairIndex > 1 ? result : null;
}

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 15 — ACCIONES SOBRE PAREJAS (ELIMINAR, INTERCAMBIAR)
// ══════════════════════════════════════════════════════════════════════

/**
 * Elimina una pareja completa (marca eliminated: true)
 */
async function handleEliminatePair(pairKey) {
  const confirmed = await confirmAction({
    title: 'ELIMINAR PAREJA',
    body: `¿Eliminar ${pairKey.replace('_',' ').toUpperCase()}? Ambos participantes quedarán fuera.`,
    icon: '✕',
    yesLabel: 'ELIMINAR PAREJA',
    yesClass: 'cp-btn--danger',
  });
  if (!confirmed) return;

  await withLoading(async () => {
    await update(ref(db, `results/currentRound/pairs/${pairKey}`), {
      eliminated: true,
    });
    showToast(`${pairKey} eliminada`, 'warning');
    checkWinner();
  }, 'ELIMINANDO PAREJA...');
}

/**
 * Elimina un solo participante de un slot
 */
async function handleEliminateSlot(pairKey, slotIndex, participantNumber) {
  const pid  = `participant_${participantNumber}`;
  const name = state.participants[pid]?.name || `#${participantNumber}`;

  const confirmed = await confirmAction({
    title: 'ELIMINAR PARTICIPANTE',
    body: `¿Eliminar a "${name}" de la pareja? Su lugar quedará vacío.`,
    icon: '✕',
    yesLabel: 'ELIMINAR',
    yesClass: 'cp-btn--danger',
  });
  if (!confirmed) return;

  await withLoading(async () => {
    const pair = state.pairs[pairKey];
    if (!pair) return;
    const participants = [...(pair.participants || [null, null])];
    participants[slotIndex] = null;
    await update(ref(db, `results/currentRound/pairs/${pairKey}`), { participants });
    showToast(`Participante ${name} eliminado de ${pairKey}`, 'info');
  }, 'ACTUALIZANDO...');
}

/**
 * Abre modal para mover/intercambiar participante entre parejas
 */
async function handleSwapParticipant(fromPairKey, fromSlot, participantNumber) {
  pendingSwap = { fromPairKey, fromSlot, participantNumber };

  const pid  = `participant_${participantNumber}`;
  const name = state.participants[pid]?.name || `#${participantNumber}`;

  $('modalSwapBody').textContent = `Mover a "${name}" a: (selecciona destino)`;

  const grid = $('swapGrid');
  grid.innerHTML = '';

  // Construir opciones: todos los slots disponibles excepto el origen
  for (const [pairKey, pair] of Object.entries(state.pairs)) {
    if (pair.eliminated) continue;
    const pts = pair.participants || [null, null];
    pts.forEach((num, slotIdx) => {
      if (pairKey === fromPairKey && slotIdx === fromSlot) return; // misma posición

      const targetPid   = num ? `participant_${num}` : null;
      const targetData  = targetPid ? (state.participants[targetPid] || {}) : null;
      const pairNum     = pairKey.split('_')[1];
      const slotLabel   = slotIdx === 0 ? 'A' : 'B';

      const item = document.createElement('div');
      item.className = 'cp-swap-slot';
      item.innerHTML = `
        ${targetData?.image
          ? `<img class="cp-swap-slot__img" src="${targetData.image}" alt="${targetData.name}" />`
          : `<div class="cp-swap-slot__img" style="display:flex;align-items:center;justify-content:center;font-size:1.5rem;color:var(--col-text-dim)">○</div>`
        }
        <span class="cp-swap-slot__name">${targetData?.name || '— VACÍO —'}</span>
        <span class="cp-swap-slot__info">Pareja ${pairNum} · Slot ${slotLabel}</span>
      `;
      item.addEventListener('click', () => {
        confirmAndSwap(fromPairKey, fromSlot, participantNumber, pairKey, slotIdx, num);
      });
      grid.appendChild(item);
    });
  }

  $('modalSwapClose').onclick = () => { closeModal('modalSwap'); pendingSwap = null; };
  openModal('modalSwap');
}

/**
 * Ejecuta el intercambio entre dos slots
 */
async function confirmAndSwap(fromPairKey, fromSlot, fromNum, toPairKey, toSlot, toNum) {
  closeModal('modalSwap');

  const confirmed = await confirmAction({
    title: 'INTERCAMBIAR',
    body: `¿Intercambiar los participantes entre ${fromPairKey} y ${toPairKey}?`,
    icon: '⇄',
    yesLabel: 'INTERCAMBIAR',
    yesClass: 'cp-btn--primary',
  });
  if (!confirmed) return;

  await withLoading(async () => {
    // Clonar arrays para no mutar estado
    const fromPair = { ...(state.pairs[fromPairKey] || { participants: [null, null] }) };
    const toPair   = { ...(state.pairs[toPairKey]   || { participants: [null, null] }) };

    fromPair.participants = [...(fromPair.participants || [null, null])];
    toPair.participants   = [...(toPair.participants   || [null, null])];

    // Intercambio
    fromPair.participants[fromSlot] = toNum   ?? null;
    toPair.participants[toSlot]     = fromNum ?? null;

    const updates = {};
    updates[`results/currentRound/pairs/${fromPairKey}/participants`] = fromPair.participants;
    updates[`results/currentRound/pairs/${toPairKey}/participants`]   = toPair.participants;
    await update(ref(db), updates);
    showToast('Participantes intercambiados', 'success');
  }, 'INTERCAMBIANDO...');

  pendingSwap = null;
}

// Event delegation para acciones dentro de tarjetas de pareja
UI.pairsGrid.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action      = btn.dataset.action;
  const pairKey     = btn.dataset.pair;
  const slotIndex   = parseInt(btn.dataset.slot);
  const partNum     = parseInt(btn.dataset.participant);

  if (action === 'eliminate-pair') handleEliminatePair(pairKey);
  if (action === 'eliminate-slot') handleEliminateSlot(pairKey, slotIndex, partNum);
  if (action === 'swap')           handleSwapParticipant(pairKey, slotIndex, partNum);
});

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 16 — GANADOR Y FINALIZAR RONDA
// ══════════════════════════════════════════════════════════════════════

/**
 * Comprueba si solo queda 1 pareja no eliminada → ganador
 */
function checkWinner() {
  const active = Object.values(state.pairs).filter(p => !p.eliminated);
  if (active.length === 1) {
    update(ref(db, 'results/currentRound'), { winner: true });
    showToast('¡GANADOR ENCONTRADO! Solo queda 1 pareja.', 'success');
  }
}

/**
 * Finaliza la ronda actual:
 * 1. Guarda historial en /history/round_X
 * 2. Incrementa ronda
 * 3. Limpia votos y parejas
 * 4. Vuelve a sala de espera + estado PRE
 */
$('btnFinalizeRound').addEventListener('click', async () => {
  const confirmed = await confirmAction({
    title: 'FINALIZAR RONDA',
    body: `¿Finalizar la ronda ${state.round}? Se guardará el historial y comenzará la siguiente ronda.`,
    icon: '▶▶',
    yesLabel: 'FINALIZAR RONDA',
    yesClass: 'cp-btn--primary',
  });
  if (!confirmed) return;

  await withLoading(async () => {
    const roundKey = `round_${state.round}`;

    // Guardar historial
    await set(ref(db, `history/${roundKey}`), {
      votes:     state.votes,
      pairs:     state.pairs,
      timestamp: Date.now(),
      round:     state.round,
    });

    const newRound = state.round + 1;

    // Limpiar datos actuales y avanzar ronda
    const updates = {};
    updates['votes']                      = null;
    updates['results/currentRound/pairs'] = null;
    updates['results/currentRound/winner']= null;
    updates['state'] = {
      votingOpen:  false,
      votingEnded: false,
      waitingRoom: true,
      round:       newRound,
      timerEnd:    null,
    };

    await update(ref(db), updates);
    showToast(`Ronda ${state.round} finalizada. Ahora: ronda ${newRound}`, 'success');
  }, 'FINALIZANDO RONDA...');
});

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 17 — BOTÓN VOLVER A ADMIN
// ══════════════════════════════════════════════════════════════════════

$('btnBack').addEventListener('click', () => {
  // Solo navegación — NO modifica Firebase
  window.location.href = 'admin.html';
});

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 18 — INICIALIZACIÓN DE PARTICIPANTES POR DEFECTO
// ══════════════════════════════════════════════════════════════════════

/**
 * Verifica si existen participantes en Firebase.
 * Si no, crea la estructura por defecto.
 */
async function ensureParticipantsExist() {
  const snap = await get(ref(db, 'participants'));
  if (snap.exists()) return;

  const defaults = {};
  for (let i = 1; i <= TOTAL_PARTICIPANTS; i++) {
    defaults[`participant_${i}`] = {
      name:   `Participante ${i}`,
      image:  '',
      number: i,
    };
  }
  await set(ref(db, 'participants'), defaults);
}

// ══════════════════════════════════════════════════════════════════════
// SECCIÓN 19 — ARRANQUE PRINCIPAL
// ══════════════════════════════════════════════════════════════════════

async function init() {
  try {
    initFirebaseConnection();
    await ensureParticipantsExist();
    initFirebaseListeners();
    console.log('[CP] Control Panel iniciado correctamente');
  } catch (e) {
    console.error('[CP] Error en init:', e);
    showToast('Error iniciando panel: ' + e.message, 'error');
  }
}

init();
