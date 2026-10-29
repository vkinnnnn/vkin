#!/usr/bin/env node
// Acoustic probe for the native audio layer (PRD Phase 2). Runs the real addon on this machine:
// captures system loopback (them), the echo-cancelled mic (me) and the raw mic (meRaw) at once,
// optionally plays speech through the speakers, and reports how much of the played audio leaks into
// each mic stream. Numbers only; audio is written to disk only with --save (data/ is gitignored).
//
//   node scripts/audio-probe.js                      # 2 s floor, TTS through speakers, report
//   node scripts/audio-probe.js --wav path.wav       # play your own clip instead of TTS
//   node scripts/audio-probe.js --no-play --seconds 1800 --every 60   # soak: memory + drift, no audio
//   node scripts/audio-probe.js --stt                # also transcribe me/meRaw with Deepgram (tiny cost)
//   node scripts/audio-probe.js --save               # keep them/me/meRaw WAVs for listening
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), override: false });
const { loadNativeAudio } = require('../src/main/audio/native-loader');

const DEFAULT_TEXT = 'Thanks for joining today. Can you walk me through a project where the data was messy, and tell me how you decided what to clean first?';
// Read aloud by the person at the mic during --double-talk; shares no content words with DEFAULT_TEXT.
const NEAR_END_TEXT = 'I built a forecasting pipeline in Python and deployed it on Azure with weekly retraining.';
const BIN_MS = 80;

function args(argv) {
  const out = { seconds: 0, play: true, wav: '', text: DEFAULT_TEXT, save: false, stt: false, aec: true, every: 0, floorMs: 2000, ns: false, aes: 1, echo: 256, array: false, brief: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--seconds') out.seconds = Number(argv[++i]);
    else if (a === '--wav') out.wav = argv[++i];
    else if (a === '--text') out.text = argv[++i];
    else if (a === '--no-play') out.play = false;
    else if (a === '--save') out.save = true;
    else if (a === '--stt') out.stt = true;
    else if (a === '--no-aec') out.aec = false;
    else if (a === '--ns') out.ns = true;
    else if (a === '--aes') out.aes = Number(argv[++i]);
    else if (a === '--echo') out.echo = Number(argv[++i]);
    else if (a === '--array') out.array = true;
    else if (a === '--brief') out.brief = true;
    else if (a === '--double-talk') { out.doubleTalk = true; out.stt = true; }
    else if (a === '--every') out.every = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const db = (rms) => (rms > 0 ? 20 * Math.log10(rms) : -120);
const nowMs = () => Number(process.hrtime.bigint()) / 1e6; // libuv hrtime is QPC-based on Windows, like the addon's tsMs
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rmsOf = (levels) => Math.sqrt(mean(levels.map((l) => l * l)));

function makeTts(text, file) {
  const ps = `Add-Type -AssemblyName System.Speech; $t = New-Object System.Speech.Synthesis.SpeechSynthesizer; $t.SetOutputToWaveFile('${file.replace(/'/g, "''")}'); $t.Speak('${text.replace(/'/g, "''")}'); $t.Dispose()`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error(`TTS failed: ${r.stderr || r.stdout}`);
}

function playWav(file) {
  return new Promise((resolve) => {
    const ps = `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`;
    const p = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    p.on('exit', resolve);
  });
}

function writeWav(file, chunks) {
  const pcm = Buffer.concat(chunks);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
}

async function main() {
  const o = args(process.argv);
  if (o.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).join('\n'));
    return;
  }
  const { addon, error, path: addonPath } = loadNativeAudio();
  if (!addon) throw new Error(error);
  const outDir = path.join(ROOT, 'data', 'audio-probe');
  fs.mkdirSync(outDir, { recursive: true });
  const devices = addon.devices();
  const defName = (list) => (list.find((d) => d.isDefault) || {}).name || '?';
  console.log(`addon ${path.relative(ROOT, addonPath)}`);
  console.log(`speaker: ${defName(devices.render)} | mic: ${defName(devices.capture)} | aec ${o.aec ? 'on' : 'off'}`);

  let wav = o.wav;
  if (o.play && !wav) {
    wav = path.join(outDir, 'tts.wav');
    makeTts(o.text, wav);
  }

  const bins = { them: new Map(), me: new Map(), meRaw: new Map() };
  const pcm = { them: [], me: [], meRaw: [] };
  const events = [];
  const flux = {};
  const transcripts = { me: [], meRaw: [] };
  if (o.stt) {
    if (!process.env.DEEPGRAM_API_KEY) throw new Error('--stt needs DEEPGRAM_API_KEY in .env');
    const { FluxClient } = require('../src/main/stt');
    const sttCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).stt;
    for (const ch of ['me', 'meRaw']) {
      flux[ch] = new FluxClient({ channel: ch, apiKey: process.env.DEEPGRAM_API_KEY, stt: { ...sttCfg, keyterms: [] } });
      flux[ch].on('event', (ev) => { if (ev.event === 'EndOfTurn' && ev.transcript) transcripts[ch].push(ev.transcript); });
      flux[ch].start();
    }
  }

  const skews = [];
  addon.start({ them: true, me: true, meRaw: true, aec: o.aec, ns: o.ns, agc: false, aes: o.aes, echoLengthMs: o.echo, arrayMode: o.array }, (f) => {
    const m = bins[f.channel];
    if (!m) return;
    if (skews.length < 50) skews.push(nowMs() - f.tsMs); // sanity: addon and JS clocks share the QPC origin
    m.set(Math.floor(f.tsMs / BIN_MS), f.level);
    if (o.save) pcm[f.channel].push(f.pcm);
    if (flux[f.channel]) flux[f.channel].sendPcm(f.pcm);
  }, (e) => events.push(e));

  const t0 = nowMs();
  const mem0 = process.memoryUsage().rss;
  const soak = [];
  const sample = () => {
    const s = addon.stats();
    soak.push({ min: Math.round((nowMs() - t0) / 600) / 100, rssMb: Math.round(process.memoryUsage().rss / 1e5) / 10, themPpm: Math.round(s.them.ratePpm), mePpm: Math.round(s.me.ratePpm), drops: s.them.queueDrops + s.me.queueDrops, disc: s.them.discontinuities + s.me.discontinuities });
    if (o.every) console.log(JSON.stringify(soak[soak.length - 1]));
  };
  const timer = o.every ? setInterval(sample, o.every * 1000) : null;

  await new Promise((r) => setTimeout(r, o.floorMs));
  let playStart = 0;
  let playEnd = 0;
  if (o.doubleTalk) {
    console.log(`\nDOUBLE-TALK: when you see GO, read this aloud at normal volume while the computer talks:\n\n   "${NEAR_END_TEXT}"\n`);
    for (const n of ['3', '2', '1']) { console.log(`   ${n}...`); await new Promise((r) => setTimeout(r, 1000)); }
    console.log('   GO\n');
  }
  if (o.play) {
    playStart = nowMs();
    await playWav(wav);
    playEnd = nowMs();
  }
  const remaining = Math.max(o.play ? 1500 : 0, o.seconds * 1000 - (nowMs() - t0));
  await new Promise((r) => setTimeout(r, remaining));
  if (timer) clearInterval(timer);
  sample();
  const stats = addon.stats();
  addon.stop();
  for (const c of Object.values(flux)) c.forceEndTurn();
  if (o.stt) await new Promise((r) => setTimeout(r, 2500));
  for (const c of Object.values(flux)) c.stop();

  // Bins where the loopback carries the played audio vs the silent floor before playback.
  const themActive = new Set([...bins.them].filter(([, l]) => l > 0.01).map(([k]) => k));
  const floorBins = (m) => [...m].filter(([k]) => k * BIN_MS < (playStart || t0 + o.floorMs) - 200 && k * BIN_MS > t0 + 300).map(([, l]) => l);
  const activeBins = (m) => [...m].filter(([k]) => themActive.has(k)).map(([, l]) => l);
  const measure = (ch) => {
    const floor = db(rmsOf(floorBins(bins[ch])));
    const active = db(rmsOf(activeBins(bins[ch])));
    return { floorDb: Math.round(floor * 10) / 10, duringPlaybackDb: Math.round(active * 10) / 10, echoAboveFloorDb: Math.round((active - floor) * 10) / 10 };
  };
  const report = {
    at: new Date().toISOString(),
    speaker: defName(devices.render),
    mic: defName(devices.capture),
    aec: o.aec,
    dsp: { aes: o.aes, echoLengthMs: o.echo, arrayMode: o.array, ns: o.ns },
    played: o.play ? { ms: Math.round(playEnd - playStart), themActiveBins: themActive.size, themDb: Math.round(db(rmsOf(activeBins(bins.them))) * 10) / 10 } : null,
    raw: o.play ? measure('meRaw') : null,
    aecMic: o.play ? measure('me') : null,
    stats: Object.fromEntries(['them', 'me', 'meRaw'].map((c) => [c, { frames: stats[c].frames, discontinuities: stats[c].discontinuities, queueDrops: stats[c].queueDrops, ratePpm: Math.round(stats[c].ratePpm) }])),
    soak: o.every ? soak : undefined,
    rssGrowthMb: Math.round((process.memoryUsage().rss - mem0) / 1e5) / 10,
    frameDelayMs: Math.round(skews.sort((a, b) => a - b)[Math.floor(skews.length / 2)] || 0),
    events: events.filter((e) => e.type !== 'info'),
  };
  if (o.play) {
    // Echo removal = how much of the speaker audio the raw mic hears above its floor, minus what is left after AEC.
    report.echoReductionDb = Math.round((report.raw.echoAboveFloorDb - report.aecMic.echoAboveFloorDb) * 10) / 10;
  }
  if (o.stt) {
    const said = new Set(words(o.text));
    const leak = (ch) => {
      const heard = words(transcripts[ch].join(' '));
      return { transcript: transcripts[ch].join(' | '), playedWordsHeard: heard.filter((w) => said.has(w)).length, playedWords: said.size };
    };
    report.stt = { me: leak('me'), meRaw: leak('meRaw') };
    if (o.doubleTalk) {
      // The person's words must survive echo cancellation while the played words stay out.
      const mine = new Set(words(NEAR_END_TEXT));
      const kept = (ch) => words(transcripts[ch].join(' ')).filter((w) => mine.has(w)).length;
      report.doubleTalk = {
        nearEndWords: mine.size,
        keptInAecMic: kept('me'),
        keptInRawMic: kept('meRaw'),
        playedWordsLeakedIntoAecMic: report.stt.me.playedWordsHeard,
        pass: kept('me') >= Math.ceil(mine.size * 0.7) && report.stt.me.playedWordsHeard <= 2,
      };
    }
  }
  if (o.save) for (const ch of ['them', 'me', 'meRaw']) writeWav(path.join(outDir, `${ch}.wav`), pcm[ch]);
  const file = path.join(outDir, `report-${report.at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  if (o.brief && !report.raw) {
    const last = (report.soak || [])[report.soak ? report.soak.length - 1 : 0] || {};
    console.log(`soak ${last.min || 0} min | rss growth ${report.rssGrowthMb} MB | drift them ${report.stats.them.ratePpm} ppm, me ${report.stats.me.ratePpm} ppm | queue drops ${report.stats.them.queueDrops + report.stats.me.queueDrops} | discontinuities ${report.stats.them.discontinuities + report.stats.me.discontinuities}`);
    return;
  }
  if (o.brief) {
    const d = report.dsp;
    const sttPart = report.stt ? ` | stt words heard: aec ${report.stt.me.playedWordsHeard}/${report.stt.me.playedWords}, raw ${report.stt.meRaw.playedWordsHeard}/${report.stt.meRaw.playedWords}` : '';
    console.log(`aes=${d.aes} echo=${d.echoLengthMs} array=${d.arrayMode} ns=${d.ns} | raw ${report.raw.duringPlaybackDb} dB | aec ${report.aecMic.duringPlaybackDb} dB (floor ${report.aecMic.floorDb}, +${report.aecMic.echoAboveFloorDb})${sttPart}`);
    if (report.stt) console.log(`   aec transcript: ${report.stt.me.transcript || '(nothing)'}`);
    if (report.doubleTalk) console.log(`   double-talk: kept ${report.doubleTalk.keptInAecMic}/${report.doubleTalk.nearEndWords} of your words (raw mic ${report.doubleTalk.keptInRawMic}), leaked ${report.doubleTalk.playedWordsLeakedIntoAecMic} played words -> ${report.doubleTalk.pass ? 'PASS' : 'FAIL'}`);
    return;
  }
  console.log(JSON.stringify(report, null, 2));
  console.log(`report: ${path.relative(ROOT, file)}`);
}

main().catch((err) => {
  console.error('audio-probe failed:', err.message);
  process.exit(1);
});
