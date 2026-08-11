import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { config } from '../config.js';
import { log } from './store.js';

const run = promisify(execFile);
const BIN = ffmpegPath || 'ffmpeg';

let available = null;

export async function ffmpegAvailable() {
  if (available !== null) return available;
  try {
    await run(BIN, ['-version'], { maxBuffer: 1 << 20 });
    available = true;
  } catch (err) {
    available = false;
    log.warn('audio', `ffmpeg not usable: ${err.message}. Spots will ship as dry voice.`);
  }
  return available;
}

const tmp = (name) => path.join(os.tmpdir(), `s1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);

/** Read a file's duration in seconds by decoding it to nowhere. */
export async function measure(file) {
  try {
    const { stderr } = await run(BIN, ['-i', file, '-f', 'null', '-'], { maxBuffer: 1 << 22 });
    const times = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    if (times.length) {
      const [, h, m, s] = times[times.length - 1];
      return Number(h) * 3600 + Number(m) * 60 + Number(s);
    }
    const d = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (d) return Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  } catch (err) {
    // ffmpeg exits non-zero on some null muxes; the timing is still in stderr.
    const stderr = err.stderr || '';
    const d = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (d) return Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
    log.warn('audio.measure', err.message);
  }
  return null;
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't fetch the music bed (${res.status}).`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/**
 * Turn a dry voiceover into something that holds up next to the produced
 * spots around it on Spotify or Pandora.
 *
 *  - a music bed sits underneath and ducks out of the way of the read
 *  - the whole thing is normalized to broadcast loudness (-16 LUFS by default)
 *  - if the read came in under the slot, it pads to the exact length
 *  - if the read ran long, it is never cut mid-word — it comes back flagged
 *
 * @returns {{buffer:Buffer, rawSeconds:number, finalSeconds:number, bedUsed:boolean, postProduced:boolean}}
 */
/**
 * Bed level is chosen as a percentage of the voice, which is how people
 * think about it, and converted to the dB the mixer actually needs.
 * 25% is the default: present, but never fighting the read.
 */
export const bedPercentToDb = (pct) => {
  const p = Math.max(2, Math.min(60, Number(pct) || 25));
  return Math.round(20 * Math.log10(p / 100) * 10) / 10;
};

export async function postProduce(voBuffer, { targetSeconds, bedUrl, bedPercent, bedDb }) {
  if (bedDb === undefined || bedDb === null) {
    bedDb = bedPercent !== undefined && bedPercent !== null
      ? bedPercentToDb(bedPercent)
      : config.audio.bedDb;
  }
  const voFile = tmp('vo.mp3');
  await fs.writeFile(voFile, voBuffer);
  const cleanup = [voFile];

  let rawSeconds = null;

  try {
    if (!config.audio.enabled || !(await ffmpegAvailable())) {
      return { buffer: voBuffer, rawSeconds: null, finalSeconds: null, bedUsed: false, postProduced: false };
    }

    rawSeconds = await measure(voFile);
    // Never trim a read that ran long — that clips a word. And never pad a
    // short one out to the full slot: 12 seconds of silence is worse than a
    // short spot. Cap the tail at a beat and let the copy be lengthened.
    const MAX_TAIL = 1.0;
    let slot = targetSeconds;
    if (rawSeconds) {
      if (rawSeconds > targetSeconds + 0.4) slot = Math.ceil(rawSeconds * 10) / 10;
      else if (rawSeconds + MAX_TAIL < targetSeconds) slot = Math.round((rawSeconds + MAX_TAIL) * 10) / 10;
    }

    const outFile = tmp('out.mp3');
    cleanup.push(outFile);

    const loud = `loudnorm=I=${config.audio.targetLufs}:TP=${config.audio.truePeak}:LRA=11`;
    let args;

    if (bedUrl) {
      const bedFile = tmp('bed.mp3');
      cleanup.push(bedFile);
      await download(bedUrl, bedFile);

      const filter = [
        // Bed: loop to cover the slot, drop under the read, ease in and out.
        `[1:a]aloop=loop=-1:size=2000000000,atrim=0:${slot},volume=${bedDb}dB,` +
          `afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, slot - 1.4).toFixed(2)}:d=1.4,aresample=44100[bed]`,
        // Voice: a beat of air before the read, then padded to the slot.
        // Split in two — one copy is heard, the other only triggers the duck.
        `[0:a]adelay=250|250,apad,atrim=0:${slot},aresample=44100,asplit=2[voMix][voKey]`,
        `[bed][voKey]sidechaincompress=threshold=0.045:ratio=8:attack=15:release=400[ducked]`,
        `[voMix][ducked]amix=inputs=2:duration=first:normalize=0[mix]`,
        `[mix]${loud},alimiter=limit=0.95[out]`
      ].join(';');

      args = ['-y', '-i', voFile, '-i', bedFile, '-filter_complex', filter,
        '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', outFile];
    } else {
      const filter = `adelay=250|250,apad,atrim=0:${slot},${loud},alimiter=limit=0.95,aresample=44100`;
      args = ['-y', '-i', voFile, '-af', filter,
        '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', outFile];
    }

    await run(BIN, args, { maxBuffer: 1 << 24 });
    const buffer = await fs.readFile(outFile);
    const finalSeconds = await measure(outFile);

    return { buffer, rawSeconds, finalSeconds, bedUsed: Boolean(bedUrl), postProduced: true };
  } catch (err) {
    log.error('audio.postProduce', err.message);
    // A mastering failure should never lose the take.
    // Keep the measured length even when mastering failed — the duration
    // check still needs it.
    return { buffer: voBuffer, rawSeconds, finalSeconds: rawSeconds, bedUsed: false, postProduced: false, error: err.message };
  } finally {
    await Promise.all(cleanup.map((f) => fs.unlink(f).catch(() => {})));
  }
}
