/*
 * script.js — front do Trabalho PI ("Peixes Estranhos")
 *
 * Carregue DEPOIS do cripto.js (usa criptografarArquivo, descriptografarResposta e baixarBlob).
 *
 * Fluxo de um arquivo solto no anzol:
 *   1. lê o CSV no navegador só para mostrar as fichas das colunas (nada é enviado ainda);
 *   2. cifra o arquivo com a senha digitada (cripto.js);
 *   3. envia para POST /train (modo treino) ou POST /predict (modo teste/aplicação);
 *   4. no teste/aplicação, baixa GET /download (cifrado) e decifra no navegador;
 *   5. mostra o relatório enquanto o anzol desce até o fundo.
 *
 * Rotas usadas: GET /status · POST /train · POST /predict · GET /download · POST /reset
 *               GET /graficos/treino · GET /graficos/teste
 */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const rnd = (a, b) => a + Math.random() * (b - a);

const FEATURES = ['time-5', 'time-4', 'time-3', 'time-2', 'time-1'];
const ALVO = 'time';

/* =========================================================================
   1. API
   ========================================================================= */
const API_PADRAO = 'http://localhost:8000';
const apiInput = $('#apiUrl');
function lerApiSalva() { try { return localStorage.getItem('pi-api') || ''; } catch (e) { return ''; } }
function salvarApi(v) { try { localStorage.setItem('pi-api', v); } catch (e) {} }
apiInput.value = lerApiSalva() || API_PADRAO;
const apiBase = () => (apiInput.value.trim() || API_PADRAO).replace(/\/+$/, '');

// fetch + tratamento de erro: a API manda {"detail": "..."} quando algo dá errado
async function apiFetch(rota, opcoes) {
  let resp;
  try {
    resp = await fetch(apiBase() + rota, opcoes);
  } catch (e) {
    throw new Error(`Não consegui falar com a API em ${apiBase()}. Ela está rodando?`);
  }
  if (!resp.ok) {
    let msg = `Erro ${resp.status} na API.`;
    try { const j = await resp.json(); if (j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch (e) {}
    throw new Error(msg);
  }
  return resp;
}
const apiJson = async (rota, opcoes) => (await apiFetch(rota, opcoes)).json();

/* =========================================================================
   2. Painel da nuvem (status, endereço, reset)
   ========================================================================= */
const cloudPill = $('#cloudPill'), cabin = $('#cabin');
let statusApi = null;          // última resposta de /status (null = offline)
let modoEscolhido = false;     // o usuário clicou num modo nesta visita?
let modo = 'treino';           // 'treino' ou 'teste'

cloudPill.addEventListener('click', () => {
  const abrir = cabin.hidden;
  cabin.hidden = !abrir;
  cloudPill.setAttribute('aria-expanded', String(abrir));
});
document.addEventListener('click', e => {
  if (!cabin.hidden && !cabin.contains(e.target) && !cloudPill.contains(e.target)) {
    cabin.hidden = true; cloudPill.setAttribute('aria-expanded', 'false');
  }
});
apiInput.addEventListener('change', () => { salvarApi(apiInput.value.trim()); atualizarStatus(); });
$('#checkApi').addEventListener('click', atualizarStatus);

async function atualizarStatus() {
  setNuvem('', 'conectando…');
  try {
    statusApi = await apiJson('/status');
  } catch (e) {
    statusApi = null;
  }
  desenharStatus();
}

function desenharStatus() {
  const cm = $('#cabinModel');
  if (!statusApi) {
    setNuvem('off', 'nuvem offline');
    cm.innerHTML = `Sem resposta de <b>${esc(apiBase())}</b>.<br>Confira o endereço e se o container está rodando.`;
  } else if (statusApi.modelo_treinado) {
    const d = statusApi.desempenho_esperado || {};
    setNuvem('ok', `modelo treinado · RMSE ${fmt(d.rmse)}`);
    cm.innerHTML = `Modelo treinado com <b>${int(d.linhas_treino || 0)}</b> linhas.<br>` +
      `Esperado: RMSE <b>${fmt(d.rmse)}</b> · MAE <b>${fmt(d.mae)}</b> · R² <b>${fmt(d.r2)}</b>` +
      (d.melhor_k != null ? `<br>k escolhido: <b>${d.melhor_k}</b>` : '');
  } else {
    setNuvem('idle', 'nuvem ok · sem modelo');
    cm.innerHTML = 'Nenhum modelo treinado. Solte um CSV de <b>treino</b> no anzol.';
  }
  // Sem modelo não dá para testar; com modelo, o padrão passa a ser o teste
  const treinado = !!(statusApi && statusApi.modelo_treinado);
  $('.mode[data-mode=teste]').disabled = statusApi !== null && !treinado;
  if (statusApi && !treinado) setModo('treino');
  else if (treinado && !modoEscolhido) setModo('teste');
  $('#resetModel').disabled = !treinado;
}
function setNuvem(cls, txt) { $('#cloudDot').className = 'dot ' + cls; $('#cloudText').textContent = txt; }

// reset em dois cliques (o primeiro "arma" o botão por 3 s)
const resetBtn = $('#resetModel');
let resetArmado = null;
resetBtn.addEventListener('click', async () => {
  if (!resetArmado) {
    resetBtn.classList.add('armed'); resetBtn.textContent = 'confirmar reset?';
    resetArmado = setTimeout(desarmarReset, 3000);
    return;
  }
  desarmarReset();
  resetBtn.disabled = true;
  try {
    await apiJson('/reset', { method: 'POST' });
    modoEscolhido = false;
    if (S.state !== 'idle') startReel();
    await atualizarStatus();
    $('#cabinModel').innerHTML = 'Modelo apagado. Pronto para treinar em outra base.';
  } catch (e) {
    $('#cabinModel').innerHTML = `<span style="color:var(--coral)">${esc(e.message)}</span>`;
    resetBtn.disabled = false;
  }
});
function desarmarReset() { clearTimeout(resetArmado); resetArmado = null; resetBtn.classList.remove('armed'); resetBtn.textContent = 'resetar modelo'; }

/* modo treino / teste */
document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => {
  if (b.disabled) return;
  modoEscolhido = true; setModo(b.dataset.mode);
}));
function setModo(m) {
  modo = m;
  document.querySelectorAll('.mode').forEach(b => {
    const on = b.dataset.mode === m;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
  });
  $('#callMode').textContent = m === 'treino' ? 'treino' : 'teste';
  $('#callHint').textContent = m === 'treino'
    ? 'colunas time-5 … time-1 e time · ou toque no anzol para escolher'
    : 'com a coluna time é avaliado · sem ela, só previsões · ou toque no anzol';
}

/* =========================================================================
   3. Cenário: bolhas, peixes, escuridão
   ========================================================================= */
const weird = $('#weird');
weird.innerHTML = [...weird.textContent].map((c, i) => `<span style="animation-delay:${i * 0.11}s">${c}</span>`).join('');

const bwrap = $('#bubbles');
for (let i = 0; i < 22; i++) {
  const b = document.createElement('span'); b.className = 'bubble'; const s = 4 + Math.random() * 16;
  Object.assign(b.style, { left: Math.random() * 100 + 'vw', width: s + 'px', height: s + 'px', animationDuration: (9 + Math.random() * 14) + 's', animationDelay: (-Math.random() * 20) + 's' });
  bwrap.appendChild(b);
}
function burst(cx, cy, n = 8, sand = false) {
  for (let i = 0; i < n; i++) {
    const p = document.createElement('span'); p.className = 'pop' + (sand ? ' sand' : ''); const s = sand ? rnd(4, 9) : rnd(4, 12);
    Object.assign(p.style, { left: (cx - s / 2 + rnd(-24, 24)) + 'px', top: (cy - s / 2 + rnd(-8, 8)) + 'px', width: s + 'px', height: s + 'px', animationDelay: (i * 35) + 'ms' });
    p.style.setProperty('--dx', rnd(-40, 40) + 'px'); if (sand) p.style.setProperty('--dy', rnd(-70, -30) + 'px');
    document.body.appendChild(p); setTimeout(() => p.remove(), 2000);
  }
}

const SVG = {
angler:`<svg viewBox="0 0 150 100"><path d="M64 30 Q72 2 112 14" fill="none" stroke="#5b6b85" stroke-width="2.2" stroke-linecap="round"/><circle class="lure" cx="114" cy="17" r="5.5" fill="#ffe28a"/><path d="M24 56 L4 36 Q8 56 4 76 Z" fill="#232a44"/><path d="M22 56 Q26 26 66 28 Q104 30 116 54 Q108 82 66 84 Q30 86 22 56 Z" fill="#2c3554"/><path d="M40 42 Q58 36 78 40 M36 64 Q56 72 76 70" stroke="#3a4670" stroke-width="2" fill="none"/><path d="M116 54 Q100 60 84 58 Q98 74 114 68 Z" fill="#0a0d18"/><path d="M88 58 l3 6 l3 -6 l3 7 l3 -7 l3 6 l3 -6 l3 6" fill="none" stroke="#e8f4ff" stroke-width="1.4" stroke-linejoin="round"/><circle cx="92" cy="44" r="6" fill="#dfe9ff"/><circle cx="93.5" cy="44" r="3" fill="#0a0d18"/><path d="M58 74 Q52 94 40 90 Q48 82 50 74Z" fill="#232a44"/></svg>`,
blob:`<svg viewBox="0 0 120 90"><path d="M18 48 L4 36 Q8 48 6 62 Z" fill="#d98a9c"/><path d="M16 50 Q20 16 66 18 Q104 20 108 50 Q108 76 70 80 Q30 84 16 50 Z" fill="#f0a9b9"/><ellipse cx="54" cy="30" rx="16" ry="5" fill="#fff" opacity=".25"/><ellipse cx="99" cy="56" rx="14" ry="11" fill="#e7909f"/><circle cx="82" cy="40" r="3.4" fill="#2a1520"/><path d="M82 72 Q91 66 100 72" stroke="#8a3a50" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M46 60 Q54 70 50 78" stroke="#d98a9c" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
hatchet:`<svg viewBox="0 0 100 100"><defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef6ff"/><stop offset="1" stop-color="#7f93ad"/></linearGradient></defs><path d="M18 44 L3 34 L6 46 L3 58 Z" fill="#9fb2c8"/><path d="M16 44 Q40 30 70 22 Q90 22 90 40 Q80 64 58 88 Q44 70 16 44 Z" fill="url(#hg)"/><path class="glowdot" d="M28 52 Q46 66 58 84" stroke="#5cf2ff" stroke-width="2.6" stroke-dasharray=".5 5" stroke-linecap="round" fill="none"/><circle cx="76" cy="34" r="9" fill="#fff"/><circle cx="77" cy="30" r="5" fill="#101826"/></svg>`,
barreleye:`<svg viewBox="0 0 150 80"><path d="M24 46 L6 32 Q10 46 6 60 Z" fill="#18222f"/><path d="M22 46 Q42 26 92 30 Q120 34 124 48 Q118 62 88 64 Q42 68 22 46 Z" fill="#26364a"/><path d="M70 33 Q78 4 110 14 Q124 26 118 42 Q96 36 70 33 Z" fill="rgba(170,245,255,.16)" stroke="rgba(200,255,255,.6)" stroke-width="1.2"/><g class="eyeglow"><circle cx="96" cy="23" r="5" fill="#7dff9a"/><circle cx="105" cy="26" r="4" fill="#5fe27e"/></g><circle cx="122" cy="48" r="1.6" fill="#0b1118"/><path d="M60 62 Q56 76 46 74 Z" fill="#18222f"/></svg>`,
mola:`<svg viewBox="0 0 120 140"><path d="M56 36 Q58 2 74 6 Q70 22 72 36 Z" fill="#8292a3"/><path d="M56 104 Q58 138 74 134 Q70 118 72 104 Z" fill="#8292a3"/><path d="M26 40 Q10 50 18 60 Q8 70 18 80 Q10 90 26 100 Z" fill="#8292a3"/><ellipse cx="62" cy="70" rx="42" ry="38" fill="#aab8c6"/><ellipse cx="60" cy="84" rx="36" ry="18" fill="#cdd7e2" opacity=".5"/><g fill="#8292a3" opacity=".5"><circle cx="44" cy="56" r="3"/><circle cx="56" cy="48" r="2"/><circle cx="40" cy="78" r="2.4"/></g><circle cx="90" cy="60" r="4.5" fill="#fff"/><circle cx="91" cy="60" r="2.4" fill="#18202a"/><ellipse cx="103" cy="71" rx="2.5" ry="3.5" fill="#55606c"/><path d="M80 74 Q84 66 80 58" stroke="#8292a3" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
jelly:`<svg viewBox="0 0 80 130"><g fill="none" stroke="rgba(255,170,230,.55)" stroke-width="1.6" stroke-linecap="round"><path d="M16 44 Q10 70 18 92 Q24 110 16 128"/><path d="M30 46 Q36 74 28 98 Q24 112 30 124"/><path d="M50 46 Q44 72 52 96 Q56 110 50 122"/><path d="M64 44 Q70 70 62 92 Q58 108 66 126"/></g><path d="M6 42 Q8 4 40 4 Q72 4 74 42 Q62 48 52 44 Q40 50 28 44 Q16 48 6 42Z" fill="rgba(255,150,220,.36)" stroke="rgba(255,195,240,.75)"/><ellipse cx="40" cy="24" rx="17" ry="9" fill="rgba(255,225,250,.35)"/></svg>`,
lantern:`<svg viewBox="0 0 90 50"><path d="M14 25 L2 14 L5 25 L2 36Z" fill="#3a4a6a"/><path d="M12 25 Q30 8 64 12 Q86 16 86 26 Q80 38 60 40 Q28 42 12 25Z" fill="#46587d"/><g class="glowdot" fill="#8ff7ff"><circle cx="30" cy="34" r="1.8"/><circle cx="40" cy="36" r="1.8"/><circle cx="50" cy="37" r="1.8"/><circle cx="60" cy="36" r="1.8"/><circle cx="70" cy="33" r="1.8"/></g><circle cx="74" cy="22" r="5" fill="#e8f0ff"/><circle cx="75" cy="22" r="2.6" fill="#0c1220"/></svg>`
};
// tipo, quantidade, largura, velocidade (px/s), faixa vertical da tela, profundidade preferida (0 topo → 1 fundo)
const CAST = [['mola',1,120,11,[.15,.45],.05],['blob',1,105,15,[.35,.7],.25],['jelly',2,58,0,[0,1],.4],
  ['hatchet',3,50,38,[.25,.6],.55],['lantern',3,58,52,[.45,.85],.65],['barreleye',1,140,24,[.2,.55],.75],['angler',1,150,20,[.55,.85],.92]];
const school = $('#school'), fishes = [];
let W = innerWidth, H = innerHeight, progress = 0, fishOn = false, fishFade = 0;
CAST.forEach(([type, count, w, speed, band, zone]) => {
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div'); el.className = 'fish ' + type; el.innerHTML = SVG[type];
    const ww = w * (W < 600 ? .65 : 1) * rnd(.85, 1.1); el.style.width = ww + 'px'; school.appendChild(el);
    const dir = Math.random() < .5 ? 1 : -1; el.firstChild.style.transform = `scaleX(${dir})`;
    fishes.push({ el, type, w: ww, speed: speed * rnd(.8, 1.25), band, zone, dir, x: 0, y0: rnd(band[0], band[1]), amp: rnd(6, 20), freq: rnd(.4, 1.1), phase: rnd(0, 6.28), off: 0, jy: 0 });
  }
});
function soltarPeixes() {
  if (fishOn) return; fishOn = true;
  fishes.forEach(f => {
    if (f.type === 'jelly') { f.x = rnd(0, W - 60); f.jy = H + rnd(0, 300); }
    else f.x = f.dir > 0 ? -f.w - rnd(0, 400) : W + rnd(0, 400);
  });
}
const mouse = { x: -999, y: -999 };
addEventListener('pointermove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
addEventListener('resize', () => { W = innerWidth; H = innerHeight; });
function moverPeixe(f, t, dt) {
  let x, y;
  if (f.type === 'jelly') {
    f.jy -= 18 * dt; if (f.jy < -160) { f.jy = H + 40; f.x = rnd(0, W - 60); }
    x = f.x + Math.sin(t * .0004 + f.phase) * 30; y = f.jy;
  } else {
    f.x += f.speed * f.dir * dt;
    if (f.dir > 0 && f.x > W + 20) { f.x = -f.w - 20; f.y0 = rnd(f.band[0], f.band[1]); }
    if (f.dir < 0 && f.x < -f.w - 20) { f.x = W + 20; f.y0 = rnd(f.band[0], f.band[1]); }
    x = f.x; y = f.y0 * H + Math.sin(t * .001 * f.freq + f.phase) * f.amp;
  }
  // foge do cursor
  const dx = mouse.x - (x + f.w / 2), dy = mouse.y - (y + f.w * .3), d = Math.hypot(dx, dy);
  const alvo = d < 160 ? -(Math.sign(dy) || 1) * (160 - d) * .7 : 0;
  f.off += (alvo - f.off) * .06;
  f.el.style.transform = `translate3d(${x}px,${y + f.off}px,0)`;
  const vis = Math.max(0, 1 - Math.abs(progress - f.zone) / .6);
  f.el.style.opacity = ((.28 + .72 * vis) * fishFade).toFixed(2);
}

const abyss = $('#abyss');
function onScroll() {
  const max = document.documentElement.scrollHeight - innerHeight;
  progress = max > 0 ? Math.min(1, scrollY / max) : 0;
  abyss.style.opacity = (progress * .8).toFixed(3);
  // rolou por conta própria (barra de rolagem, teclado, toque)? a câmera para de seguir
  if (S.state === 'descending' && S.follow && Math.abs(scrollY - S.lastScroll) > 40) S.follow = false;
}
addEventListener('scroll', onScroll, { passive: true });

/* =========================================================================
   4. Linha e anzol (máquina de estados: idle → catching → descending → reeling)
   ========================================================================= */
const line = $('#line'), rig = $('#rig'), rigInner = $('#rigInner'), paper = $('#paper'), sheet = $('#sheet'),
  dval = $('#dval'), dstat = $('#dstat'), call = $('#call'), errEl = $('#err'), deep = $('#deep'), seabed = $('#seabed'),
  results = $('#results'), followBtn = $('#follow'), fileInput = $('#arquivo'), trench = $('#trench'), logEl = $('#log');

// velocidade da descida por tamanho do arquivo (px/s = BASE × mult)
const BASE = 300, METROS_POR_PX = .55;
const PESOS = [
  { max: 20e3, nome: 'isca leve', mult: 1 },
  { max: 500e3, nome: 'peixe médio', mult: 1.6 },
  { max: 10e6, nome: 'peixe pesado', mult: 2.5 },
  { max: 100e6, nome: 'monstro', mult: 4 },
  { max: Infinity, nome: 'leviatã', mult: 6.5 },
];
const pesoDe = size => PESOS.find(t => size < t.max);
const S = { state: 'idle', x: innerWidth / 2, y: innerHeight * .26, vy: 0, peso: PESOS[0], follow: true, ready: false, landed: false, paper: false, pending: null, lastScroll: 0 };
const escala = () => innerWidth < 700 ? .72 : 1;
const startY = () => innerHeight * .26;
const docTop = el => el.getBoundingClientRect().top + scrollY;
const laneX = () => { const r = deep.getBoundingClientRect(); return (r.right + innerWidth) / 2; };
const waitY = () => docTop(trench) + trench.offsetHeight - 300 * escala();
const floorY = () => docTop(seabed) + seabed.offsetHeight * .875 - 290 * escala() + 18;

function moverAnzol(t, dt) {
  const s = escala();
  const parado = S.state === 'idle' || S.state === 'catching';
  S.x += ((parado ? innerWidth / 2 : laneX()) - S.x) * Math.min(1, dt * 1.8);
  if (parado) S.y += (startY() - S.y) * Math.min(1, dt * 4);
  else if (S.state === 'descending') {
    const alvo = S.ready ? floorY() : waitY(), vmax = BASE * S.peso.mult * (reduce ? 4 : 1);
    if (S.y < alvo - .5) {
      S.vy = Math.min(vmax, S.vy + vmax * 1.4 * dt, (alvo - S.y) * 2.2 + 12);
      S.y = Math.min(alvo, S.y + S.vy * dt);
    } else { S.vy = 0; S.y = alvo; if (S.ready && !S.landed) pousar(); }
  } else if (S.state === 'reeling') {
    const alvo = startY();
    S.vy = Math.min(3400, S.vy + 5200 * dt, (S.y - alvo) * 3 + 40);
    S.y = Math.max(alvo, S.y - S.vy * dt);
    if (S.y <= alvo + .5) terminarRecolha();
  }
  const quieto = parado || (S.state === 'descending' && S.vy === 0);
  const bob = quieto ? Math.sin(t * .0016) * 4 : 0, sway = Math.sin(t * .0011) * 6;
  const eyeX = S.x + sway, eyeY = S.y + bob, topX = S.x;
  const ddx = eyeX - topX, ddy = Math.max(1, eyeY - 6 * s), L = Math.hypot(ddx, ddy), th = Math.atan2(-ddx, ddy);
  line.style.height = L + 'px';
  line.style.transform = `translate(${topX}px,0) rotate(${th}rad)`;
  rig.style.transform = `translate(${eyeX}px,${eyeY}px) rotate(${th}rad) scale(${s})`;
  if (S.paper) {
    const k = S.state === 'descending' ? S.vy / (BASE * S.peso.mult) : S.state === 'reeling' ? .8 : 0;
    sheet.style.transform = `rotate(${Math.sin(t * .004) * (3 + k * 10) + k * 5}deg)`;
  }
  const m = Math.max(0, Math.round((S.y - startY()) * METROS_POR_PX));
  dval.textContent = S.state === 'idle' ? '' : (m ? '−' : '') + m.toLocaleString('pt-BR') + ' m';
  if (S.follow && ((S.state === 'descending' && !S.landed) || S.state === 'reeling')) {
    scrollTo(0, Math.max(0, eyeY - innerHeight * .4));
    S.lastScroll = scrollY;
  }
  followBtn.classList.toggle('on', !S.follow && S.state === 'descending' && !S.landed);
}

let last = performance.now();
function tick(t) {
  const dt = Math.min(.05, (t - last) / 1000); last = t;
  if (fishOn) { fishFade = Math.min(1, fishFade + dt * .5); const fdt = reduce ? 0 : dt; fishes.forEach(f => moverPeixe(f, t, fdt)); }
  moverAnzol(t, dt);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// rolar a página "solta" a câmera; o botão devolve
const soltarCamera = () => { if (S.state === 'descending') S.follow = false; };
addEventListener('wheel', soltarCamera, { passive: true });
addEventListener('touchmove', soltarCamera, { passive: true });
addEventListener('keydown', e => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key) && e.target.tagName !== 'INPUT') soltarCamera(); });
followBtn.addEventListener('click', () => { S.follow = true; });

/* =========================================================================
   5. Receber o arquivo
   ========================================================================= */
const ehCsv = f => /\.csv$/i.test(f.name) || /csv/.test(f.type);
const nomeCurto = n => n.length > 30 ? n.slice(0, 19) + '…' + n.slice(-10) : n;
const bytes = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1).replace('.', ',') + ' KB' : (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
const abrirSeletor = () => fileInput.click();
const erro = t => { errEl.textContent = t; };

$('#hookSvg').addEventListener('click', abrirSeletor);
$('#hookSvg').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirSeletor(); } });
$('#callTitle').addEventListener('click', abrirSeletor);
$('#senha').addEventListener('keydown', e => { if (e.key === 'Enter') abrirSeletor(); });
fileInput.addEventListener('change', () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) receber(f, null); });
let dragDepth = 0;
const faminto = on => { rig.classList.toggle('hungry', on); call.classList.toggle('hungry', on); };
addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; faminto(true); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; faminto(false); } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; faminto(false);
  const f = e.dataTransfer.files[0]; if (f) receber(f, { x: e.clientX, y: e.clientY + scrollY });
});
$('#reel').addEventListener('click', startReel);

async function lerCabecalho(file) {
  const txt = await file.slice(0, 64 * 1024).text();
  const primeira = txt.replace(/^﻿/, '').split(/\r?\n/)[0] || '';
  return primeira.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
}

async function receber(file, pt) {
  erro('');
  if (!ehCsv(file)) { erro('Isso não parece um CSV. O anzol só morde .csv'); return; }
  const senha = $('#senha').value;
  if (!senha) {
    erro('Digite a senha da linha antes de soltar o arquivo.');
    const s = $('.senha'); s.classList.remove('shake'); void s.offsetWidth; s.classList.add('shake'); $('#senha').focus();
    if (S.state !== 'idle') startReel();
    return;
  }
  const cab = await lerCabecalho(file);
  const exigidas = modo === 'treino' ? [...FEATURES, ALVO] : FEATURES;
  const faltando = exigidas.filter(c => !cab.includes(c));
  if (faltando.length) {
    erro(`O CSV de ${modo === 'treino' ? 'treino' : 'teste'} precisa das colunas: ${faltando.join(', ')}` +
      (cab.length === 1 && cab[0].includes(';') ? ' (o separador deve ser vírgula)' : ''));
    if (S.state !== 'idle') startReel();
    return;
  }
  const pedido = { file, senha, modo, temRotulo: cab.includes(ALVO) };
  if (S.state === 'idle') return engancharArquivo(pedido, pt);
  if (S.state === 'catching') return;
  S.pending = pedido; startReel();
}

function engancharArquivo(pedido, pt) {
  const { file } = pedido;
  S.state = 'catching'; S.peso = pesoDe(file.size); S.ready = false; S.landed = false; S.vy = 0;
  const tipo = pedido.modo === 'treino' ? 'treino' : pedido.temRotulo ? 'teste' : 'aplicação';
  $('#pname').textContent = nomeCurto(file.name);
  $('#pmeta').textContent = bytes(file.size) + ' · ' + tipo;
  sheet.classList.remove('sealed');
  // o papel voa até o anzol
  const s = escala(), de = pt || { x: innerWidth * .85, y: scrollY - 120 };
  const dx = (de.x - S.x) / s + 15, dy = (de.y - S.y) / s - 120;
  paper.style.transition = 'none'; paper.style.opacity = '0';
  paper.style.transform = `translate(${dx}px,${dy}px) rotate(-35deg) scale(.5)`;
  paper.getBoundingClientRect();
  paper.style.transition = 'transform .75s cubic-bezier(.2,.9,.25,1.15),opacity .25s';
  paper.style.opacity = '1'; paper.style.transform = 'none';
  S.paper = true; call.classList.add('gone');
  setTimeout(() => {
    rigInner.classList.remove('jerk'); void rigInner.offsetWidth; rigInner.classList.add('jerk');
    const r = rig.getBoundingClientRect(); burst(r.left, r.top + 90 * s, 10);
    soltarPeixes(); abrirFundo(pedido, tipo); processar(pedido, tipo);
  }, 720);
  setTimeout(() => { if (S.state === 'catching') { S.state = 'descending'; S.vy = 0; S.follow = true; } }, 1500);
}

function abrirFundo(pedido, tipo) {
  results.innerHTML = ''; logEl.innerHTML = '';
  const rota = pedido.modo === 'treino' ? 'POST /train' : 'POST /predict';
  $('#trenchEyebrow').textContent = pedido.modo === 'treino' ? 'treino do modelo na nuvem' : (tipo === 'teste' ? 'teste com rótulo' : 'aplicação sem rótulo');
  $('#weight').innerHTML = `<span class="chip">isca: <b>${esc(pedido.file.name)}</b></span><span class="chip">${bytes(pedido.file.size)}</span>` +
    `<span class="chip">destino: <b>${rota}</b></span><span class="chip">peso: <b>${S.peso.nome}</b> · descida ${String(S.peso.mult).replace('.', ',')}×</span>`;
  deep.classList.add('on'); onScroll();
}

function pousar() {
  S.landed = true; dstat.textContent = 'no fundo';
  const r = paper.getBoundingClientRect(); burst(r.left + r.width / 2, r.bottom - 14, 14, true);
}

function startReel() {
  if (S.state === 'catching') { setTimeout(startReel, 900); return; }
  if (S.state === 'reeling' || S.state === 'idle') return;
  job++; S.state = 'reeling'; S.vy = 0; S.follow = true; dstat.textContent = '';
}
function terminarRecolha() {
  S.state = 'idle'; S.vy = 0; S.paper = false; S.ready = false; S.landed = false;
  paper.style.transition = 'opacity .4s'; paper.style.opacity = '0';
  deep.classList.remove('on'); seabed.classList.remove('on'); results.innerHTML = ''; logEl.innerHTML = '';
  scrollTo(0, 0); onScroll(); call.classList.remove('gone'); dstat.textContent = '';
  if (S.pending) { const p = S.pending; S.pending = null; setTimeout(() => engancharArquivo(p, null), 450); }
}

/* =========================================================================
   6. Ida e volta do arquivo (diário de bordo)
   ========================================================================= */
let job = 0;
function passo(html) {
  const li = document.createElement('li'); li.className = 'run'; li.innerHTML = `<span>${html}</span>`; logEl.appendChild(li);
  return li;
}
const ok = (li, html) => { li.className = 'ok'; if (html) li.innerHTML = `<span>${html}</span>`; };
const falha = (li, msg) => { li.className = 'bad'; li.innerHTML = `<span>${esc(msg)}</span>`; };
const segundos = ms => (ms / 1000).toFixed(1).replace('.', ',') + ' s';

async function processar(pedido, tipo) {
  const meu = ++job, { file, senha } = pedido;
  const vivo = () => meu === job;
  let li = null;
  try {
    // 1) leitura local, só para as fichas das colunas
    li = passo('lendo o CSV no navegador…'); dstat.textContent = 'lendo';
    const local = await lerLocal(file);
    if (!vivo()) return;
    ok(li, `CSV lido no navegador: <b>${int(local.n)}</b> linhas · <b>${local.cols.length}</b> colunas`);

    // 2) cifra com a senha (cripto.js)
    li = passo('cifrando com a senha…'); dstat.textContent = 'cifrando';
    const cifrado = await criptografarArquivo(file, senha);
    if (!vivo()) return;
    sheet.classList.add('sealed');
    ok(li, `cifrado no navegador (XOR + assinatura <b>PI</b> + checksum): ${bytes(file.size)} → ${bytes(cifrado.size)}`);

    // 3) envia para a nuvem
    const rota = pedido.modo === 'treino' ? '/train' : '/predict';
    li = passo(`enviando para <b>POST ${rota}</b>…`); dstat.textContent = 'na nuvem';
    const form = new FormData(); form.append('arquivo', cifrado, 'dados.cripto');
    const t0 = performance.now();
    const resp = await apiJson(rota, { method: 'POST', body: form });
    const tempo = performance.now() - t0;
    if (!vivo()) return;
    ok(li, pedido.modo === 'treino'
      ? `nuvem decifrou, aplicou min-max e treinou o modelo em <b>${segundos(tempo)}</b>`
      : `nuvem decifrou, aplicou o min-max do treino e previu <b>${int(resp.linhas_previstas)}</b> linhas em <b>${segundos(tempo)}</b>`);

    // a API decide se é teste ou aplicação olhando se 'time' tem valores;
    // se veio a coluna vazia, corrige o rótulo do papel e do cabeçalho
    if (pedido.modo !== 'treino' && !resp.desempenho_real && tipo !== 'aplicação') {
      $('#pmeta').textContent = bytes(file.size) + ' · aplicação';
      $('#trenchEyebrow').textContent = 'aplicação sem rótulo';
    }

    // 4) previsões voltam cifradas
    let prev = null, prevBlob = null;
    if (pedido.modo !== 'treino') {
      li = passo('baixando as previsões de <b>GET /download</b>…'); dstat.textContent = 'decifrando';
      let r;
      try { r = await fetch(apiBase() + '/download'); } catch (e) { throw new Error('Não consegui baixar as previsões da API.'); }
      prevBlob = await descriptografarResposta(r, senha);
      prev = lerPrevisoes(await prevBlob.text());
      if (!vivo()) return;
      ok(li, `previsões chegaram cifradas e foram decifradas no navegador (checksum ok) · <b>${int(prev.rows.length)}</b> linhas`);
    }

    // 5) relatório
    if (pedido.modo === 'treino') desenharTreino(file, local, resp, tempo);
    else if (resp.desempenho_real) desenharTeste(file, resp, prev, prevBlob, tempo);
    else desenharAplicacao(file, resp, prev, prevBlob, tempo);
    passo('relatório pronto. Descendo até ele.').className = 'ok';
    S.ready = true; dstat.textContent = '';
    if (pedido.modo === 'treino') { modoEscolhido = false; atualizarStatus(); }
  } catch (e) {
    if (!vivo()) return;
    if (li) falha(li, e.message);
    dstat.textContent = 'linha partida';
    erro(e.message);
    S.pending = null;
    setTimeout(() => { if (vivo()) startReel(); }, 2600);
  }
}

/* CSV de previsões devolvido pela API (separador vírgula, só números) */
function lerPrevisoes(txt) {
  const linhas = txt.replace(/^﻿/, '').trim().split(/\r?\n/);
  const fields = linhas[0].split(',');
  const rows = linhas.slice(1).map(l => {
    const c = l.split(','), o = {};
    fields.forEach((f, i) => { const v = c[i]; o[f] = v === '' || v == null ? null : Number(v); });
    return o;
  });
  return { fields, rows };
}

/* =========================================================================
   7. Leitura local (estatísticas das colunas, em pedaços)
   ========================================================================= */
const AMOSTRA = 20000, CHUNK = 2 * 1024 * 1024;
function toNum(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim(); if (!s) return null;
  const n = Number(/^-?\d+,\d+$/.test(s) ? s.replace(',', '.') : s);
  return isFinite(n) ? n : null;
}
function novoAcumulador(fields) {
  return { fields, n: 0, cols: fields.map(name => ({ name, present: 0, nums: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity, res: [], seen: 0 })) };
}
function alimentar(acc, rows) {
  for (const row of rows) {
    acc.cols.forEach(c => {
      const v = row[c.name];
      if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return;
      c.present++;
      const x = toNum(v); if (x === null) return;
      c.nums++; const d = x - c.mean; c.mean += d / c.nums; c.m2 += d * (x - c.mean);
      if (x < c.min) c.min = x; if (x > c.max) c.max = x;
      c.seen++; if (c.res.length < AMOSTRA) c.res.push(x); else { const k = Math.floor(Math.random() * c.seen); if (k < AMOSTRA) c.res[k] = x; }
    });
    acc.n++;
  }
}
function histograma(s, min, max, b = 16) {
  if (min === max) return [s.length];
  const w = (max - min) / b, h = new Array(b).fill(0);
  for (const v of s) h[Math.min(b - 1, Math.max(0, Math.floor((v - min) / w)))]++;
  return h;
}
function fechar(acc) {
  return {
    n: acc.n,
    cols: acc.cols.map(c => {
      const o = { name: c.name, present: c.present, missing: acc.n - c.present, numeric: c.present > 0 && c.nums / c.present >= .9 };
      if (o.numeric) {
        const s = c.res.sort((a, b) => a - b);
        const q = p => { const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
        Object.assign(o, { mean: c.mean, sd: c.nums > 1 ? Math.sqrt(c.m2 / (c.nums - 1)) : 0, min: c.min, max: c.max, median: q(.5), q1: q(.25), q3: q(.75), hist: histograma(s, c.min, c.max) });
      }
      return o;
    })
  };
}
function lerLocal(file) {
  return new Promise((resolve, reject) => {
    if (!window.Papa) {   // sem a biblioteca: leitura simples
      file.text().then(t => {
        const linhas = t.replace(/^﻿/, '').trim().split(/\r?\n/), fields = linhas[0].split(',').map(s => s.trim());
        const acc = novoAcumulador(fields);
        alimentar(acc, linhas.slice(1).map(l => { const c = l.split(','), o = {}; fields.forEach((f, i) => o[f] = c[i]); return o; }));
        resolve(fechar(acc));
      }).catch(() => reject(new Error('Não consegui ler o CSV no navegador.')));
      return;
    }
    let acc = null;
    Papa.parse(file, {
      header: true, dynamicTyping: true, skipEmptyLines: 'greedy', chunkSize: CHUNK,
      chunk: res => { if (!acc) acc = novoAcumulador((res.meta.fields || []).filter(Boolean)); alimentar(acc, res.data); },
      complete: () => acc && acc.n ? resolve(fechar(acc)) : reject(new Error('O arquivo veio vazio.')),
      error: () => reject(new Error('Não consegui ler o CSV no navegador.'))
    });
  });
}

/* =========================================================================
   8. Relatórios
   ========================================================================= */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, casas = 2) => {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e5) return v.toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 2 });
  return v.toLocaleString('pt-BR', { maximumFractionDigits: a < 1 && a > 0 ? 3 : casas });
};
const int = v => Number(v).toLocaleString('pt-BR');
const ANGLER_SMALL = SVG.angler.replace('<svg ', '<svg aria-hidden="true" ');

function cabecalho(eyebrow, titulo, meta, extra = '') {
  return `<div class="reveal"><div class="section-head"><div><div class="eyebrow">${eyebrow}</div><h3 class="big">${titulo}</h3></div>${meta ? `<div class="meta">${meta}</div>` : ''}${extra}</div></div>`;
}
const bolhas = itens => `<div class="bubbles-row reveal">${itens.map(([v, l, warn], i) =>
  `<div class="bub${warn ? ' warn' : ''}" style="animation-delay:${i * 90}ms,-${i * 1.3}s"><b>${v}</b><span>${l}</span></div>`).join('')}</div>`;
const anotacoes = (titulo, linhas) => `<div class="panel notes reveal">${ANGLER_SMALL}<div><h4>${titulo}</h4><ul>${linhas.map(l =>
  typeof l === 'string' ? `<li>${esc(l)}</li>` : `<li class="${l.cls || ''}">${l.html}</li>`).join('')}</ul></div></div>`;
const grafico = (rota, legenda) => `<figure class="panel chart reveal" data-grafico><img alt="${esc(legenda)}" src="${apiBase()}${rota}?t=${Date.now()}"><figcaption>${esc(legenda)} · gerado na nuvem (${rota})</figcaption></figure>`;

function finalizarRelatorio() {
  results.querySelectorAll('[data-grafico] img').forEach(img => img.addEventListener('error', () => img.closest('figure').remove()));
  results.querySelectorAll('[data-act=testar]').forEach(b => b.addEventListener('click', () => { modoEscolhido = true; setModo('teste'); abrirSeletor(); }));
  results.querySelectorAll('[data-act=outro]').forEach(b => b.addEventListener('click', abrirSeletor));
  results.querySelectorAll('[data-act=baixar]').forEach(b => b.addEventListener('click', () => baixarBlob(ultimoBlob, ultimoNome)));
  seabed.classList.add('on');
  $('#floorText').textContent = 'fundo do aquário · ' + Math.round((floorY() - startY()) * METROS_POR_PX).toLocaleString('pt-BR') + ' m';
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    e.target.classList.add('shown');
    e.target.querySelectorAll('.cmp-bar .track i').forEach(i => { i.style.width = i.dataset.w; });
    io.unobserve(e.target);
  }), { threshold: .12 });
  results.querySelectorAll('.reveal').forEach(el => io.observe(el));
}

/* --- treino: desempenho esperado --- */
function desenharTreino(file, local, resp, tempo) {
  const d = resp.desempenho_esperado || {};
  const itens = [[fmt(d.rmse), 'RMSE esperado'], [fmt(d.mae), 'MAE esperado'], [fmt(d.r2, 3), 'R² esperado'], [int(d.linhas_treino ?? local.n), 'linhas de treino']];
  if (d.melhor_k != null) itens.push([d.melhor_k, 'vizinhos (k)']);
  const insights = Array.isArray(d.insights) && d.insights.length ? d.insights : ['Modelo treinado.'];
  results.innerHTML =
    cabecalho('treino · desempenho esperado', esc(file.name), `validação cruzada 10-fold · treinado na nuvem em ${segundos(tempo)}`) +
    bolhas(itens) +
    anotacoes('Anotações do tamboril', insights) +
    grafico('/graficos/treino', 'Desempenho esperado (validação cruzada)') +
    cabecalho('colunas', 'Espécimes <em>catalogados</em>', 'faixa vista no treino: é ela que o min-max usa') +
    `<div class="tags reveal">${fichas(local)}</div>` +
    `<div class="actions reveal"><button class="btn primary" data-act="testar">soltar o CSV de teste</button></div>`;
  finalizarRelatorio();
}

/* --- teste com rótulo: esperado × real --- */
let ultimoBlob = null, ultimoNome = 'previsoes.csv';
function desenharTeste(file, resp, prev, blob, tempo) {
  ultimoBlob = blob; ultimoNome = 'previsoes_' + file.name.replace(/\.csv$/i, '') + '.csv';
  const esp = resp.desempenho_esperado, real = resp.desempenho_real;
  const fora = resp.valores_fora_da_faixa_do_treino || 0;
  const linhas = (resp.insights || []).map(t => /^Atenção/.test(t) ? { cls: 'alert', html: esc(t) } : t);
  const negativos = prev.rows.filter(r => r.time_previsto < 0).length;
  if (negativos) linhas.push({ cls: 'alert', html: `<b>${negativos}</b> previsão(ões) negativa(s), sendo que <b>time</b> nunca é negativo na base.` });
  results.innerHTML =
    cabecalho('teste · desempenho real × esperado', esc(file.name), `${int(resp.linhas_previstas)} linhas previstas na nuvem em ${segundos(tempo)}`) +
    comparacao(esp, real, resp.insights && resp.insights[1]) +
    anotacoes('Anotações do tamboril', linhas.length ? linhas : ['Sem observações.']) +
    grafico('/graficos/teste', 'Desempenho real no teste') +
    cabecalho('previsões', 'O que veio <em>na rede</em>', '', `<button class="btn primary" data-act="baixar">baixar previsões (.csv)</button>`) +
    tabelaPrevisoes(prev, real.mae) +
    `<div class="actions reveal"><button class="btn" data-act="outro">soltar outro csv</button></div>`;
  finalizarRelatorio();
}

function comparacao(esp, real, conclusao) {
  const linha = (nome, sub, e, r, menorMelhor) => {
    const max = Math.max(Math.abs(e), Math.abs(r)) || 1;
    const w = v => Math.max(0, v) / max * 100 + '%';
    let txt, cls;
    if (menorMelhor) {
      const pct = (r / e - 1) * 100;
      cls = Math.abs(pct) <= 15 ? 'same' : pct < 0 ? 'good' : 'bad';
      txt = `${pct > 0 ? '+' : ''}${fmt(pct, 0)}% ${cls === 'same' ? 'próximo' : cls === 'good' ? 'melhor' : 'pior'}`;
    } else {
      const dif = r - e;
      cls = Math.abs(dif) <= .05 ? 'same' : dif > 0 ? 'good' : 'bad';
      txt = `${dif > 0 ? '+' : ''}${fmt(dif, 3)} ${cls === 'same' ? 'próximo' : cls === 'good' ? 'melhor' : 'pior'}`;
    }
    return `<div class="cmp-row"><div class="cmp-name">${nome}<small>${sub}</small></div>
      <div class="cmp-bars">
        <div class="cmp-bar exp"><span>esperado</span><div class="track"><i data-w="${w(e)}"></i></div><span class="v">${fmt(e, 3)}</span></div>
        <div class="cmp-bar real"><span>real</span><div class="track"><i data-w="${w(r)}"></i></div><span class="v">${fmt(r, 3)}</span></div>
      </div><span class="cmp-delta ${cls}">${txt}</span></div>`;
  };
  return `<div class="panel compare reveal">
    ${linha('RMSE', 'menor é melhor', esp.rmse, real.rmse, true)}
    ${linha('MAE', 'menor é melhor', esp.mae, real.mae, true)}
    ${linha('R²', 'maior é melhor', esp.r2, real.r2, false)}
    ${conclusao ? `<p class="verdict"><b>Veredito:</b> ${esc(conclusao)}</p>` : ''}
  </div>`;
}

/* --- aplicação sem rótulo: só previsões --- */
function desenharAplicacao(file, resp, prev, blob, tempo) {
  ultimoBlob = blob; ultimoNome = 'previsoes_' + file.name.replace(/\.csv$/i, '') + '.csv';
  const p = prev.rows.map(r => r.time_previsto).filter(v => v != null);
  // laço em vez de Math.min(...p): com milhares de linhas o spread estoura a pilha
  let soma = 0, menor = Infinity, maior = -Infinity;
  for (const v of p) { soma += v; if (v < menor) menor = v; if (v > maior) maior = v; }
  const media = soma / (p.length || 1);
  const fora = resp.valores_fora_da_faixa_do_treino || 0;
  const negativos = p.filter(v => v < 0).length;
  const linhas = ['Sem a coluna time não há gabarito, então a API devolveu só as previsões.'];
  if (fora) linhas.push({ cls: 'alert', html: `<b>${fora}</b> valor(es) de entrada fora da faixa vista no treino: essas linhas tendem a ter erro maior.` });
  if (negativos) linhas.push({ cls: 'alert', html: `<b>${negativos}</b> previsão(ões) negativa(s), sendo que <b>time</b> nunca é negativo na base de treino.` });
  results.innerHTML =
    cabecalho('aplicação · só previsões', esc(file.name), `previsto na nuvem em ${segundos(tempo)}`) +
    bolhas([[int(resp.linhas_previstas), 'linhas previstas'], [int(fora), 'fora da faixa', fora > 0], [fmt(media), 'média prevista'],
      [fmt(menor), 'menor previsão', negativos > 0], [fmt(maior), 'maior previsão']]) +
    anotacoes('Anotações do tamboril', linhas) +
    cabecalho('previsões', 'O que veio <em>na rede</em>', '', `<button class="btn primary" data-act="baixar">baixar previsões (.csv)</button>`) +
    tabelaPrevisoes(prev, null) +
    `<div class="actions reveal"><button class="btn" data-act="outro">soltar outro csv</button></div>`;
  finalizarRelatorio();
}

function tabelaPrevisoes(prev, maeReal) {
  const temAlvo = prev.fields.includes(ALVO);
  const cols = [...prev.fields];
  const head = `<tr><th class="idx">#</th>${cols.map(c => `<th class="${c === 'time_previsto' ? 'pred' : ''}">${esc(c)}</th>`).join('')}${temAlvo ? '<th>|erro|</th>' : ''}</tr>`;
  const body = prev.rows.slice(0, 15).map((r, i) => {
    const e = temAlvo ? Math.abs(r[ALVO] - r.time_previsto) : null;
    return `<tr><td class="idx">${i + 1}</td>${cols.map(c => `<td class="${c === 'time_previsto' ? 'pred' : ''}">${fmt(r[c])}</td>`).join('')}` +
      (temAlvo ? `<td class="${maeReal && e > 2 * maeReal ? 'err-hi' : ''}">${fmt(e)}</td>` : '') + '</tr>';
  }).join('');
  const nota = prev.rows.length > 15 ? `<figcaption style="font:.74rem var(--mono);color:var(--muted);padding:10px 14px">mostrando 15 de ${int(prev.rows.length)} linhas · o arquivo completo está no download</figcaption>` : '';
  return `<div class="panel preview reveal"><table><thead>${head}</thead><tbody>${body}</tbody></table>${nota}</div>`;
}

function fichas(local) {
  return local.cols.map((c, i) => {
    const papel = FEATURES.includes(c.name) ? 'entrada' : c.name === ALVO ? 'alvo' : 'outra';
    let corpo;
    if (c.numeric) {
      const mx = Math.max(...c.hist);
      corpo = `<dl class="stats">
        <div><dt>média</dt><dd>${fmt(c.mean)}</dd></div><div><dt>mediana</dt><dd>${fmt(c.median)}</dd></div><div><dt>desvio</dt><dd>${fmt(c.sd)}</dd></div>
        <div><dt>mín</dt><dd>${fmt(c.min)}</dd></div><div><dt>máx</dt><dd>${fmt(c.max)}</dd></div><div><dt>IQR</dt><dd>${fmt(c.q3 - c.q1)}</dd></div></dl>
        <div class="hist">${c.hist.map((h, j) => `<span style="height:${mx ? h / mx * 100 : 0}%;animation-delay:${200 + j * 25}ms"></span>`).join('')}</div>
        <div class="axis"><span>${fmt(c.min)}</span><span>${fmt(c.max)}</span></div>`;
    } else corpo = '<p class="fill-label">coluna não numérica: a API vai descartar</p>';
    return `<article class="panel tag" style="--i:${i}">
      <div class="tag-top"><span>Nº ${String(i + 1).padStart(2, '0')}</span><span class="pill ${papel}">${papel}</span></div>
      <h4>${esc(c.name)}</h4>
      <p class="fill-label">${int(c.present)} valores · ${int(c.missing)} vazios</p>${corpo}</article>`;
  }).join('');
}

/* =========================================================================
   início
   ========================================================================= */
setModo('treino');
atualizarStatus();
})();
