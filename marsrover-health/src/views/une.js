// =============================================================================
// À la une — page d'ouverture : vidéo plein cadre (en boucle, sans son), grand titre
// à gauche, panneau de l'équipe à droite (cartes empilées qui défilent), logo de l'école.
// =============================================================================
import { h, icon } from '../core/dom.js';

const VIDEO_URL = 'https://v1.pinimg.com/videos/mc/720p/cd/e1/d5/cde1d544c5d6629bd6c07c9544bf83af.mp4';

const TEAM = [
  { img: 'assets/img/team/sabri.jpg', role: 'Réalisé par', first: 'Mohamed Sabri', last: 'BEN SLIMENE' },
  { img: 'assets/img/team/wassim.jpg', role: 'Réalisé par', first: 'Wassim', last: 'FARHAT' },
  { img: 'assets/img/team/faycel.jpg', role: 'Encadré par', first: 'M. Faycel', last: 'BEN HMIDA' },
];
const LINKS = [['#/accueil', 'Accueil 3D', 'cube'], ['#/dashboard', 'Tableau de bord', 'gauge'], ['#/ia', 'IA prédictive', 'cpu'], ['#/maintenance', 'Maintenance', 'wrench']];

let video = null, timer = null, idx = 0;

export default {
  mount(app) {
    idx = 0;
    video = h('video.une-video', { preload: 'auto', poster: 'assets/img/background.jpg', 'aria-hidden': 'true', tabindex: '-1' });
    video.muted = true; video.defaultMuted = true; video.volume = 0; video.loop = true; video.autoplay = true; video.playsInline = true;
    ['muted', 'autoplay', 'loop', 'playsinline'].forEach((a) => video.setAttribute(a, ''));
    video.src = VIDEO_URL;
    requestAnimationFrame(() => { if (video) { const p = video.play(); if (p && p.catch) p.catch(() => {}); } });
    video.addEventListener('ended', () => { video.currentTime = 0; video.play().catch(() => {}); });
    video.addEventListener('volumechange', () => { if (!video.muted) video.muted = true; });

    const cards = TEAM.map((p, i) => h('figure.une-card', { 'data-i': i },
      h('img', { src: p.img, alt: `${p.first} ${p.last}`, loading: 'eager', draggable: 'false' })));
    const stack = h('div.une-stack', cards);
    const nameLast = h('div.une-name'), nameSub = h('div.une-namesub'), count = h('span.une-count');
    const dots = h('div.une-dots', TEAM.map((_, i) => h('button', { type: 'button', 'aria-label': `Membre ${i + 1}`, on: { click: () => { go(i); restart(); } } })));
    const caption = h('div.une-caption', h('div', nameLast, nameSub), count);

    const go = (n) => {
      idx = (n + TEAM.length) % TEAM.length;
      cards.forEach((c, i) => { c.dataset.pos = String((i - idx + TEAM.length) % TEAM.length); });
      [...dots.children].forEach((d, i) => d.classList.toggle('on', i === idx));
      caption.classList.remove('swap'); void caption.offsetWidth; caption.classList.add('swap');
      const p = TEAM[idx];
      nameLast.textContent = p.last; nameSub.textContent = `${p.first} · ${p.role}`; count.textContent = `0${idx + 1} / 0${TEAM.length}`;
    };
    const restart = () => { clearInterval(timer); timer = setInterval(() => go(idx + 1), 4500); };
    cards.forEach((c, i) => c.addEventListener('click', () => { go(i); restart(); }));
    go(0); restart();

    app.append(h('section.une', { 'aria-label': 'À la une — MarsRover Health' },
      h('header.une-bar',
        h('a.une-brand', { href: '#/accueil' }, h('img', { src: 'assets/img/logo.png', alt: '', width: 28, height: 28 }), 'MarsRover Health'),
        h('span.une-bar-mid', 'Projet Pratique · FMDS & maintenance prédictive'),
        h('a.une-enter-sm', { href: '#/accueil' }, 'Entrer', icon('external'))),
      h('div.une-stage',
        video, h('div.une-shade'),
        h('div.une-hero',
          h('h1.une-title', h('span', 'MARSROVER'), h('span', 'HEALTH')),
          h('p.une-sub', h('span.spark', '✳'), h('span', 'Fiabilité, maintenabilité, disponibilité et sécurité d\'un rover martien — détection d\'anomalies et maintenance prédictive.')),
          h('div.une-actions',
            h('div.une-tiles', LINKS.map(([href, l, ic]) => h('a.une-tile', { href }, h('span', l), icon(ic)))),
            h('a.une-cta', { href: '#/accueil' }, 'Entrer')),
          h('div.une-school', h('img', { src: 'assets/img/polytechnique-sousse.png', alt: 'École Polytechnique de Sousse — EUR-ACE' }))),
        h('aside.une-panel', { 'aria-label': 'Équipe du projet' },
          h('div.une-panel-top',
            h('h2', 'L\'équipe', h('br'), 'du projet'),
            h('div.une-arrows',
              h('button', { type: 'button', 'aria-label': 'Précédent', on: { click: () => { go(idx - 1); restart(); } } }, '←'),
              h('button', { type: 'button', 'aria-label': 'Suivant', on: { click: () => { go(idx + 1); restart(); } } }, '→'))),
          stack, dots, caption))));
  },
  unmount() {
    clearInterval(timer); timer = null;
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); video = null; }
  },
};
