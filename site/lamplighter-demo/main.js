// The Lamplighter — gallery player.
//
// The film itself lives in examples/scene-lamplighter.js and is emitted to
// ./scene.js by site/scripts/generate-demos.mjs. The example builds every shot
// from onFrame({ time }), so this page only owns the playhead: it advances the
// clock, calls stage.frame(t), and keeps the shot list, captions and HUD in
// sync. Deep links: ?t=39.6&paused=1 stops on a given frame.
import { t } from '../i18n.js'
import { createStage } from './scene.js'
import { FILM } from './film.js'

const DURATION = FILM.duration
const canvas = document.getElementById('scene')
const stage = createStage(canvas)

const els = {
  hero: document.getElementById('hero'),
  playCta: document.getElementById('play-cta'),
  caption: document.getElementById('caption'),
  player: document.getElementById('player'),
  shots: document.getElementById('shots'),
  toggle: document.getElementById('toggle'),
  clock: document.getElementById('clock'),
  seek: document.getElementById('seek'),
  shotLabel: document.getElementById('shot-label'),
  replay: document.getElementById('replay'),
}

const params = new URLSearchParams(location.search)
const deepLink = params.has('t') ? Number(params.get('t')) : null
const startPaused = params.get('paused') === '1' || params.get('still') === '1'
const reducedMotion = window.matchMedia !== undefined
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

let time = Number.isFinite(deepLink) ? Math.min(DURATION, Math.max(0, deepLink)) : 0
let playing = false
let last = performance.now()

// A still/deep-link page renders one frame and stays put unless the visitor
// presses play; reduced motion starts on a representative frame instead.
if (startPaused || reducedMotion) {
  time = Number.isFinite(deepLink) ? time : 39.6
}

const pad = value => String(Math.floor(value)).padStart(2, '0')
const clockText = seconds => pad(Math.floor(seconds) / 60) + ':' + pad(Math.floor(seconds) % 60)

const shotAt = at => {
  let current = FILM.shots[0]
  for (const shot of FILM.shots) {
    if (at >= shot.at) current = shot
  }
  return current
}

// ---- shot list ----
FILM.shots.forEach(shot => {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.at = String(shot.at)
  button.textContent = shot.id + ' ' + t(shot.label)
  button.title = t(shot.label)
  button.addEventListener('click', () => {
    time = shot.at + 0.05
    setPlaying(false)
    paint()
  })
  els.shots.appendChild(button)
})

// ---- captions ----
function captionAt(at) {
  for (const caption of FILM.captions) {
    if (at >= caption.start && at < caption.end) return caption.text
  }
  return ''
}

// ---- paint ----
function paint() {
  stage.frame(time)

  const shot = shotAt(time)
  els.clock.textContent = clockText(time) + ' / ' + clockText(DURATION)
  els.shotLabel.textContent = shot.id + ' · ' + t(shot.label)
  els.seek.value = String(time)
  for (const button of els.shots.querySelectorAll('button')) {
    button.setAttribute('aria-current', button.dataset.at === String(shot.at) ? 'true' : 'false')
  }

  const caption = captionAt(time)
  if (caption === '') {
    els.caption.classList.remove('is-visible')
    els.caption.textContent = ''
  } else {
    els.caption.textContent = caption
    els.caption.classList.add('is-visible')
  }
}

function setPlaying(next) {
  playing = next
  els.toggle.textContent = playing ? '❙❙' : '▶'
  els.toggle.setAttribute('aria-label', playing ? '暂停' : '播放')
  if (playing) {
    els.hero.classList.add('is-hidden')
    els.player.classList.remove('is-dim')
  }
}

// ---- loop ----
function tick() {
  const now = performance.now()
  if (playing) {
    time += Math.min(0.1, (now - last) / 1000)
    if (time >= DURATION) {
      time = DURATION
      setPlaying(false)
    }
    paint()
  }
  last = now
  requestAnimationFrame(tick)
}

// ---- controls ----
function play() {
  if (time >= DURATION - 0.05) time = 0
  last = performance.now()
  setPlaying(true)
}

function pause() {
  setPlaying(false)
  paint()
}

els.playCta.addEventListener('click', play)
els.toggle.addEventListener('click', () => {
  if (playing) pause()
  else play()
})
els.replay.addEventListener('click', () => {
  time = 0
  last = performance.now()
  setPlaying(true)
})
els.seek.addEventListener('input', event => {
  time = Math.min(DURATION, Math.max(0, Number(event.target.value)))
  setPlaying(false)
  paint()
})
window.addEventListener('keydown', event => {
  if (event.code === 'Space') {
    event.preventDefault()
    if (playing) pause()
    else play()
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    time = Math.min(DURATION, time + 1)
    setPlaying(false)
    paint()
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    time = Math.max(0, time - 1)
    setPlaying(false)
    paint()
  }
})

// Pause while the tab is hidden so a background tab cannot burn frames.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && playing) pause()
})

// ---- boot ----
paint()
if (startPaused || reducedMotion) {
  els.hero.classList.add('is-hidden')
  els.player.classList.remove('is-dim')
} else {
  els.player.classList.add('is-dim')
}
requestAnimationFrame(tick)
