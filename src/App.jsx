import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

/* ─────────────────────────────  SUKOON  ─────────────────────────────
   A gentle day studio for Pragya — wellness-grade calm, premium craft.
   Intentions (work/personal, custom recurrence, sub-steps, someday)
   guided breathing (3 patterns) · journal with prompts + tags + mood
   and length trends · pocket · streaks with grace days · month heatmap
   undo · keyboard shortcuts · export · auto-saved.
   + Calendar export (Google Calendar link / .ics) · gentle reminders.
────────────────────────────────────────────────────────────────────── */

const STORAGE_KEY = "pragya-sukoon-v4";
/* ── Supabase: fill these from Project Settings → API ── */
const SUPABASE_URL = "https://oisozouzbqvjjkmazxlf.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9pc296b3V6YnF2amprbWF6eGxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MDI1NDEsImV4cCI6MjA5ODk3ODU0MX0.yt7JLodhuNpXw5mAveYCV-k5gvONVWfS_zzfn-1hJi4";
const supabase = (SUPABASE_URL.startsWith("https://") && !SUPABASE_ANON_KEY.startsWith("YOUR-"))
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

/* storage adapter — Supabase when configured, then window.storage (inside Claude),
   then localStorage, then memory. A local copy is always kept, so a dropped network
   never loses a save and the app still works offline.
   Every key is scoped to the signed-in user, locally and in the cloud. */
const localLayer = (() => {
  if (typeof window !== "undefined" && window.storage && window.storage.get) return window.storage;
  const mem = {};
  const ls = (() => {
    try { const k = "__sk_test__"; window.localStorage.setItem(k, "1"); window.localStorage.removeItem(k); return window.localStorage; }
    catch (e) { return null; }
  })();
  return {
    async get(key) { if (ls) { const v = ls.getItem(key); return v == null ? null : { value: v }; } return key in mem ? { value: mem[key] } : null; },
    async set(key, value) { if (ls) { try { ls.setItem(key, value); } catch (e) {} } else { mem[key] = value; } return { key, value }; },
  };
})();

let currentUserId = null;
const setStoreUser = (id) => { currentUserId = id || null; };
/* local keys are namespaced so two accounts on one device never bleed together */
const lkey = (key) => (currentUserId ? `u:${currentUserId}:${key}` : key);

const store = {
  async get(key) {
    const local = await localLayer.get(lkey(key));
    if (supabase && currentUserId) {
      try {
        const { data, error } = await supabase.from("sukoon_store")
          .select("value").eq("key", key).eq("user_id", currentUserId).maybeSingle();
        if (error) throw error;
        if (data) { await localLayer.set(lkey(key), data.value); return { value: data.value }; }
        if (local && local.value) {
          try {
            await supabase.from("sukoon_store").upsert(
              { user_id: currentUserId, key, value: local.value, updated_at: new Date().toISOString() },
              { onConflict: "user_id,key" });
          } catch (e) {}
        }
        return local;
      } catch (e) { console.warn("Supabase read failed — using local copy", e); }
    }
    return local;
  },
  async set(key, value) {
    await localLayer.set(lkey(key), value);
    if (supabase && currentUserId) {
      try {
        const { error } = await supabase.from("sukoon_store").upsert(
          { user_id: currentUserId, key, value, updated_at: new Date().toISOString() },
          { onConflict: "user_id,key" });
        if (error) throw error;
      } catch (e) { console.warn("Supabase write failed — saved locally", e); }
    }
    return { key, value };
  },
};

/* ── sound: soft natural materials, never UI beeps ───────────────────
   Every cue is one or more soft "notes" through a shared low-pass bus, so
   the harsh highs that read as synthy (roughly everything above ~4kHz) are
   always rolled off. Notes have a soft attack (no onset click) and a
   natural exponential tail (no abrupt cutoff), and sit quietly under the
   ambience — felt more than heard. Think muted marimba, soft koto, felt. */
let audioCtx = null;
let softBus = null;
const getCtx = () => {
  if (typeof window === "undefined") return null;
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
};
/* shared bus — one gentle low-pass rolls the top off everything the UI plays */
const getSoftBus = (ctx) => {
  if (softBus && softBus.ctx === ctx) return softBus;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = 3200; lp.Q.value = 0.4; // no resonant peak, soft slope
  const master = ctx.createGain(); master.gain.value = 0.85;         // sits under the ambience
  lp.connect(master); master.connect(ctx.destination);
  softBus = { ctx, in: lp };
  return softBus;
};
/* one soft note — wooden/felt by default.
   attack ≥ 14ms removes the click; the tail decays naturally; a quiet octave
   partial lends a little marimba warmth without brightness; `glide` bends the
   pitch for a soft "water-drop" settle. */
const note = (freq, opts = {}) => {
  const ctx = getCtx(); if (!ctx) return;
  const { dur = 0.5, vol = 0.05, when = 0, attack = 0.016, type = "sine", glide = 0, partial = 0, partialRatio = 2 } = opts;
  const bus = getSoftBus(ctx);
  const t = ctx.currentTime + when;
  const voice = (f, v, d, gl) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + attack);        // soft attack, no click
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);   // natural tail, no cutoff
    g.connect(bus.in);
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (gl) o.frequency.exponentialRampToValueAtTime(Math.max(40, f + gl), t + d * 0.9);
    o.connect(g); o.start(t); o.stop(t + d + 0.08);
  };
  voice(freq, vol, dur, glide);
  if (partial) voice(freq * partialRatio, vol * partial, dur * 0.7, 0);
};
const SOUNDS = {
  /* barely-there felt tick — quiet enough that fast typing reads as soft rain */
  type:    () => note(240 + Math.random() * 40, { dur: 0.11, vol: 0.010, attack: 0.010 }),
  /* soft wooden note, muted-marimba warmth */
  tap:     () => note(294, { dur: 0.42, vol: 0.042, partial: 0.28 }),
  /* navigation whispers: softer + shorter than tap, slow attack so it never startles */
  nav:     () => note(330, { dur: 0.26, vol: 0.028, attack: 0.03 }),
  /* finishing an intention — a soft two-note rising chime, a gentle "there" */
  check:   () => { note(392, { dur: 0.5, vol: 0.05, partial: 0.22 }); note(587, { dur: 0.62, vol: 0.045, when: 0.10, partial: 0.20 }); },
  /* un-completing — a soft downward settle */
  uncheck: () => note(330, { dur: 0.4, vol: 0.038, glide: -70 }),
  /* placing something down — two gentle wooden notes */
  add:     () => { note(294, { dur: 0.4, vol: 0.040, partial: 0.25 }); note(392, { dur: 0.5, vol: 0.038, when: 0.08, partial: 0.22 }); },
  /* removing — a soft descending "settling down" gesture, never punitive */
  delete:  () => { note(349, { dur: 0.42, vol: 0.040 }); note(233, { dur: 0.55, vol: 0.036, when: 0.09, glide: -30 }); },
  /* undo — a gentle lift, bringing something back */
  undo:    () => { note(330, { dur: 0.36, vol: 0.038 }); note(440, { dur: 0.46, vol: 0.034, when: 0.08 }); },
  /* keeping an entry — a warm, muted ascending triad */
  save:    () => { note(392, { dur: 0.44, vol: 0.045, partial: 0.2 }); note(523, { dur: 0.5, vol: 0.042, when: 0.09, partial: 0.2 }); note(659, { dur: 0.7, vol: 0.038, when: 0.19, partial: 0.18 }); },
  /* breath cues — long, soft swells rather than pips */
  inhale:  () => { note(392, { dur: 0.8, vol: 0.030, attack: 0.14, partial: 0.16 }); note(523, { dur: 0.8, vol: 0.024, when: 0.03, attack: 0.14 }); },
  exhale:  () => { note(294, { dur: 1.0, vol: 0.030, attack: 0.10, glide: -30 }); note(196, { dur: 1.0, vol: 0.022, when: 0.04, attack: 0.10 }); },
  hold:    () => note(392, { dur: 0.5, vol: 0.020, attack: 0.08 }),
  /* full day complete — a soft blooming arpeggio, the warmest moment */
  bloom:   () => { note(392, { dur: 0.6, vol: 0.042, partial: 0.2 }); note(494, { dur: 0.6, vol: 0.040, when: 0.12, partial: 0.2 }); note(587, { dur: 0.7, vol: 0.038, when: 0.24, partial: 0.18 }); note(784, { dur: 1.0, vol: 0.034, when: 0.36, partial: 0.16 }); },
  /* picking up / setting down while dragging */
  drag:    () => note(262, { dur: 0.2, vol: 0.028, attack: 0.012 }),
  drop:    () => { note(330, { dur: 0.3, vol: 0.034 }); note(262, { dur: 0.4, vol: 0.030, when: 0.06 }); },
  /* copied — a soft confirmation */
  copy:    () => { note(440, { dur: 0.36, vol: 0.036, partial: 0.18 }); note(587, { dur: 0.5, vol: 0.032, when: 0.08, partial: 0.16 }); },
  /* tiny step toggle — a small soft wooden pop */
  pop:     () => note(440, { dur: 0.16, vol: 0.030, attack: 0.012, partial: 0.2 }),
};
/* ─────────── ambient soundscapes: generated live, so nothing loads over the wire ─────────── */
const makeNoise = (ctx, secs = 2.2) => {
  const len = Math.floor(ctx.sampleRate * secs);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { const white = Math.random() * 2 - 1; last = (last + 0.02 * white) / 1.02; d[i] = last * 3.2; }
  return buf;
};
const AMBIENCES = {
  rain:   { label: "Rain",   icon: "🌧" },
  forest: { label: "Forest", icon: "🌲" },
  waves:  { label: "Waves",  icon: "🌊" },
  hearth: { label: "Hearth", icon: "🔥" },
};
function createAmbient() {
  let ctx = null, master = null, running = null, nodes = [], timers = [];
  const stopAll = () => {
    timers.forEach(clearTimeout); timers = [];
    nodes.forEach((n) => { try { n.stop && n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} });
    nodes = []; running = null;
  };
  const ensure = () => {
    ctx = getCtx(); if (!ctx) return false;
    if (!master) { master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination); }
    return true;
  };
  const bed = (type, freq, q, vol, lfoRate, lfoDepth) => {
    const src = ctx.createBufferSource(); src.buffer = makeNoise(ctx); src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(master);
    if (lfoRate) { const lfo = ctx.createOscillator(); lfo.frequency.value = lfoRate; const lg = ctx.createGain(); lg.gain.value = lfoDepth; lfo.connect(lg); lg.connect(g.gain); lfo.start(); nodes.push(lfo, lg); }
    src.start(); nodes.push(src, f, g); return g;
  };
  const blip = (freq, dur, vol, type = "sine") => {
    const o = ctx.createOscillator(); const g = ctx.createGain(); o.type = type; o.frequency.value = freq;
    const t = ctx.currentTime; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
  };
  const sprinkle = (make, minGap, maxGap) => {
    const loop = () => { if (!running) return; make(); timers.push(setTimeout(loop, minGap + Math.random() * (maxGap - minGap))); };
    timers.push(setTimeout(loop, 800 + Math.random() * 1500));
  };
  const start = (scene) => {
    if (!ensure()) return; stopAll(); running = scene;
    if (scene === "rain") {
      bed("lowpass", 1500, 0.6, 0.16);
      bed("bandpass", 2600, 0.7, 0.05, 0.12, 0.02);
    } else if (scene === "forest") {
      bed("lowpass", 900, 0.5, 0.09, 0.08, 0.02);
      sprinkle(() => { const f = 1600 + Math.random() * 1400; blip(f, 0.12, 0.04); blip(f * 1.5, 0.09, 0.025); }, 2600, 6000);
    } else if (scene === "waves") {
      const g = bed("lowpass", 700, 0.4, 0.02);
      const swell = () => {
        if (!running) return;
        const t = ctx.currentTime;
        g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0.20, t + 3.2); g.gain.linearRampToValueAtTime(0.05, t + 7.5);
        timers.push(setTimeout(swell, 7500));
      };
      swell();
    } else if (scene === "hearth") {
      bed("lowpass", 500, 0.4, 0.12, 0.15, 0.03);
      sprinkle(() => blip(120 + Math.random() * 180, 0.05, 0.05, "triangle"), 500, 2200);
    }
  };
  return { start, stop: () => stopAll(), setVolume: (v) => { if (master) master.gain.value = v; }, get scene() { return running; } };
}
let ambientEngine = null;
const getAmbient = () => { if (!ambientEngine) ambientEngine = createAmbient(); return ambientEngine; };
/* ── helpers ─────────────────────────────────────────────────────── */
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const fmtDay = (ts) => new Date(ts).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
const isToday = (ts) => new Date(ts).toDateString() === new Date().toDateString();
const dayKey = (ts) => { const d = new Date(ts); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
const weekKey = (ts) => {
  const d = new Date(ts);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const wk = Math.ceil((((d - jan1) / 86400000) + jan1.getDay() + 1) / 7);
  return d.getFullYear() + "-W" + wk;
};
const prevWeekKey = () => { const d = new Date(); d.setDate(d.getDate() - 7); return weekKey(d.getTime()); };
const partOfDay = () => {
  const h = new Date().getHours();
  if (h < 5) return "night"; if (h < 12) return "morning";
  if (h < 17) return "afternoon"; if (h < 21) return "evening"; return "night";
};
const GREET = { morning: "Good morning,", afternoon: "Good afternoon,", evening: "Good evening,", night: "A quiet night," };
const SUBLINE = {
  morning: "The day is unhurried. Begin softly.",
  afternoon: "A pause, a breath, and then the next small thing.",
  evening: "Let the day settle. Keep only what matters.",
  night: "Nothing is urgent now. Rest is also progress.",
};

/* season — central-India calendar seasons, an accent that turns with the year */
const SEASONS = {
  spring: { icon: "🌼" }, summer: { icon: "☀️" }, monsoon: { icon: "🌧" },
  autumn: { icon: "🍂" }, winter: { icon: "❄️" },
};
const seasonOf = () => {
  const m = new Date().getMonth();
  if (m === 11 || m === 0) return "winter";
  if (m === 1 || m === 2) return "spring";
  if (m >= 3 && m <= 5) return "summer";
  if (m >= 6 && m <= 8) return "monsoon";
  return "autumn";
};

const MOODS = [
  ["🌧️", "heavy", 1], ["🌫️", "foggy", 2], ["🌿", "steady", 3], ["☀️", "light", 4], ["✨", "bright", 5],
];
const MOOD_VALUE = Object.fromEntries(MOODS.map(([e, , v]) => [e, v]));
const MOOD_NAME = Object.fromEntries(MOODS.map(([e, n]) => [e, n]));

const PROMPTS = [
  "What felt light today?",
  "Name one thing you did gently.",
  "What are you quietly proud of?",
  "What would you like to let go of tonight?",
  "Where did your mind wander today?",
  "What did you notice that others might have missed?",
  "What's one kind thing you can tell yourself right now?",
  "What small moment deserves remembering?",
  "What is asking for your patience lately?",
  "If today had a colour, what would it be — and why?",
];
const dayOfYear = () => { const d = new Date(); return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000); };
const EVENING_PROMPTS = [
  "What made you smile today?",
  "What challenged you, and how did you meet it?",
  "What are you quietly proud of?",
  "What can you forgive yourself for tonight?",
  "What would you like to carry into tomorrow?",
];
const dailyPrompt = () => {
  const p = partOfDay();
  const pool = (p === "evening" || p === "night") ? EVENING_PROMPTS : PROMPTS;
  return pool[dayOfYear() % pool.length];
};

/* gentle affirmations — a line to open the day, softer ones to close it */
const AFFIRMATIONS = [
  "The way you spend your morning shapes your day.",
  "Progress over perfection, always.",
  "You're allowed to move at your own pace.",
  "Small steps, taken gently, still arrive.",
  "Begin where you are — that's always enough.",
  "You don't have to earn your own kindness.",
  "The quiet things count too.",
  "You've carried harder days than this one.",
];
const EVENING_AFFIRMATIONS = [
  "You did enough today. Let the rest be.",
  "The day is closing — you can set it down now.",
  "Whatever got done, got done. That's alright.",
  "Softness at the end of the day is well earned.",
  "Tomorrow will ask for you gently. Rest first.",
];

/* when entries have been shrinking, the day may be asking for less —
   these need only a word or an image, never a paragraph */
const GENTLE_PROMPTS = [
  "Just one word for today?",
  "A single moment — what was it?",
  "No need for sentences. What's here right now?",
  "One small thing. What comes to mind?",
];
const dailyAffirmation = () => {
  const p = partOfDay();
  const pool = (p === "evening" || p === "night") ? EVENING_AFFIRMATIONS : AFFIRMATIONS;
  return pool[dayOfYear() % pool.length];
};

/* ── memory recall: echo a real past journal line on the Today hero.
   Deterministic per day (like the affirmation) so it's stable within a day
   but turns over daily. Only ever shows a genuine old entry — never
   fabricates. Tagged, longer entries are preferred as more intentional. ── */
const MONTHN = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const recallExcerpt = (text) => {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= 90) return clean;
  const cut = clean.slice(0, 90);
  const at = cut.lastIndexOf(" ");
  return (at > 40 ? cut.slice(0, at) : cut).trim() + "…";
};
/* one memory voice, shared by the Today hero and the Journal screen. */
const memoryLead = (entry, tag) => {
  const d = new Date(entry.stamp), now = new Date();
  const days = Math.floor((Date.now() - entry.stamp) / 86400000);
  let when;
  if (days >= 330) when = "a year ago";
  else if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) when = "earlier this month";
  else when = `back in ${MONTHN[d.getMonth()]}`;
  const When = when.charAt(0).toUpperCase() + when.slice(1);
  if (tag) return `#${tag} has been on your mind — ${when} you wrote:`;
  return `${When}, you wrote:`;
};

/* one selector, used by both surfaces. `prefer` only changes which kind of
   connection it looks for first — the fallbacks and the voice are identical,
   so the two screens can never contradict each other. */
const pickMemory = (journal, { recentTags = [], prefer = "age" } = {}) => {
  const now = Date.now();
  const past = journal.filter((j) => j.text && j.text.trim().length >= 24 && !isToday(j.stamp));
  if (!past.length) return null;
  const recent = new Set(recentTags.map((t) => t.toLowerCase()));
  const today = new Date();

  const byDate = () => past
    .filter((j) => new Date(j.stamp).getDate() === today.getDate())
    .sort((a, b) => b.stamp - a.stamp)[0] || null;
  const byTheme = () => {
    const hits = past.filter((j) => (j.tags || []).some((t) => recent.has(t.toLowerCase())));
    return hits.sort((a, b) => b.stamp - a.stamp)[0] || null;
  };
  const byAge = () => {
    const old = past.filter((j) => now - j.stamp >= 30 * 86400000);
    const tagged = old.filter((j) => (j.tags || []).length);
    const pool = tagged.length ? tagged : old;
    if (!pool.length) return null;
    return [...pool].sort((a, b) => a.stamp - b.stamp)[dayOfYear() % pool.length];
  };

  const order = prefer === "date" ? [byDate, byTheme, byAge] : [byTheme, byAge, byDate];
  for (const fn of order) {
    const hit = fn();
    if (hit) {
      const tag = (hit.tags || []).find((t) => recent.has(t.toLowerCase())) || null;
      return { entry: hit, tag };
    }
  }
  return null;
};

/* energy-aware nudge: match the hour's natural energy to a pending intention.
   Returns one gentle line, or null when there's nothing worth saying. */
const energyForPart = (pod) =>
  pod === "morning" ? "high" : (pod === "evening" || pod === "night") ? "low" : "medium";

const pickEnergyNudge = (todos) => {
  const pod = partOfDay();
  const openAll = todos.filter((t) => !t.done && (t.bucket || "today") === "today");

  // late in the day with a lot still open — offer tomorrow, gently (takes priority)
  if ((pod === "evening" || pod === "night") && openAll.length >= 4) {
    return { text: `${openAll.length} intentions are still open — the unfinished ones will keep until tomorrow.`, id: null };
  }

   
  const want = energyForPart(pod);
  const open = openAll.filter((t) => t.energy);
  if (!open.length) return null;

  const match = open.find((t) => t.energy === want);
  if (match) {
    if (want === "high")
      return { text: `Your energy runs highest now — a good moment for “${match.text}.”`, id: match.id };
    if (want === "low")
      return { text: `The day is winding down. Something light like “${match.text}” is plenty.`, id: match.id };
    return { text: `A steady stretch — “${match.text}” fits the hour.`, id: match.id };
  }
  if ((pod === "evening" || pod === "night") && open.every((t) => t.energy === "high"))
    return { text: "Only the heavier intentions are left — evening is a fair time to let them wait.", id: null };
  return null;
};

/* the shape of a life, in facts — a compact, factual snapshot across every
   surface, for the companion to hold. Never interprets, never invents;
   any line with too little evidence is simply left out. */
const DAYN = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

const buildLifeDigest = ({ todos, journal, gratitude, pocket }) => {
  const lines = [];
  const now = Date.now();
  const D = 86400000;

  /* — span & rhythm — */
  const oldest = Math.min(...journal.map((j) => j.stamp), ...todos.map((t) => t.stamp || now));
  const weeks = Math.floor((now - oldest) / (7 * D));
  if (weeks >= 2) lines.push(`Sukoon has been kept for about ${weeks} weeks.`);

  /* — journaling habits — */
  if (journal.length >= 3) {
    lines.push(`Journal entries: ${journal.length}.`);
    const eve = journal.filter((j) => new Date(j.stamp).getHours() >= 17).length;
    if (eve / journal.length >= 0.6) lines.push("Writes mostly in the evening.");
    else if (eve / journal.length <= 0.25) lines.push("Writes mostly earlier in the day.");
  }

  /* — enduring themes: tags returned to across months, not just this week — */
  const tagCounts = {};
  journal.forEach((j) => (j.tags || []).forEach((t) => {
    const k = t.toLowerCase(); tagCounts[k] = (tagCounts[k] || 0) + 1;
  }));
  const enduring = Object.entries(tagCounts).filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (enduring.length) lines.push(`Themes returned to often: ${enduring.map(([t]) => `"${t}"`).join(", ")}.`);

  /* — mood, over the long run — */
  const withMood = journal.filter((j) => j.mood);
  if (withMood.length >= 6) {
    const avg = withMood.reduce((s, j) => s + (MOOD_VALUE[j.mood] || 3), 0) / withMood.length;
    lines.push(`Mood usually sits ${avg >= 3.8 ? "on the lighter side" : avg <= 2.4 ? "on the heavier side" : "somewhere in the middle"}.`);
    const recent = withMood.filter((j) => now - j.stamp <= 21 * D);
    if (recent.length >= 3) {
      const rAvg = recent.reduce((s, j) => s + (MOOD_VALUE[j.mood] || 3), 0) / recent.length;
      if (rAvg - avg >= 0.5) lines.push("Lately, lighter than usual.");
      else if (avg - rAvg >= 0.5) lines.push("Lately, heavier than usual.");
    }
  }

  /* — what gets kept: rituals that actually hold — */
  const kept = todos.filter((t) => isRecurringItem(t) && (t.doneDays || []).length >= 5)
    .sort((a, b) => (b.doneDays || []).length - (a.doneDays || []).length).slice(0, 3);
  kept.forEach((t) => lines.push(`Has kept "${t.text}" on ${t.doneDays.length} days.`));

  /* — when things get done — */
  const done = todos.filter((t) => t.doneAt);
  if (done.length >= 10) {
    const morning = done.filter((t) => new Date(t.doneAt).getHours() < 12).length;
    if (morning / done.length >= 0.5) lines.push("Completes most intentions before noon.");
    const byDow = Array.from({ length: 7 }, () => 0);
    done.forEach((t) => byDow[new Date(t.doneAt).getDay()]++);
    const max = Math.max(...byDow);
    if (max >= done.length * 0.22) lines.push(`Most productive on ${DAYN[byDow.indexOf(max)]}.`);
  }

  /* — what's been set aside — */
  const someday = todos.filter((t) => t.bucket === "someday").length;
  if (someday >= 3) lines.push(`${someday} intentions parked for someday.`);

  /* — what's noticed with thanks — */
  if (gratitude.length >= 5) lines.push(`Has noted ${gratitude.length} small gratitudes.`);
  if (pocket.length >= 5) lines.push(`Keeps ${pocket.length} things in pocket.`);

  return lines.join("\n");
};

/* little lines that celebrate a small win, chosen at random */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const DONE_LINES = [
  "One less thing on your mind.",
  "That's done. Breathe out.",
  "Gently done — well done.",
  "A little lighter now.",
  "Off your plate, off your mind.",
  "That one's behind you now.",
];
const JOURNAL_LINES = [
  "Kept safe in your journal.",
  "Written down, and set down.",
  "Sometimes, writing is enough.",
  "That thought has a home now.",
];

/* a wider pool of gentle starters, three rotate in each day */
const STARTER_POOL = [
  { text: "Drink a glass of water", cat: "personal", icon: "💧" },
  { text: "One deep-work block", cat: "work", icon: "🕰️" },
  { text: "Text someone you love", cat: "personal", icon: "💌" },
  { text: "Tidy your inbox for 10 minutes", cat: "work", icon: "📥" },
  { text: "Step outside for fresh air", cat: "personal", icon: "🌤️" },
  { text: "Write down tomorrow's first task", cat: "work", icon: "📝" },
  { text: "Stretch for five minutes", cat: "personal", icon: "🧘" },
  { text: "Clear one task you've been avoiding", cat: "work", icon: "✅" },
  { text: "Call someone who'd love to hear from you", cat: "personal", icon: "📞" },
];
const todaysStarters = () => {
  const n = dayOfYear(); const start = (n * 3) % STARTER_POOL.length;
  return [0, 1, 2].map((i) => STARTER_POOL[(start + i) % STARTER_POOL.length]);
};

/* ritual bundles — a few intentions laid down together, morning or evening,
   in one gentle motion rather than one at a time */
const RITUAL_BUNDLES = [
  {
    id: "morning", label: "Morning ritual", icon: "🌅",
    blurb: "A soft way to begin",
    items: [
      { text: "Drink a glass of water", cat: "personal" },
      { text: "Stretch for five minutes", cat: "personal" },
      { text: "Write down today's top 3", cat: "work" },
    ],
  },
  {
    id: "evening", label: "Evening ritual", icon: "🌙",
    blurb: "A soft way to close",
    items: [
      { text: "Tidy your desk for tomorrow", cat: "work" },
      { text: "Write in your journal", cat: "personal" },
      { text: "Set out tomorrow's first task", cat: "work" },
    ],
  },
  {
    id: "reset", label: "Reset ritual", icon: "🧺",
    blurb: "For when things feel scattered",
    items: [
      { text: "Clear your inbox for 10 minutes", cat: "work" },
      { text: "Step outside for fresh air", cat: "personal" },
      { text: "Write down what's weighing on you", cat: "personal" },
    ],
  },
];

/* freeform tags — trimmed, case-insensitive de-duplication */
const normTag = (s) => s.trim().replace(/\s+/g, " ").replace(/^#/, "");
const addTagUnique = (arr, tag) => {
  const t = normTag(tag); if (!t) return arr;
  if (arr.some((a) => a.toLowerCase() === t.toLowerCase())) return arr;
  return [...arr, t];
};

/* ── ordering: fractional index so drag-to-reorder never needs a full rewrite ── */
const orderOf = (t) => (typeof t.order === "number" ? t.order : -t.stamp);

/* ── recurrence: none / daily / weekdays / custom days-of-week ─────
   Reads either the new `recur` object or falls back to the legacy
   boolean `recurring` flag, so older saved data keeps working. ──── */
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const getRecur = (t) => t.recur || (t.recurring ? { type: "daily", days: [] } : { type: "none", days: [] });
const isRecurringItem = (t) => getRecur(t).type !== "none";
const recursOn = (t, dow) => {
  const r = getRecur(t);
  if (r.type === "none") return false;
  if (r.type === "daily") return true;
  if (r.type === "weekdays") return dow >= 1 && dow <= 5;
  if (r.type === "custom") return (r.days || []).includes(dow);
  return false;
};
const recurLabel = (recur) => {
  if (!recur || recur.type === "none") return null;
  if (recur.type === "daily") return "Daily";
  if (recur.type === "weekdays") return "Weekdays";
  if (recur.type === "custom") {
    const days = [...(recur.days || [])].sort((a, b) => a - b);
    return days.length ? days.map((d) => DOW[d]).join(",") : "Custom";
  }
  return null;
};
const nextRecurType = (type) => ({ none: "daily", daily: "weekdays", weekdays: "custom", custom: "none" }[type] || "none");
const ENERGY = { low: "🟢", medium: "🟡", high: "🔴" };
const nextEnergy = (e) => ({ null: "low", low: "medium", medium: "high", high: null }[e ?? "null"] ?? null);

/* ── calendar helpers: Google Calendar link + .ics export ─────────── */
const pad2 = (n) => String(n).padStart(2, "0");
const dateISO = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
const toICSStamp = (d) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
const gcalLink = (title, timeStr) => {
  let dates;
  if (timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    const start = new Date(); start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + 30 * 60000);
    dates = `${toICSStamp(start)}/${toICSStamp(end)}`;
  } else {
    const start = new Date();
    const end = new Date(start); end.setDate(end.getDate() + 1);
    dates = `${dateISO(start)}/${dateISO(end)}`;
  }
  const params = new URLSearchParams({ action: "TEMPLATE", text: title, dates, details: "Added from Sukoon" });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
};
const buildICS = (events) => {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sukoon//EN", "CALSCALE:GREGORIAN"];
  events.forEach((e) => {
    lines.push("BEGIN:VEVENT");
    lines.push("UID:" + e.id + "@sukoon");
    lines.push("DTSTAMP:" + toICSStamp(new Date()));
    lines.push("DTSTART:" + toICSStamp(e.start));
    lines.push("DTEND:" + toICSStamp(e.end));
    lines.push("SUMMARY:" + e.title.replace(/\r?\n/g, " "));
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
};

/* ── merge-on-import: union by id, existing data always wins on conflict ── */
const mergeById = (existing, incoming) => {
  if (!Array.isArray(incoming) || incoming.length === 0) return existing;
  const map = new Map(existing.map((x) => [x.id, x]));
  let added = 0;
  incoming.forEach((x) => { if (x && x.id && !map.has(x.id)) { map.set(x.id, x); added += 1; } });
  return { list: [...map.values()], added };
};

/* breathing patterns — a small orb, several rhythms */
const SCALE_BIG = 1, SCALE_SMALL = 0.62;
const PATTERNS = {
  calm: { label: "4–4–6 · calm", steps: [
    { phase: "Breathe in", secs: 4, sound: "inhale", big: true },
    { phase: "Hold", secs: 4, sound: "hold", big: true },
    { phase: "Breathe out", secs: 6, sound: "exhale", big: false },
  ] },
  box: { label: "4–4–4–4 · box", steps: [
    { phase: "Breathe in", secs: 4, sound: "inhale", big: true },
    { phase: "Hold", secs: 4, sound: "hold", big: true },
    { phase: "Breathe out", secs: 4, sound: "exhale", big: false },
    { phase: "Hold", secs: 4, sound: "hold", big: false },
  ] },
  deep: { label: "4–7–8 · deep", steps: [
    { phase: "Breathe in", secs: 4, sound: "inhale", big: true },
    { phase: "Hold", secs: 7, sound: "hold", big: true },
    { phase: "Breathe out", secs: 8, sound: "exhale", big: false },
  ] },
};

/* ═════════════════════════════  ROOT  ═════════════════════════════ */
function Sukoon({ session }) {
  const [view, setView] = useState("today");
  const [theme, setTheme] = useState("dawn");
  const [filter, setFilter] = useState("all");
  const [todos, setTodos] = useState([]);
  const [journal, setJournal] = useState([]);
  const [pocket, setPocket] = useState([]);
   const [gratitude, setGratitude] = useState([]);
  const [gratDraft, setGratDraft] = useState(["", "", ""]);
  const [weeklyIntentions, setWeeklyIntentions] = useState({}); // { "2026-W28": "text" }
  const [weekIntentEditing, setWeekIntentEditing] = useState(false);
  const [weekIntentDraft, setWeekIntentDraft] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const [companionOn, setCompanionOn] = useState(true);
  const [reflectingId, setReflectingId] = useState(null);
  const [memoryOn, setMemoryOn] = useState(false);          // opt-in, off by default
  const [companionMemory, setCompanionMemory] = useState(""); // the distilled digest
  const [memoryRevealed, setMemoryRevealed] = useState(false);
  const [letters, setLetters] = useState([]); // [{ weekKey, text, createdAt }] newest first
  const [letterComposing, setLetterComposing] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
   const [ambient, setAmbient] = useState(null); // active scene key, or null
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState(null); // { msg, undo }
  const [celebrate, setCelebrate] = useState(false);
  const [panicMode, setPanicMode] = useState(false);
  const [monthOffset, setMonthOffset] = useState(0);
  const [reviewRange, setReviewRange] = useState("week");
  const [reviewMonthOffset, setReviewMonthOffset] = useState(0);
  const [sortMode, setSortMode] = useState("manual");
  const [somedayOpen, setSomedayOpen] = useState(false);

  const [draft, setDraft] = useState("");
  const [draftCat, setDraftCat] = useState("work");
  const [draftRecur, setDraftRecur] = useState({ type: "none", days: [] });
   const [draftEnergy, setDraftEnergy] = useState(null); // null | 'low' | 'medium' | 'high'
  const [draftBucket, setDraftBucket] = useState("today");
  const [draftTime, setDraftTime] = useState("");
  const [draftTags, setDraftTags] = useState([]);
  const [draftTagInput, setDraftTagInput] = useState("");
  const [tagFilter, setTagFilter] = useState(null);
  const [taggingId, setTaggingId] = useState(null);
  const [tagInput, setTagInput] = useState("");
  const [recurEditId, setRecurEditId] = useState(null);
  const [subOpenId, setSubOpenId] = useState(null);
  const [subDraft, setSubDraft] = useState("");
  const [notifPermission, setNotifPermission] = useState(
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported"
  );
  const [entryText, setEntryText] = useState("");
  const [entryMood, setEntryMood] = useState(null);
  const [entryTags, setEntryTags] = useState([]);
  const [entryTagInput, setEntryTagInput] = useState("");
  const [journalQuery, setJournalQuery] = useState("");
  const [journalTagFilter, setJournalTagFilter] = useState(null);
  const [pTitle, setPTitle] = useState("");
  const [pLink, setPLink] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [editingJournalId, setEditingJournalId] = useState(null);
  const [editJournalText, setEditJournalText] = useState("");
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const soundRef = useRef(true); soundRef.current = soundOn;
  const play = useCallback((n) => { if (soundRef.current && SOUNDS[n]) SOUNDS[n](); }, []);
   const enterPanic = () => {
  if (ambient) { getAmbient().stop(); setAmbient(null); }
  setPanicMode(true); play("tap");
};
const exitPanic = () => { setPanicMode(false); play("nav"); };
useEffect(() => {
  if (!panicMode) return;
  const onKey = (e) => { if (e.key === "Escape") exitPanic(); };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [panicMode]); // eslint-disable-line react-hooks/exhaustive-deps
   const toggleAmbient = (scene) => {
    const eng = getAmbient();
    if (ambient === scene) { eng.stop(); setAmbient(null); play("tap"); return; }
    eng.start(scene); setAmbient(scene); play("nav");
  };
  useEffect(() => () => { if (ambientEngine) ambientEngine.stop(); }, []);

  const todoInputRef = useRef(null);
  const journalTextRef = useRef(null);
  const pocketInputRef = useRef(null);
  const undoRef = useRef(null);
  const toastTimerRef = useRef(null);
  const reminderTimers = useRef({});
  const importInputRef = useRef(null);
  const starters = useMemo(() => todaysStarters(), []);
  const recentTags = useMemo(() => {
  const CUTOFF = Date.now() - 21 * 86400000;
  const bag = new Map(); // lowercased key -> original casing
  const add = (tags) => (tags || []).forEach((t) => {
    const k = t.toLowerCase(); if (!bag.has(k)) bag.set(k, t);
  });
  journal.forEach((j) => { if (j.stamp >= CUTOFF) add(j.tags); });
  todos.forEach((t) => { if ((t.stamp || 0) >= CUTOFF) add(t.tags); });
  return [...bag.values()];
}, [journal, todos]);

   const displayName = useMemo(() => {
  const m = session?.user?.user_metadata;
  return m?.full_name || m?.name || "";
}, [session]);

const recall = useMemo(() => pickMemory(journal, { recentTags, prefer: "age" }), [journal, recentTags]);
   const energyNudge = useMemo(() => pickEnergyNudge(todos), [todos]);

  /* load / persist */
  useEffect(() => {
    (async () => {
      let found = false;
      try {
        const res = await store.get(STORAGE_KEY);
        if (res && res.value) {
          const d = JSON.parse(res.value);
          setTodos(d.todos || []); setJournal(d.journal || []); setPocket(d.pocket || []);
          setGratitude(d.gratitude || []);
          if (typeof d.soundOn === "boolean") setSoundOn(d.soundOn);
          if (typeof d.companionOn === "boolean") setCompanionOn(d.companionOn);
          if (typeof d.memoryOn === "boolean") setMemoryOn(d.memoryOn);
          if (typeof d.companionMemory === "string") setCompanionMemory(d.companionMemory);
          if (Array.isArray(d.letters)) setLetters(d.letters);
          else if (d.weeklyLetter && typeof d.weeklyLetter === "object") setLetters([d.weeklyLetter]); // migrate old single letter
          if (d.theme) setTheme(d.theme);
          found = true;
        }
      } catch (e) { /* first visit */ }
      if (!found) {
        for (const k of ["pragya-dashboard-v3", "pragya-dashboard-v2"]) {
          try {
            const old = await store.get(k);
            if (old && old.value) {
              const d = JSON.parse(old.value);
              setTodos(d.todos || []); setJournal(d.journal || []); setPocket(d.pocket || []);
              break;
            }
          } catch (e) { /* keep looking */ }
        }
      }
      setLoaded(true);
    })();
  }, []);

  /* roll recurring intentions over to "not done" on a fresh day, without losing history —
     only for items actually scheduled today under their recurrence rule */
  useEffect(() => {
    if (!loaded) return;
    const tk = dayKey(Date.now());
    const dow = new Date().getDay();
    setTodos((ts) => ts.map((t) => {
      if (!isRecurringItem(t)) return t;
      if (!recursOn(t, dow)) return t;
      return { ...t, done: (t.doneDays || []).includes(tk) };
    }));
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(async () => {
     try { await store.set(STORAGE_KEY, JSON.stringify({ todos, journal, pocket, gratitude, soundOn, companionOn, memoryOn, companionMemory, letters, theme })); }
      catch (e) { console.error("save failed", e); }
    }, 400);
    return () => clearTimeout(t);
  }, [todos, journal, pocket, gratitude, soundOn, companionOn, memoryOn, companionMemory, letters, theme, loaded]);
  /* schedule gentle reminder notifications for intentions with a time set,
     while this tab stays open — browsers don't allow background delivery otherwise */
  useEffect(() => {
    Object.values(reminderTimers.current).forEach(clearTimeout);
    reminderTimers.current = {};
    if (!loaded || notifPermission !== "granted") return;
    const now = Date.now();
    todos.forEach((t) => {
      if (!t.reminderOn || !t.time || t.done) return;
      const [h, m] = t.time.split(":").map(Number);
      const target = new Date(); target.setHours(h, m, 0, 0);
      const ms = target.getTime() - now;
      if (ms <= 0) return;
      reminderTimers.current[t.id] = setTimeout(() => {
        try { new Notification("Sukoon · gentle reminder", { body: t.text }); } catch (e) { /* ignore */ }
        play("tap");
      }, ms);
    });
    return () => { Object.values(reminderTimers.current).forEach(clearTimeout); };
  }, [todos, notifPermission, loaded, play]);

  const flash = (m) => {
    clearTimeout(toastTimerRef.current); undoRef.current = null;
    setToast({ msg: m, undo: false });
    toastTimerRef.current = setTimeout(() => setToast(null), 1800);
  };
  const showUndoToast = (m, undoFn) => {
    clearTimeout(toastTimerRef.current);
    undoRef.current = undoFn;
    setToast({ msg: m, undo: true });
    toastTimerRef.current = setTimeout(() => { setToast(null); undoRef.current = null; }, 5000);
  };
  const performUndo = () => {
    if (undoRef.current) { undoRef.current(); play("undo"); }
    clearTimeout(toastTimerRef.current);
    setToast(null); undoRef.current = null;
  };

   const signOut = async () => {
  if (!supabase) return;
  await supabase.auth.signOut();
  setStoreUser(null);
};

  /* actions */
  const addTodo = () => {
    const v = draft.trim(); if (!v) return;
    let tags = draftTags;
    if (draftTagInput.trim()) draftTagInput.split(",").forEach((p) => { tags = addTagUnique(tags, p); });
    const minOrder = todos.length ? Math.min(...todos.map(orderOf)) : 0;
   setTodos((t) => [{
  id: uid(), text: v, cat: draftCat, done: false, stamp: Date.now(),
  recur: draftRecur, doneDays: [], time: draftTime || null, reminderOn: false,
  tags, order: minOrder - 1, bucket: draftBucket, subtasks: [], isFocus: false,
  energy: draftEnergy,
}, ...t]);
     
    setDraftEnergy(null); setDraft(""); setDraftRecur({ type: "none", days: [] }); setDraftTime("");
    setDraftTags([]); setDraftTagInput(""); setDraftBucket("today");
    // if the active filter would hide what was just added, clear it so the new intention shows
  const willHide = draftBucket === "today" &&
    ((filter !== "all" && filter !== draftCat) || (tagFilter && !tags.includes(tagFilter)));
  if (willHide) { setFilter("all"); setTagFilter(null); }
  play("add");
  if (draftBucket === "someday") flash("Parked for someday");
  else if (willHide) flash("Added — cleared the filter so you can see it");
  };
  const addStarter = (s) => {
    const minOrder = todos.length ? Math.min(...todos.map(orderOf)) : 0;
    setTodos((t) => [{ id: uid(), text: s.text, cat: s.cat, done: false, stamp: Date.now(), recur: { type: "none", days: [] }, doneDays: [], time: null, reminderOn: false, tags: [], order: minOrder - 1, bucket: "today", subtasks: [], isFocus: false }, ...t]);
    play("add"); flash("Added — small is still a start");
  };

   /* ritual bundles: lay down a few intentions together, in one gentle motion —
     skip anything whose text is already sitting in today's list, so re-tapping is always safe */
  const addBundle = (bundle) => {
    const already = new Set(todayTodos.map((t) => t.text.trim().toLowerCase()));
    const toAdd = bundle.items.filter((it) => !already.has(it.text.trim().toLowerCase()));
    if (toAdd.length === 0) { flash("Already part of today"); return; }
    const minOrder = todos.length ? Math.min(...todos.map(orderOf)) : 0;
    const now = Date.now();
    const fresh = toAdd.map((it, i) => ({
      id: uid(), text: it.text, cat: it.cat, done: false, stamp: now,
      recur: { type: "none", days: [] }, doneDays: [], time: null, reminderOn: false,
      tags: [], order: minOrder - 1 - i, bucket: "today", subtasks: [], isFocus: false,
    }));
    setTodos((t) => [...fresh, ...t]);
    play("add");
    flash(toAdd.length === bundle.items.length
      ? `${bundle.label} laid down — ${toAdd.length} intention${toAdd.length === 1 ? "" : "s"}`
      : `Added ${toAdd.length} — the rest were already there`);
  };
  const commitDraftTag = () => {
    let next = draftTags;
    draftTagInput.split(",").forEach((p) => { next = addTagUnique(next, p); });
    setDraftTags(next); setDraftTagInput("");
  };
  const removeDraftTag = (tag) => setDraftTags((ts) => ts.filter((t) => t !== tag));
  const cycleDraftRecur = () => {
    setDraftRecur((r) => {
      const type = nextRecurType(r.type);
      return { type, days: r.days || [] };
    });
    play("tap");
  };
   const cycleDraftEnergy = () => { setDraftEnergy((e) => nextEnergy(e)); play("tap"); };
const cycleRowEnergy = (id) => {
  setTodos((ts) => ts.map((x) => (x.id === id ? { ...x, energy: nextEnergy(x.energy) } : x)));
  play("tap");
};
  const toggleDraftDay = (d) => {
    setDraftRecur((r) => {
      const days = new Set(r.days || []);
      days.has(d) ? days.delete(d) : days.add(d);
      return { type: "custom", days: [...days] };
    });
  };
  const commitRowTag = (id) => {
    setTodos((ts) => ts.map((x) => {
      if (x.id !== id) return x;
      let next = x.tags || [];
      tagInput.split(",").forEach((p) => { next = addTagUnique(next, p); });
      return { ...x, tags: next };
    }));
    setTagInput(""); setTaggingId(null); play("tap");
  };
  const removeTodoTag = (id, tag) => {
    setTodos((ts) => ts.map((x) => (x.id === id ? { ...x, tags: (x.tags || []).filter((t) => t !== tag) } : x)));
  };
  const toggleTodo = (id) => {
    const tk = dayKey(Date.now());
    const item = todos.find((x) => x.id === id);
    const willComplete = item ? (isRecurringItem(item) ? !(item.doneDays || []).includes(tk) : !item.done) : false;
    const pendingBefore = todos.filter((t) => (t.bucket || "today") === "today" && !t.done).length;
    setTodos((t) => t.map((x) => {
      if (x.id !== id) return x;
      if (isRecurringItem(x)) {
        const days = new Set(x.doneDays || []);
        const already = days.has(tk);
        already ? days.delete(tk) : days.add(tk);
        play(already ? "uncheck" : "check");
        return { ...x, doneDays: [...days], done: !already, doneAt: already ? null : Date.now() };
      }
      play(x.done ? "uncheck" : "check");
      return { ...x, done: !x.done, doneAt: !x.done ? Date.now() : null };
    }));
    /* a gentle word for finishing something — but stay quiet on the last one,
       so the full-day celebration keeps the stage to itself */
    if (willComplete && pendingBefore > 1) flash(pick(DONE_LINES));
  };
  const removeTodo = (id) => {
    const item = todos.find((x) => x.id === id);
    play("delete");
    setTodos((t) => t.filter((x) => x.id !== id));
    if (editingId === id) setEditingId(null);
    if (subOpenId === id) setSubOpenId(null);
    if (item) showUndoToast("Intention removed", () => setTodos((t) => [item, ...t]));
  };
  const duplicateTodo = (id) => {
    const item = todos.find((x) => x.id === id);
    if (!item) return;
    const minOrder = todos.length ? Math.min(...todos.map(orderOf)) : 0;
    const copy = {
      ...item,
      id: uid(),
      done: false,
      doneAt: null,
      doneDays: [],
      recur: { type: "none", days: [] },
      subtasks: (item.subtasks || []).map((s) => ({ ...s, id: uid(), done: false })),
      stamp: Date.now(),
      order: minOrder - 1,
      isFocus: false,
    };
    setTodos((t) => [copy, ...t]);
    play("add"); flash("Duplicated — ready for next time");
  };
  /* bulk action: sweep away completed, one-time intentions — recurring ones stay since "done" just means done-for-today */
  const clearCompleted = () => {
    const cleared = todos.filter((t) => t.done && !isRecurringItem(t));
    if (cleared.length === 0) { flash("Nothing completed to clear"); return; }
    play("delete");
    setTodos((t) => t.filter((x) => !(x.done && !isRecurringItem(x))));
    showUndoToast(`Cleared ${cleared.length} completed`, () => setTodos((t) => [...cleared, ...t]));
  };
  const startEdit = (t) => { setEditingId(t.id); setEditText(t.text); };
  const commitEdit = (id) => {
    setTodos((t) => t.map((x) => {
      if (x.id !== id) return x;
      const v = editText.trim();
      return v ? { ...x, text: v } : x;
    }));
    setEditingId(null);
  };

  /* recurrence editing for an existing row */
  const cycleRowRecur = (id) => {
    setTodos((ts) => ts.map((x) => {
      if (x.id !== id) return x;
      const cur = getRecur(x);
      const type = nextRecurType(cur.type);
      return { ...x, recurring: undefined, recur: { type, days: cur.days || [] } };
    }));
    setTodos((ts) => {
      const item = ts.find((x) => x.id === id);
      if (item && getRecur(item).type === "custom") setRecurEditId(id);
      else setRecurEditId((cur) => (cur === id ? null : cur));
      return ts;
    });
    play("tap");
  };
  const toggleRowDay = (id, d) => {
    setTodos((ts) => ts.map((x) => {
      if (x.id !== id) return x;
      const cur = getRecur(x);
      const days = new Set(cur.days || []);
      days.has(d) ? days.delete(d) : days.add(d);
      return { ...x, recurring: undefined, recur: { type: "custom", days: [...days] } };
    }));
  };
  const clearRowRecur = (id) => {
    setTodos((ts) => ts.map((x) => (x.id === id ? { ...x, recurring: undefined, recur: { type: "none", days: [] } } : x)));
    setRecurEditId(null); play("tap");
  };

  /* sub-checklist: break one intention into a few smaller steps */
  const addSubtask = (todoId) => {
    const v = subDraft.trim(); if (!v) return;
    setTodos((ts) => ts.map((x) => (x.id === todoId ? { ...x, subtasks: [...(x.subtasks || []), { id: uid(), text: v, done: false }] } : x)));
    setSubDraft(""); play("add");
  };
  const toggleSubtask = (todoId, subId) => {
    setTodos((ts) => ts.map((x) => {
      if (x.id !== todoId) return x;
      return { ...x, subtasks: (x.subtasks || []).map((s) => (s.id === subId ? { ...s, done: !s.done } : s)) };
    }));
    play("pop");
  };
  const removeSubtask = (todoId, subId) => {
    setTodos((ts) => ts.map((x) => (x.id === todoId ? { ...x, subtasks: (x.subtasks || []).filter((s) => s.id !== subId) } : x)));
  };

  /* someday bucket: park an intention with no date, pull it in when ready */
  const sendToSomeday = (id) => {
    setTodos((ts) => ts.map((x) => (x.id === id ? { ...x, bucket: "someday" } : x)));
    play("tap"); flash("Parked for someday");
  };
  const pullToToday = (id) => {
    const minOrder = todos.length ? Math.min(...todos.map(orderOf)) : 0;
    setTodos((ts) => ts.map((x) => (x.id === id ? { ...x, bucket: "today", order: minOrder - 1, stamp: Date.now() } : x)));
    play("add"); flash("Pulled into today");
  };

   /* today's focus: one pinned intention, separate from the general list. Setting one clears any other. */
const toggleFocus = (id) => {
  setTodos((ts) => ts.map((x) => {
    if (x.id === id) return { ...x, isFocus: !x.isFocus };
    return x.isFocus ? { ...x, isFocus: false } : x;
  }));
  play("tap");
};

  /* drag-to-reorder: fractional ordering so we never touch every row, just the one moved */
  const reorderTodo = (draggedId, targetId) => {
    if (!draggedId || !targetId || draggedId === targetId) return;
    setTodos((ts) => {
      const sorted = [...ts].sort((a, b) => (a.done - b.done) || (orderOf(a) - orderOf(b)));
      const from = sorted.findIndex((x) => x.id === draggedId);
      const to = sorted.findIndex((x) => x.id === targetId);
      if (from === -1 || to === -1) return ts;
      const rest = sorted.filter((x) => x.id !== draggedId);
      const insertAt = rest.findIndex((x) => x.id === targetId);
      const before = rest[insertAt - 1];
      const after = rest[insertAt];
      const beforeOrder = before ? orderOf(before) : (after ? orderOf(after) - 2 : 0);
      const afterOrder = after ? orderOf(after) : (before ? orderOf(before) + 2 : 2);
      const newOrder = (beforeOrder + afterOrder) / 2;
      return ts.map((x) => (x.id === draggedId ? { ...x, order: newOrder } : x));
    });
  };
  const onRowDragStart = (id) => (e) => {
    if (sortMode !== "manual") { e.preventDefault(); return; }
    setDragId(id); e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", id); } catch (err) { /* ignore */ }
    play("drag");
  };
  const onRowDragOver = (id) => (e) => { if (sortMode !== "manual") return; e.preventDefault(); if (dragOverId !== id) setDragOverId(id); };
  const onRowDrop = (id) => (e) => {
    if (sortMode !== "manual") return;
    e.preventDefault();
    if (dragId && dragId !== id) { reorderTodo(dragId, id); play("drop"); }
    setDragId(null); setDragOverId(null);
  };
  const onRowDragEnd = () => { setDragId(null); setDragOverId(null); };

  const requestNotifPermission = () => {
    if (!("Notification" in window)) return;
    Notification.requestPermission().then((p) => setNotifPermission(p));
  };
  const toggleReminder = (id) => {
    if (notifPermission === "denied") { flash("Notifications are blocked in your browser settings"); return; }
    if (notifPermission !== "granted") requestNotifPermission();
    setTodos((t) => t.map((x) => (x.id === id ? { ...x, reminderOn: !x.reminderOn } : x)));
    play("tap");
  };
  const exportToCalendar = () => {
    const withTime = todos.filter((t) => !t.done && t.time && (t.bucket || "today") === "today");
    if (withTime.length === 0) { flash("Add a time to an intention to export it"); return; }
    const events = withTime.map((t) => {
      const [h, m] = t.time.split(":").map(Number);
      const start = new Date(); start.setHours(h, m, 0, 0);
      const end = new Date(start.getTime() + 30 * 60000);
      return { id: t.id, title: t.text, start, end };
    });
    const ics = buildICS(events);
    const blob = new Blob([ics], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "sukoon-intentions.ics";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flash("Calendar file downloaded");
  };

  /* copy today's completed intentions as a Slack-ready message */
  const copyAsSlack = async () => {
    const tk = dayKey(Date.now());
    const completedToday = todos.filter((t) => (isRecurringItem(t) ? (t.doneDays || []).includes(tk) : (t.done && t.doneAt && isToday(t.doneAt))));
    if (completedToday.length === 0) { flash("Nothing completed today yet"); return; }
    const dateLabel = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
    const lines = [`*Today's intentions* — ${dateLabel}`, ""];
    completedToday.forEach((t) => lines.push(`✅ ${t.text}${t.cat ? `  _${t.cat}_` : ""}`));
    const stillOpen = todos.filter((t) => !t.done && !isRecurringItem(t) && (t.bucket || "today") === "today");
    if (stillOpen.length) {
      lines.push(""); lines.push("*Still open:*");
      stillOpen.forEach((t) => lines.push(`• ${t.text}`));
    }
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      play("copy"); flash("Copied — ready to paste in Slack");
    } catch (e) {
      flash("Couldn't access the clipboard");
    }
  };

  const commitEntryTag = () => {
    let next = entryTags;
    entryTagInput.split(",").forEach((p) => { next = addTagUnique(next, p); });
    setEntryTags(next); setEntryTagInput("");
  };
  const removeEntryTag = (tag) => setEntryTags((ts) => ts.filter((t) => t !== tag));

  const saveEntry = () => {
    const v = entryText.trim(); if (!v) return;
    let tags = entryTags;
    if (entryTagInput.trim()) entryTagInput.split(",").forEach((p) => { tags = addTagUnique(tags, p); });
    setJournal((j) => [{ id: uid(), stamp: Date.now(), mood: entryMood, text: v, prompt: journalPrompt.text, tags }, ...j]);
    setEntryText(""); setEntryMood(null); setEntryTags([]); setEntryTagInput("");
    play("save"); flash(pick(JOURNAL_LINES));
  };

   const reflectOnEntry = async (j) => {
    if (!supabase || reflectingId) return;
    setReflectingId(j.id);
    play("tap");
    try {
      const payload = { text: j.text, mood: j.mood ? MOOD_NAME[j.mood] : null };
      if (memoryOn) {
        payload.memory = companionMemory || "";
        if (lifeDigest) payload.life = lifeDigest;
      }
      const { data, error } = await supabase.functions.invoke("journal-companion", { body: payload });
      if (error) throw error;
      const line = data && data.line;
      if (line) {
        setJournal((arr) => arr.map((x) =>
          x.id === j.id ? { ...x, companion: line, companionDistress: !!data.distress } : x));
        // only update memory on a non-distress reflection that returned a digest
        if (memoryOn && !data.distress && typeof data.memory === "string") {
          setCompanionMemory(data.memory);
        }
      } else {
        flash("No reflection just now — your words stand on their own");
      }
    } catch (e) {
      flash("Couldn't reflect right now");
    } finally {
      setReflectingId(null);
    }
  };
  const removeEntry = (id) => {
    const item = journal.find((x) => x.id === id);
    play("delete");
    setJournal((j) => j.filter((x) => x.id !== id));
    if (item) showUndoToast("Entry removed", () => setJournal((j) => [item, ...j]));
  };
  const startEditEntry = (j) => { setEditingJournalId(j.id); setEditJournalText(j.text); };
  const commitEditEntry = (id) => {
    setJournal((j) => j.map((x) => {
      if (x.id !== id) return x;
      const v = editJournalText.trim();
      return v ? { ...x, text: v } : x;
    }));
    setEditingJournalId(null);
  };
  const exportJournal = () => {
    if (journal.length === 0) { flash("Nothing to export yet"); return; }
    const body = [...journal].sort((a, b) => a.stamp - b.stamp)
      .map((j) => `${fmtDay(j.stamp)} · ${fmtTime(j.stamp)}${j.mood ? "  " + j.mood : ""}${(j.tags || []).length ? "  " + j.tags.map((t) => "#" + t).join(" ") : ""}\n${j.text}`)
      .join("\n\n───\n\n");
    const blob = new Blob([`Sukoon — journal export\n\n${body}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "sukoon-journal.txt";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flash("Journal exported");
  };
  const exportEntry = (j) => {
    const body = `${fmtDay(j.stamp)} · ${fmtTime(j.stamp)}${j.mood ? "  " + j.mood : ""}${(j.tags || []).length ? "  " + j.tags.map((t) => "#" + t).join(" ") : ""}\n\n${j.prompt ? j.prompt + "\n\n" : ""}${j.text}\n`;
    const blob = new Blob([body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `sukoon-entry-${fmtDay(j.stamp).replace(/\s+/g, "-")}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flash("Entry exported");
  };

  const exportAllData = () => {
   const payload = { version: 1, exportedAt: Date.now(), todos, journal, pocket, gratitude, soundOn, companionOn, memoryOn, companionMemory, letters, theme };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `sukoon-backup-${dateISO(new Date())}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flash("Backup downloaded");
  };
  /* import merges with what's already here — nothing already saved is ever overwritten */
  const importAllData = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        if (!d || typeof d !== "object") throw new Error("bad file");
        let totalAdded = 0;
        setTodos((cur) => { const r = mergeById(cur, d.todos); totalAdded += r.added || 0; return r.list; });
        setJournal((cur) => { const r = mergeById(cur, d.journal); totalAdded += r.added || 0; return r.list; });
        setPocket((cur) => { const r = mergeById(cur, d.pocket); totalAdded += r.added || 0; return r.list; });
        setGratitude((cur) => { const r = mergeById(cur, d.gratitude); totalAdded += r.added || 0; return r.list; });
        flash(totalAdded > 0 ? `Merged ${totalAdded} item${totalAdded === 1 ? "" : "s"} from backup` : "Backup already up to date");
      } catch (err) { flash("That file couldn't be read"); }
    };
    reader.readAsText(file);
  };
   /* gratitude — three small things, captured for today */
  const todaysGratitude = gratitude.filter((g) => isToday(g.stamp));
  const setGratDraftAt = (i, v) => setGratDraft((d) => { const n = [...d]; n[i] = v; return n; });
  const commitGratitude = (i) => {
    const text = (gratDraft[i] || "").trim(); if (!text) return;
    setGratitude((g) => [...g, { id: uid(), text, stamp: Date.now() }]);
    setGratDraft((d) => d.filter((_, idx) => idx !== i));
    play("tap"); flash("Noted, with thanks");
  };
  const removeGratitude = (id) => {
    setGratitude((g) => g.filter((x) => x.id !== id));
    play("delete");
  };
const [thoughtDraft, setThoughtDraft] = useState("");
const saveThought = () => {
  const v = thoughtDraft.trim(); if (!v) return;
  setPocket((p) => [{ id: uid(), title: v, link: "", stamp: Date.now(), type: "thought" }, ...p]);
  setThoughtDraft(""); play("tap"); flash("Set down — pick it up later if you need to");
};
  const savePocket = () => {
    const v = pTitle.trim(); if (!v) return;
    setPocket((p) => [{ id: uid(), title: v, link: pLink.trim(), stamp: Date.now() }, ...p]);
    setPTitle(""); setPLink(""); play("save"); flash("Tucked into your pocket");
  };
  const removePocket = (id) => {
    const item = pocket.find((x) => x.id === id);
    play("delete");
    setPocket((p) => p.filter((x) => x.id !== id));
    if (item) showUndoToast("Item removed", () => setPocket((p) => [item, ...p]));
  };

  const keySound = (e) => { if (e.key.length === 1 || e.key === "Backspace") play("type"); };

  /* tab transition: remount content on view change for a clean cross-fade */
  const [fadeKey, setFadeKey] = useState(0);
  const goView = useCallback((k) => {
    setView((cur) => { if (cur === k) return cur; setFadeKey((n) => n + 1); play("nav"); return k; });
  }, [play]);

  /* keyboard shortcuts: "/" focuses the relevant composer, 1/2/3 switch tabs, "c" clears completed */
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "/") {
        e.preventDefault();
        if (view === "today" && todoInputRef.current) todoInputRef.current.focus();
        else if (view === "journal" && journalTextRef.current) journalTextRef.current.focus();
        else if (view === "pocket" && pocketInputRef.current) pocketInputRef.current.focus();
      } else if (e.key === "1") goView("today");
      else if (e.key === "2") goView("journal");
      else if (e.key === "3") goView("review");
      else if (e.key === "4") goView("pocket");
      else if ((e.key === "c" || e.key === "C") && view === "today") clearCompleted();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, goView]); // eslint-disable-line react-hooks/exhaustive-deps

  /* derived */
  const todayTodos = todos.filter((t) => (t.bucket || "today") === "today");
  const somedayTodos = todos.filter((t) => t.bucket === "someday");
  const pendingAll = todayTodos.filter((t) => !t.done);
   const focusTodo = todayTodos.find((t) => t.isFocus && !t.done) || null;
  const visible = todayTodos.filter((t) => (filter === "all" || t.cat === filter) && (!tagFilter || (t.tags || []).includes(tagFilter)));
  const allTags = useMemo(() => {
    const set = new Set();
    todayTodos.forEach((t) => (t.tags || []).forEach((tag) => set.add(tag)));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [todayTodos]);
  const activeFilterCount = (filter !== "all" ? 1 : 0) + (tagFilter ? 1 : 0);
  const clearAllFilters = () => { setFilter("all"); setTagFilter(null); play("nav"); };
  const doneCount = todayTodos.filter((t) => t.done).length;
  const pct = todayTodos.length ? Math.round((doneCount / todayTodos.length) * 100) : 0;
  const wroteToday = journal.some((j) => isToday(j.stamp));

  /* ordering for the visible list: manual (drag order) or by time (timed first, ascending) */
  const sortedVisible = useMemo(() => {
    const arr = [...visible];
    if (sortMode === "time") {
      arr.sort((a, b) => {
        if (a.done !== b.done) return a.done - b.done;
        if (!!a.time !== !!b.time) return a.time ? -1 : 1;
        if (a.time && b.time && a.time !== b.time) return a.time < b.time ? -1 : 1;
        return orderOf(a) - orderOf(b);
      });
    } else {
      arr.sort((a, b) => (a.done - b.done) || (orderOf(a) - orderOf(b)));
    }
    return arr;
  }, [visible, sortMode]);

  const activeDaySet = useMemo(() => new Set([
    ...todos.filter((t) => t.doneAt).map((t) => dayKey(t.doneAt)),
    ...journal.map((j) => dayKey(j.stamp)),
    ...pocket.map((p) => dayKey(p.stamp)),
  ]), [todos, journal, pocket]);

  /* streak with one grace ("freeze") day tolerated per calendar week */
  const { streak, frozeThisRun } = useMemo(() => {
    let s = 0, froze = false; const usedWeeks = new Set(); const d = new Date();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const key = dayKey(d.getTime());
      if (activeDaySet.has(key)) { s += 1; d.setDate(d.getDate() - 1); continue; }
      const wk = weekKey(d.getTime());
      if (!usedWeeks.has(wk) && s > 0) { usedWeeks.add(wk); froze = true; d.setDate(d.getDate() - 1); continue; }
      break;
    }
    return { streak: s, frozeThisRun: froze };
  }, [activeDaySet]);

  const weekRibbon = useMemo(() => {
    const arr = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(); dt.setDate(dt.getDate() - i);
      arr.push({
        key: dayKey(dt.getTime()),
        label: dt.toLocaleDateString("en-IN", { weekday: "short" }),
        active: activeDaySet.has(dayKey(dt.getTime())),
        today: i === 0,
      });
    }
    return arr;
  }, [activeDaySet]);

  const dayMeta = useMemo(() => {
    const map = {};
    const touch = (k) => (map[k] || (map[k] = { count: 0, mood: null, moodStamp: 0, journal: false }));
    todos.filter((t) => t.doneAt).forEach((t) => { touch(dayKey(t.doneAt)).count++; });
    pocket.forEach((p) => { touch(dayKey(p.stamp)).count++; });
    journal.forEach((j) => {
      const m = touch(dayKey(j.stamp));
      m.count++; m.journal = true;
      if (j.mood && j.stamp >= m.moodStamp) { m.mood = j.mood; m.moodStamp = j.stamp; }
    });
    return map;
  }, [todos, journal, pocket]);

  /* "on this day" — a past entry written on this same day-of-month, most recent first */
  const onThisDay = useMemo(() => pickMemory(journal, { recentTags, prefer: "date" }), [journal, recentTags]);

  const moodTrend = useMemo(() => (
    [...journal].filter((j) => j.mood).sort((a, b) => a.stamp - b.stamp).slice(-14)
      .map((j) => ({ v: MOOD_VALUE[j.mood] || 3, mood: j.mood, stamp: j.stamp }))
  ), [journal]);

  /* word-count trend — a second sparkline, paired alongside mood */
  const lengthTrend = useMemo(() => (
    [...journal].sort((a, b) => a.stamp - b.stamp).slice(-14)
      .map((j) => ({ v: j.text.trim() ? j.text.trim().split(/\s+/).length : 0, stamp: j.stamp }))
  ), [journal]);

   /* only meaningful once there's some history; below that, silence */
const lifeDigest = useMemo(() => {
  if (journal.length < 3 && todos.filter((t) => t.doneAt).length < 10) return "";
  return buildLifeDigest({ todos, journal, gratitude, pocket });
}, [todos, journal, gratitude, pocket]);

  /* when entries have been shrinking, offer a gentler prompt — a real
     downward trend only, never on a single short day */
  const journalPrompt = useMemo(() => {
    const base = dailyPrompt();
    const pts = lengthTrend;
    if (pts.length >= 4) {
      const avg = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
      const recent = pts.slice(-3).map((p) => p.v);
      const prior = pts.slice(-6, -3).map((p) => p.v);
      const rAvg = avg(recent);
      if (rAvg < 18 && (prior.length === 0 || rAvg < avg(prior) * 0.7)) {
        return { text: GENTLE_PROMPTS[dayOfYear() % GENTLE_PROMPTS.length], gentle: true };
      }
    }
    return { text: base, gentle: false };
  }, [lengthTrend]);

  const allJournalTags = useMemo(() => {
    const set = new Set();
    journal.forEach((j) => (j.tags || []).forEach((tag) => set.add(tag)));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [journal]);

  const filteredJournal = useMemo(() => {
    const q = journalQuery.trim().toLowerCase();
    return journal.filter((j) => {
      const moodName = j.mood ? (MOOD_NAME[j.mood] || "").toLowerCase() : "";
      const tagText = (j.tags || []).join(" ").toLowerCase();
      const matchesQuery = !q
        || j.text.toLowerCase().includes(q)
        || (j.prompt && j.prompt.toLowerCase().includes(q))
        || moodName.includes(q)
        || tagText.includes(q);
      const matchesTag = !journalTagFilter || (j.tags || []).includes(journalTagFilter);
      return matchesQuery && matchesTag;
    });
  }, [journal, journalQuery, journalTagFilter]);

  const weekStats = useMemo(() => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(); dt.setDate(dt.getDate() - i);
      const k = dayKey(dt.getTime());
      const doneCt = todos.filter((t) => t.doneAt && dayKey(t.doneAt) === k).length;
      const journalCt = journal.filter((j) => dayKey(j.stamp) === k).length;
      days.push({ key: k, label: dt.toLocaleDateString("en-IN", { weekday: "short" }), doneCt, journalCt, today: i === 0 });
    }
    const totalDone = days.reduce((s, d) => s + d.doneCt, 0);
    const totalJournal = days.reduce((s, d) => s + d.journalCt, 0);
    const maxDone = Math.max(1, ...days.map((d) => d.doneCt));
    return { days, totalDone, totalJournal, maxDone };
  }, [todos, journal]);

   /* a short reflective line for the week — evenings written, a recurring theme, the lightest day */
  const weekStory = useMemo(() => {
    const cutoff = Date.now() - 7 * 86400000;
    const wk = journal.filter((j) => j.stamp >= cutoff);
    const bits = [];
    const eve = wk.filter((j) => new Date(j.stamp).getHours() >= 17).length;
    if (eve > 0) bits.push(`You paused to write on ${eve} evening${eve === 1 ? "" : "s"}.`);
    const tagCounts = {};
    wk.forEach((j) => (j.tags || []).forEach((t) => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
    const topTag = Object.entries(tagCounts).sort((a, b) => b[1] - a[1])[0];
    if (topTag && topTag[1] >= 2) bits.push(`The theme you returned to most was “${topTag[0]}”.`);
    const byDay = {};
    wk.filter((j) => j.mood).forEach((j) => {
      const k = new Date(j.stamp).toLocaleDateString("en-IN", { weekday: "long" });
      const v = MOOD_VALUE[j.mood] || 3;
      if (!byDay[k] || v > byDay[k]) byDay[k] = v;
    });
    const best = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 4) bits.push(`You felt lightest on ${best[0]}.`);
    return bits;
  }, [journal]);

   /* local, rule-based correlations — no AI call, purely descriptive over existing data */
const patterns = useMemo(() => {
  const lines = [];
  const withMood = journal.filter((j) => j.mood);
  if (withMood.length >= 6) {
    const byDow = Array.from({ length: 7 }, () => []);
    withMood.forEach((j) => byDow[new Date(j.stamp).getDay()].push(MOOD_VALUE[j.mood] || 3));
    const avgs = byDow.map((arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null));
    const withCount = avgs.map((a, i) => ({ a, i, n: byDow[i].length })).filter((x) => x.a !== null && x.n >= 2);
    if (withCount.length >= 3) {
      const best = withCount.reduce((a, b) => (b.a > a.a ? b : a));
      const worst = withCount.reduce((a, b) => (b.a < a.a ? b : a));
      const DAYN = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
      if (best.a - worst.a >= 0.6) lines.push(`Your mood tends to run lighter on ${DAYN[best.i]}.`);
    }
  }
  const withLen = journal.filter((j) => j.text.trim());
  if (withLen.length >= 6) {
    const byDow = Array.from({ length: 7 }, () => []);
    withLen.forEach((j) => byDow[new Date(j.stamp).getDay()].push(j.text.trim().split(/\s+/).length));
    const avgs = byDow.map((arr, i) => ({ a: arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null, i, n: arr.length }))
      .filter((x) => x.a !== null && x.n >= 2);
    if (avgs.length >= 3) {
      const overall = withLen.reduce((s, j) => s + j.text.trim().split(/\s+/).length, 0) / withLen.length;
      const best = avgs.reduce((a, b) => (b.a > a.a ? b : a));
      const DAYN = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
      if (best.a >= overall * 1.4) lines.push(`You write noticeably longer entries on ${DAYN[best.i]}.`);
    }
  }
  const doneWithDates = todos.filter((t) => t.doneAt);
  if (doneWithDates.length >= 10) {
    const byDow = Array.from({ length: 7 }, () => 0);
    doneWithDates.forEach((t) => byDow[new Date(t.doneAt).getDay()]++);
    const max = Math.max(...byDow);
    const idx = byDow.indexOf(max);
    const DAYN = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
    if (max >= doneWithDates.length * 0.22) lines.push(`You complete the most intentions on ${DAYN[idx]}.`);
  }
  return lines;
}, [journal, todos]);

   /* the week just ended, distilled — facts only, omit what's absent */
  const lastWeekDigest = useMemo(() => {
    const now = new Date();
    const start = new Date(now); start.setDate(now.getDate() - now.getDay() - 7); start.setHours(0,0,0,0);
    const end = new Date(start); end.setDate(start.getDate() + 7);
    const inWeek = (ts) => ts >= start.getTime() && ts < end.getTime();
    const wkJournal = journal.filter((j) => inWeek(j.stamp));
    const done = todos.filter((t) => t.doneAt && inWeek(t.doneAt)).length;
    const active = new Set();
    todos.filter((t) => t.doneAt && inWeek(t.doneAt)).forEach((t) => active.add(dayKey(t.doneAt)));
    wkJournal.forEach((j) => active.add(dayKey(j.stamp)));
    pocket.filter((p) => inWeek(p.stamp)).forEach((p) => active.add(dayKey(p.stamp)));
    const eve = wkJournal.filter((j) => new Date(j.stamp).getHours() >= 17).length;
    const tagCounts = {};
    wkJournal.forEach((j) => (j.tags || []).forEach((t) => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
    const topTag = Object.entries(tagCounts).sort((a, b) => b[1] - a[1])[0];
    const moods = wkJournal.filter((j) => j.mood).sort((a, b) => a.stamp - b.stamp).map((j) => MOOD_VALUE[j.mood] || 3);
    let arc = null;
    if (moods.length >= 2) {
      const half = Math.floor(moods.length / 2);
      const first = moods.slice(0, half).reduce((s, v) => s + v, 0) / Math.max(1, half);
      const second = moods.slice(half).reduce((s, v) => s + v, 0) / Math.max(1, moods.length - half);
      arc = second - first > 0.5 ? "lifted through the week" : first - second > 0.5 ? "dipped toward the end" : "held fairly steady";
    }
    const bright = {};
    wkJournal.filter((j) => j.mood).forEach((j) => {
      const wd = new Date(j.stamp).toLocaleDateString("en-IN", { weekday: "long" });
      const v = MOOD_VALUE[j.mood] || 3; if (!bright[wd] || v > bright[wd]) bright[wd] = v;
    });
    const best = Object.entries(bright).sort((a, b) => b[1] - a[1])[0];
    const label = `${start.toLocaleDateString("en-IN",{day:"numeric",month:"short"})}–${new Date(end-1).toLocaleDateString("en-IN",{day:"numeric",month:"short"})}`;
    const lines = [
      `Intentions completed: ${done}.`,
      `Evenings journaled: ${eve} of ${wkJournal.length} entries.`,
      `Active days: ${active.size} of 7.`,
      topTag && topTag[1] >= 2 ? `Recurring theme: "${topTag[0]}".` : null,
      arc ? `Mood ${arc}.` : null,
      best && best[1] >= 4 ? `Lightest day: ${best[0]}.` : null,
    ].filter(Boolean);
    return { activeCount: active.size, label, text: lines.join("\n") };
  }, [todos, journal, pocket]);

  /* compose the letter once, when a new week has begun and last week earned one */
  useEffect(() => {
    if (!loaded || !companionOn || letterComposing) return;
    const pk = prevWeekKey();
    if (letters.some((l) => l.weekKey === pk)) return; // already have this week's
    if (lastWeekDigest.activeCount < 2) return;         // week didn't earn one
    (async () => {
      setLetterComposing(true);
      let text = null;
      if (supabase) {
        try {
          const payload = { weekDigest: lastWeekDigest.text };
          if (memoryOn && companionMemory) payload.memory = companionMemory;
           if (memoryOn && lifeDigest) payload.life = lifeDigest;
          const { data, error } = await supabase.functions.invoke("journal-companion", { body: payload });
          if (!error && data && data.letter) text = data.letter;
        } catch (e) { /* fall through to template */ }
      }
      if (!text) { // offline / failure fallback — plain but never absent
        text = `This week, you showed up on ${lastWeekDigest.activeCount} of seven days — and that steadiness is its own quiet kind of care. Whatever the week asked of you, you met it in your own unhurried way.\n\nBe gentle with yourself as the next one begins.`;
      }
      setLetters((prev) => [{ weekKey: pk, text, label: lastWeekDigest.label, createdAt: Date.now() }, ...prev]);
      setLetterComposing(false);
    })();
  }, [loaded, companionOn, memoryOn, companionMemory, lifeDigest, lastWeekDigest, letters, letterComposing]);

  /* monthly rollup for the Review screen's Month view */
  const reviewMonthStats = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear(); const month = now.getMonth() + reviewMonthOffset;
    const label = new Date(year, month, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
    const inMonth = (ts) => { const d = new Date(ts); return d.getFullYear() === year && d.getMonth() === month; };
    const totalDone = todos.filter((t) => t.doneAt && inMonth(t.doneAt)).length;
    const monthJournal = journal.filter((j) => inMonth(j.stamp));
    const totalJournal = monthJournal.length;
    const totalPocket = pocket.filter((p) => inMonth(p.stamp)).length;
    const activeDays = new Set();
    todos.filter((t) => t.doneAt && inMonth(t.doneAt)).forEach((t) => activeDays.add(dayKey(t.doneAt)));
    monthJournal.forEach((j) => activeDays.add(dayKey(j.stamp)));
    pocket.filter((p) => inMonth(p.stamp)).forEach((p) => activeDays.add(dayKey(p.stamp)));
    const moods = monthJournal.filter((j) => j.mood).sort((a, b) => a.stamp - b.stamp)
      .map((j) => ({ v: MOOD_VALUE[j.mood] || 3, mood: j.mood, stamp: j.stamp }));
    const tagCounts = {};
    monthJournal.forEach((j) => (j.tags || []).forEach((tag) => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; }));
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { label, totalDone, totalJournal, totalPocket, activeDayCount: activeDays.size, moods, topTags };
  }, [todos, journal, pocket, reviewMonthOffset]);

  const weekMood = useMemo(() => {
    const cutoff = Date.now() - 7 * 86400000;
    return journal.filter((j) => j.mood && j.stamp >= cutoff).sort((a, b) => a.stamp - b.stamp)
      .map((j) => ({ v: MOOD_VALUE[j.mood] || 3, mood: j.mood, stamp: j.stamp }));
  }, [journal]);

  const trail = useMemo(() => [
    ...todos.filter((t) => t.done && t.doneAt && isToday(t.doneAt)).map((t) => ({ id: "t" + t.id, stamp: t.doneAt, kind: t.cat, text: t.text })),
    ...journal.filter((j) => isToday(j.stamp)).map((j) => ({ id: "j" + j.id, stamp: j.stamp, kind: "journal", text: "Wrote in your journal" })),
    ...pocket.filter((p) => isToday(p.stamp)).map((p) => ({ id: "p" + p.id, stamp: p.stamp, kind: "pocket", text: "Kept: " + p.title })),
  ].sort((a, b) => b.stamp - a.stamp).slice(0, 6), [todos, journal, pocket]);

/* tiny wins — completed intentions + gratitude, today only, for the "look what's already true" strip */
const tinyWins = useMemo(() => {
  const tk = dayKey(Date.now());
  const doneToday = todos.filter((t) => (isRecurringItem(t)
    ? (t.doneDays || []).includes(tk)
    : (t.done && t.doneAt && isToday(t.doneAt))));
  return [
    ...doneToday.map((t) => ({ id: "w" + t.id, text: t.text, icon: "✓" })),
    ...todaysGratitude.map((g) => ({ id: "g" + g.id, text: g.text, icon: "🌾" })),
  ];
}, [todos, todaysGratitude]);
/* the garden — what today's small acts have grown, plus the all-time count */
  const garden = useMemo(() => {
    const tk = dayKey(Date.now());
    const sprouts = todos.reduce((s, t) => s + (isRecurringItem(t)
      ? ((t.doneDays || []).includes(tk) ? 1 : 0)
      : (t.done && t.doneAt && isToday(t.doneAt) ? 1 : 0)), 0);
    const flowers = journal.filter((j) => isToday(j.stamp)).length;
    const kept = pocket.filter((p) => isToday(p.stamp)).length;
    const totalEver = todos.reduce((s, t) => s + (isRecurringItem(t) ? (t.doneDays || []).length : (t.doneAt ? 1 : 0)), 0) + journal.length;
    return { sprouts, flowers, kept, totalEver };
  }, [todos, journal, pocket]);
  const pod = partOfDay();
   const season = seasonOf();
   /* the day's last logged mood gently tints the room — personal signal over clock */
  const moodKey = useMemo(() => {
    const latest = [...journal].filter((j) => j.mood && isToday(j.stamp)).sort((a, b) => b.stamp - a.stamp)[0];
    if (!latest) return "none";
    return { "🌧️": "heavy", "🌫️": "foggy", "🌿": "steady", "☀️": "light", "✨": "bright" }[latest.mood] || "none";
  }, [journal]);

  /* completion celebration — fires once, only on the transition into "all done" */
  const prevAllDoneRef = useRef(false);
  const celebrateInitRef = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    const allDone = todayTodos.length > 0 && doneCount === todayTodos.length;
    if (!celebrateInitRef.current) { celebrateInitRef.current = true; prevAllDoneRef.current = allDone; return; }
    if (allDone && !prevAllDoneRef.current) {
      setCelebrate(true); play("bloom");
      setTimeout(() => setCelebrate(false), 2700);
    }
    prevAllDoneRef.current = allDone;
  }, [doneCount, todayTodos.length, loaded, play]);

  if (!loaded) {
    return (
      <div className="sk" data-theme={theme} data-pod={pod} data-season={season}>
        <style>{CSS}</style>
        <div className="skeleton">
          <div className="skelTop">
            <div className="skelPill w60" />
            <div className="skelPill w120 round" />
          </div>
          <div className="skelHero">
            <div>
              <div className="skelLine w40" />
              <div className="skelLine w70 big" />
              <div className="skelLine w50" />
            </div>
            <div className="skelOrb" />
          </div>
          <div className="skelRows">
            <div className="skelRow" /><div className="skelRow" /><div className="skelRow" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sk" data-theme={theme} data-pod={pod} data-mood={moodKey} data-season={season}>
      <style>{CSS}</style>

      {/* ── header ── */}
      <header className="top">
        <div className="brand">
          <LeafMark />
          <span className="brandName">sukoon</span>
        </div>
        <nav className="nav" role="tablist">
          {[["today", "Today"], ["journal", "Journal"], ["review", "Review"], ["pocket", "Pocket"]].map(([k, label]) => (
            <button key={k} role="tab" aria-selected={view === k}
              className={"navPill" + (view === k ? " on" : "")}
              onClick={() => goView(k)}>
              {label}
              {k === "today" && pendingAll.length > 0 && <i className="navDot" />}
            </button>
          ))}
        </nav>
        <div className="topBtns">
           <button className="round panicBtn" data-tip="Take a quiet moment" onClick={enterPanic}>
  <svg viewBox="0 0 24 24"><path d="M12 20c-4-3-7-6.2-7-10a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 3.8-3 7-7 10-1.4 1-2.6 1-4 0Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>
</button>
          <button className={"round" + (soundOn ? " active" : "")} data-tip={soundOn ? "Sounds on" : "Sounds off"}
            onClick={() => { setSoundOn((s) => !s); if (!soundOn) SOUNDS.tap(); }} aria-pressed={soundOn}>
            <svg viewBox="0 0 24 24"><path d="M5 9v6h4l5 4V5L9 9H5z" fill="currentColor" opacity=".9"/><path d="M17.5 9.5a4 4 0 0 1 0 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" opacity={soundOn ? 1 : 0.25}/></svg>
          </button>
          <button className="round" data-tip="Switch theme" onClick={() => { setTheme((t) => (t === "dawn" ? "dusk" : "dawn")); play("tap"); }}>
            {theme === "dawn"
              ? <svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" fill="currentColor"/></svg>
              : <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.4" fill="currentColor"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>}
          </button>
          <button className="round" data-tip="Download a backup of your data" onClick={exportAllData}>
            <svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 19h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button className="round" data-tip="Merge in a backup file" onClick={() => importInputRef.current && importInputRef.current.click()}>
            <svg viewBox="0 0 24 24"><path d="M12 21V9m0 0l-4 4m4-4l4 4M5 5h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <input ref={importInputRef} type="file" accept="application/json" style={{ display: "none" }} onChange={importAllData} />
        </div>
      </header>

      <main className="page">
        <div key={fadeKey} className="viewFade">
        {/* ══════════ TODAY ══════════ */}
        {view === "today" && (
          <>
            <section className="hero">
              <div className="heroText">
                <p className="eyebrow">{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })} <span className="seasonTag">· {SEASONS[season].icon} {season}</span></p>
                <h1>{GREET[pod]}{displayName && <> <em>{displayName}</em></>}<span className="period">.</span></h1>
                <p className="sub">{SUBLINE[pod]}</p>
               <p className="affirmation"><span className="affirmationMark">✦</span>{dailyAffirmation()}</p>
                 {recall && (
  <button className="recall" onClick={() => goView("journal")} data-tip="Open your journal">
    <span className="recallMark"><LeafMark /></span>
    <span className="recallText">
      <b>{memoryLead(recall.entry, recall.tag)}</b> <em>{recallExcerpt(recall.entry.text)}</em>
    </span>
  </button>
)}
                 {energyNudge && (
  <p className="heroPromise energyNudge">
    <span className="energyNudgeMark"><LeafMark /></span>{energyNudge.text}
  </p>
)}
                {weekStats.totalDone > 0 && (
                  <p className="heroPromise">You've kept <b>{weekStats.totalDone}</b> promise{weekStats.totalDone === 1 ? "" : "s"} to yourself this week.{pendingAll.length > 0 ? ` ${pendingAll.length === 1 ? "One gentle intention remains" : `${pendingAll.length} gentle intentions remain`}.` : " The slate is clear."}</p>
                )}
                <div className="heroChips">
                  <span className="chip"><b>{pendingAll.length}</b> open intention{pendingAll.length === 1 ? "" : "s"}</span>
                  <span className="chip"><b>{streak}</b> day streak {streak > 0 ? "🌱" : ""}{frozeThisRun && streak > 0 ? " ❄️" : ""}</span>
                  <span className={"chip" + (wroteToday ? " chipDone" : "")}>{wroteToday ? "journal written ✓" : "journal awaits"}</span>
                </div>
                <div className="ribbon" aria-label="Last 7 days">
                  {weekRibbon.map((d) => (
                    <span key={d.key} className={"ribDay" + (d.active ? " ribOn" : "") + (d.today ? " ribToday" : "")} data-tip={d.label}>
                      <i />
                    </span>
                  ))}
                </div>
              </div>
              <BreathCard play={play} />
            </section>

            <FocusCard item={focusTodo} onToggle={() => toggleTodo(focusTodo.id)} onClear={() => toggleFocus(focusTodo.id)} />
            <TinyWins items={tinyWins} />

            <section className="grid">
              {/* intentions */}
              <div className="col">
                <div className="secHead">
                  <h2>Intentions</h2>
                  <div className="secHeadRight">
                    <button className="exportLink" onClick={copyAsSlack} data-tip="Copy today's completed intentions, formatted for Slack">Copy as Slack ⎘</button>
                    <button className="exportLink" onClick={exportToCalendar}>Export to calendar ↓</button>
                    {doneCount > 0 && <button className="exportLink" onClick={clearCompleted} data-tip="Remove completed, one-time intentions (or press C)">Clear completed ✓</button>}
                    <div className="sortToggle" role="radiogroup" aria-label="Sort intentions">
                      <button role="radio" aria-checked={sortMode === "manual"} className={"sortPill" + (sortMode === "manual" ? " sortOn" : "")}
                        data-tip="Drag to arrange your own order" onClick={() => { setSortMode("manual"); play("nav"); }}>⠿ Manual</button>
                      <button role="radio" aria-checked={sortMode === "time"} className={"sortPill" + (sortMode === "time" ? " sortOn" : "")}
                        data-tip="Order by time of day" onClick={() => { setSortMode("time"); play("nav"); }}>🕐 By time</button>
                    </div>
                    <div className="filters">
                      {["all", "work", "personal"].map((f) => (
                        <button key={f} className={"fPill" + (filter === f ? " fOn" : "") + " f-" + f}
                          onClick={() => { setFilter(f); play("nav"); }}>
                          {f === "all" ? "All" : f === "work" ? "Work" : "Personal"}
                        </button>
                      ))}
                    </div>
                    {activeFilterCount > 0 && (
                      <button className="activeFilterBadge" onClick={clearAllFilters} data-tip="Clear active filters">
                        {activeFilterCount} filter{activeFilterCount === 1 ? "" : "s"} active ×
                      </button>
                    )}
                  </div>
                </div>

                <div className="compose">
                  <input ref={todoInputRef} value={draft} onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { keySound(e); if (e.key === "Enter") addTodo(); }}
                    placeholder="Set a gentle intention… (press / to focus)" aria-label="New intention" />
                  {draftTags.length > 0 && (
                    <div className="draftTagRow">
                      {draftTags.map((tag) => (
                        <span key={tag} className="draftTagChip">#{tag}<button onClick={() => removeDraftTag(tag)} aria-label={`Remove tag ${tag}`}>×</button></span>
                      ))}
                    </div>
                  )}
                  <div className="catRow">
                    <button className={"cat work" + (draftCat === "work" ? " catOn" : "")} onClick={() => { setDraftCat("work"); play("nav"); }}>Work</button>
                    <button className={"cat personal" + (draftCat === "personal" ? " catOn" : "")} onClick={() => { setDraftCat("personal"); play("nav"); }}>Personal</button>
                    <button className={"cat repeat" + (draftRecur.type !== "none" ? " catOn" : "")} data-tip="Cycle repeat: none → daily → weekdays → custom"
                      onClick={cycleDraftRecur}>🔁 {recurLabel(draftRecur) || "Repeat"}</button>
                    <button className={"cat someday" + (draftBucket === "someday" ? " catOn" : "")} data-tip="Save for later, pull in when ready"
                      onClick={() => { setDraftBucket((b) => (b === "someday" ? "today" : "someday")); play("nav"); }}>🗂 Someday</button>
                     <button className={"cat energy" + (draftEnergy ? " catOn" : "")} data-tip="Cycle energy: none → 🟢 low → 🟡 medium → 🔴 high"
  onClick={cycleDraftEnergy}>
  {draftEnergy ? ENERGY[draftEnergy] : "⚪"} {draftEnergy ? draftEnergy : "Energy"}
</button>
                    <span className="tipWrap" data-tip="Optional time — enables calendar export and reminders">
                      <TimeField value={draftTime} onChange={setDraftTime} />
                    </span>
                    <input className="tagIn" value={draftTagInput} onChange={(e) => setDraftTagInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitDraftTag(); } }}
                      onBlur={() => draftTagInput.trim() && commitDraftTag()}
                      placeholder="+ tag" aria-label="Add a tag" />
                    <button className="addBtn" onClick={addTodo}>Add</button>
                  </div>
                  {draftRecur.type === "custom" && (
                    <div className="dayPickRow">
                      {DOW.map((d, i) => (
                        <button key={i} className={"dayPick" + ((draftRecur.days || []).includes(i) ? " dayPickOn" : "")}
                          onClick={() => toggleDraftDay(i)}>{d}</button>
                      ))}
                    </div>
                  )}
                </div>

                {todayTodos.length === 0 && (
                  <div className="starters">
                    <p className="startersLabel">Try one to begin</p>
                    <div className="starterRow">
                      {starters.map((s) => (
                        <button key={s.text} className={"starterChip " + s.cat} onClick={() => addStarter(s)}>
                          <span className="starterIcon">{s.icon}</span>{s.text}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                 <div className="ritualCard">
                  <p className="ritualLabel">Ritual bundles — lay a few down together</p>
                  <div className="ritualRow">
                    {RITUAL_BUNDLES.map((b) => (
                      <button key={b.id} className="ritualChip" onClick={() => addBundle(b)}
                        data-tip={b.items.map((i) => i.text).join(" · ")}>
                        <span className="ritualIcon">{b.icon}</span>
                        <span className="ritualText"><b>{b.label}</b><small>{b.blurb}</small></span>
                      </button>
                    ))}
                  </div>
                </div>

                {todayTodos.length > 0 && visible.length === 0 && (
                  <Empty msg={filter === "all" ? "Nothing in this view right now." : `No ${filter} intentions yet.`} />
                )}

                {allTags.length > 0 && (
                  <div className="tagFilterRow">
                    {allTags.map((tag) => (
                      <button key={tag} className={"tagFilterChip" + (tagFilter === tag ? " tagFilterOn" : "")}
                        onClick={() => { setTagFilter((f) => (f === tag ? null : tag)); play("nav"); }}>
                        #{tag}
                      </button>
                    ))}
                    {tagFilter && <button className="tagFilterClear" onClick={() => setTagFilter(null)}>clear ×</button>}
                  </div>
                )}

                {visible.length > 0 && (
                  <>
                    <p className="dragHint">{sortMode === "manual" ? "Drag the ⠿ handle to reorder" : "Sorted by time · switch to Manual to drag"}</p>
                    <ul className="list">
                      {sortedVisible.map((t) => {
                        const recur = getRecur(t);
                        const subs = t.subtasks || [];
                        const subDone = subs.filter((s) => s.done).length;
                        return (
                        <li key={t.id} className="rowGroup">
                        <div
                          className={"row " + t.cat + (t.done ? " done" : "") + (editingId === t.id ? " editing" : "") + (dragId === t.id ? " dragging" : "") + (dragOverId === t.id && dragId && dragId !== t.id ? " dragOver" : "")}
                          onClick={() => { if (editingId !== t.id) toggleTodo(t.id); }}
                          onDragOver={onRowDragOver(t.id)}
                          onDrop={onRowDrop(t.id)}>
                        <span className={"handle" + (sortMode !== "manual" ? " handleOff" : "")} draggable={sortMode === "manual"}
                          onDragStart={onRowDragStart(t.id)}
                          onDragEnd={onRowDragEnd}
                          onClick={(e) => e.stopPropagation()}
                          data-tip={sortMode === "manual" ? "Drag to reorder" : "Switch to Manual sort to drag"} aria-label="Drag to reorder">⠿</span>
                        <button className="tick" onClick={(e) => { e.stopPropagation(); toggleTodo(t.id); }} aria-label={t.done ? "Mark as not done" : "Mark as done"}>
                          <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </button>
                        {editingId === t.id ? (
                          <input
                            className="rowEdit"
                            autoFocus
                            value={editText}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyDown={(e) => { keySound(e); if (e.key === "Enter") commitEdit(t.id); if (e.key === "Escape") setEditingId(null); }}
                            onBlur={() => commitEdit(t.id)}
                          />
                        ) : (
                          <span className="rowText" onClick={(e) => { e.stopPropagation(); startEdit(t); }} data-tip="Click to edit">
                            {isRecurringItem(t) && <i className="recurMark" data-tip={recurLabel(recur)}><Icon name="repeat" /></i>}
                            {t.text}
                          </span>
                        )}
                        {(t.tags || []).map((tag) => (
                          <span key={tag} className="rowTag" onClick={(e) => e.stopPropagation()}>
                            #{tag}<button onClick={() => removeTodoTag(t.id, tag)} aria-label={`Remove tag ${tag}`}>×</button>
                          </span>
                        ))}
                        {taggingId === t.id && (
                          <input className="rowTagInput" autoFocus value={tagInput}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setTagInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") commitRowTag(t.id); if (e.key === "Escape") { setTaggingId(null); setTagInput(""); } }}
                            onBlur={() => (tagInput.trim() ? commitRowTag(t.id) : setTaggingId(null))}
                            placeholder="tag…" aria-label="Add a tag" />
                        )}
                        {subs.length > 0 && (
                          <button className={"stepsBadge" + (subDone === subs.length ? " stepsDone" : "")} data-tip="Steps"
                            onClick={(e) => { e.stopPropagation(); setSubOpenId((cur) => (cur === t.id ? null : t.id)); }}>
                            {subDone}/{subs.length} steps
                          </button>
                        )}
                        {t.time && <span className="timeBadge">{t.time}</span>}
                           {t.energy && (
  <button className="rowIcon energyBadge" data-tip={`Energy: ${t.energy} — click to cycle`}
    onClick={(e) => { e.stopPropagation(); cycleRowEnergy(t.id); }}>
    {ENERGY[t.energy]}
  </button>
)}
                        <span className={"tag " + t.cat}>{t.cat}</span>
                        <div className="rowActions">
                        {taggingId !== t.id && (
                          <button className="rowIcon" data-tip="Add a tag"
                            onClick={(e) => { e.stopPropagation(); setTaggingId(t.id); setTagInput(""); }}>#+</button>
                        )}
                        {isRecurringItem(t) ? (
                          <button className="rowIcon recurBadge" data-tip="Change how often this repeats"
                            onClick={(e) => { e.stopPropagation(); cycleRowRecur(t.id); }}><Icon name="repeat" /> {recurLabel(recur)}</button>
                        ) : (
                          <button className="rowIcon" data-tip="Make this repeat"
                            onClick={(e) => { e.stopPropagation(); cycleRowRecur(t.id); }}><Icon name="repeat" /></button>
                        )}
                        <button className="rowIcon" data-tip={subs.length ? "Add or edit steps" : "Break into a few steps"}
                          onClick={(e) => { e.stopPropagation(); setSubOpenId((cur) => (cur === t.id ? null : t.id)); }}><Icon name="steps" /></button>
                        <button className="rowIcon" data-tip="Add to Google Calendar"
                          onClick={(e) => { e.stopPropagation(); window.open(gcalLink(t.text, t.time), "_blank"); }}><Icon name="calendar" /></button>
                        {t.time && (
                          <button className={"rowIcon" + (t.reminderOn ? " reminderOn" : "")}
                            data-tip={t.reminderOn ? "Reminder on — click to turn off" : "Set a gentle reminder"}
                            onClick={(e) => { e.stopPropagation(); toggleReminder(t.id); }}><Icon name="bell" /></button>
                        )}
                           
                        <button className={"rowIcon" + (t.isFocus ? " focusOn" : "")}
                          data-tip={t.isFocus ? "Remove as today's one thing" : "Make this today's one thing"}
                          onClick={(e) => { e.stopPropagation(); toggleFocus(t.id); }} aria-label="Toggle today's focus"><Icon name="star" /></button>
                        <button className="rowIcon" data-tip="Save for someday instead"
                          onClick={(e) => { e.stopPropagation(); sendToSomeday(t.id); }} aria-label="Move to someday"><Icon name="bookmark" /></button>
                        <button className="rowIcon" data-tip="Duplicate — same thing, next time"
                          onClick={(e) => { e.stopPropagation(); duplicateTodo(t.id); }} aria-label="Duplicate intention"><Icon name="copy" /></button>
                        <button className="x" onClick={(e) => { e.stopPropagation(); removeTodo(t.id); }} aria-label="Remove">×</button>
                        </div>
                        </div>

                        {recurEditId === t.id && (
                          <div className="recurEditRow">
                            <span className="recurEditLabel">Repeats on:</span>
                            {DOW.map((d, i) => (
                              <button key={i} className={"dayPick" + ((recur.days || []).includes(i) ? " dayPickOn" : "")}
                                onClick={() => toggleRowDay(t.id, i)}>{d}</button>
                            ))}
                            <button className="recurEditClear" onClick={() => clearRowRecur(t.id)}>Remove repeat</button>
                            <button className="recurEditDone" onClick={() => setRecurEditId(null)}>Done</button>
                          </div>
                        )}

                        {subOpenId === t.id && (
  <div className="subPanel">
    <div className="subPanelHead">
      <span className="subPanelLabel">Steps</span>
      <button className="subPanelClose" onClick={() => setSubOpenId(null)} aria-label="Close steps">×</button>
    </div>
    {subs.length > 0 && (
  <ul className="subList">
    {subs.map((s) => (
      <li key={s.id} className={"subRow" + (s.done ? " subDone" : "")}>
        <button className="subTick" onClick={() => toggleSubtask(t.id, s.id)} aria-label={s.done ? "Mark step not done" : "Mark step done"}>
          <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <span className="subText">{s.text}</span>
        <button className="x" onClick={() => removeSubtask(t.id, s.id)} aria-label="Remove step">×</button>
      </li>
    ))}
  </ul>
)}
   <div className="subAddRow">
      <input value={subDraft} onChange={(e) => setSubDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") addSubtask(t.id); if (e.key === "Escape") setSubOpenId(null); }}
        placeholder="Add a step…" aria-label="Add a step" />
      <button className="subAddBtn" onClick={() => addSubtask(t.id)}>Add</button>
    </div>
  </div>
)}
                        </li>
                        );
                      })}
                    </ul>
                  </>
                )}

                {somedayTodos.length > 0 && (
                  <div className="somedayCard">
                    <button className="somedayHead" onClick={() => { setSomedayOpen((o) => !o); play("nav"); }}>
                      <span><Icon name="bookmark" /> Someday <b>{somedayTodos.length}</b></span>
                      <span className={"somedayChevron" + (somedayOpen ? " somedayOpenChevron" : "")}>›</span>
                    </button>
                    {somedayOpen && (
                      <ul className="somedayList">
                        {somedayTodos.map((s) => (
                          <li key={s.id} className="somedayRow">
                            <span className={"tag " + s.cat} />
                            <span className="somedayText">{s.text}</span>
                            <button className="somedayPull" onClick={() => pullToToday(s.id)}>→ Today</button>
                            <button className="x" onClick={() => removeTodo(s.id)} aria-label="Remove">×</button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              {/* day panel */}
              <div className="col side">
                <div className="dayCard">
                  <Arc pct={pct} />
                  <div className="dayText">
                    {(moodKey === "heavy" || moodKey === "foggy") && pendingAll.length > 0 ? (
                      <>
                        <strong>Today felt heavier than usual.</strong>
                        <span>No need to clear the list. Choose just one thing that still matters — the rest can wait.</span>
                      </>
                    ) : (
                      <>
                        <strong>{doneCount} of {todayTodos.length || 0} complete</strong>
                        <span>{pct === 100 && todayTodos.length ? "The day is full. Well walked." : pct >= 60 ? "Softly, steadily — nearly there." : pct > 0 ? "One small step at a time." : "The page is still fresh."}</span>
                      </>
                    )}
                  </div>
                </div>
                 <GardenCard sprouts={garden.sprouts} flowers={garden.flowers} kept={garden.kept}
                  totalEver={garden.totalEver} streak={streak} pod={pod} />

                <MonthCard offset={monthOffset} setOffset={setMonthOffset} meta={dayMeta} play={play} />

                 <div className="thoughtCard">
  <p className="thoughtLabel">Got something rattling around?</p>
  <div className="thoughtRow">
    <input value={thoughtDraft} onChange={(e) => setThoughtDraft(e.target.value)}
      onKeyDown={(e) => { keySound(e); if (e.key === "Enter") saveThought(); }}
      placeholder="Just set it down, no need to sort it…" aria-label="Park a stray thought" />
    {thoughtDraft.trim() && <button className="thoughtSave" onClick={saveThought}>Park it</button>}
  </div>
</div>

                <div className="trailCard">
                  <h3>Today's moments</h3>
                  {trail.length === 0 ? (
                    <p className="trailEmpty">Moments you complete or keep will gather here, like footprints.</p>
                  ) : (
                    <ul className="trail">
                      {trail.map((it) => (
                        <li key={it.id} className={"tr " + it.kind}>
                          <i className="trDot" />
                          <span className="trText">{it.text.slice(0, 52)}{it.text.length > 52 ? "…" : ""}</span>
                          <span className="trTime">{fmtTime(it.stamp)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                 <div className="ambientCard">
                  <div className="ambientHead">
                    <h3>Ambience</h3>
                    {ambient && <button className="ambientStop" onClick={() => toggleAmbient(ambient)}>Stop</button>}
                  </div>
                  <div className="ambientRow">
                    {Object.entries(AMBIENCES).map(([k, a]) => (
                      <button key={k} className={"ambientChip" + (ambient === k ? " ambientOn" : "")}
                        onClick={() => toggleAmbient(k)} aria-pressed={ambient === k} title={`Play ${a.label}`}>
                        <span className="ambientIcon">{a.icon}</span>{a.label}
                        {ambient === k && <i className="ambientWave" />}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="noteCard">
                  <p>Small steps, taken gently, still arrive.</p>
                </div>
              </div>
            </section>
          </>
        )}

        {/* ══════════ JOURNAL ══════════ */}
        {view === "journal" && (
          <section className="narrow">
            <div className="jHero">
              <p className="eyebrow">{journalPrompt.gentle ? "A gentler prompt today" : "Today's prompt"}</p>
              <h1 className="prompt"><em>{journalPrompt.text}</em></h1>
              <div className="jHeroActions">
                {journal.length > 0 && <button className="exportLink" onClick={exportJournal}>Export journal ↓</button>}
                <button className="exportLink" onClick={() => { setCompanionOn((v) => !v); play("tap"); }} data-tip="Some evenings you write to be alone with a thought. Turn reflections off any time.">
                  {companionOn ? "reflections on" : "reflections off"}
                </button>
                {companionOn && (
                  <button className={"exportLink" + (memoryOn ? " memoryPillOn" : "")}
                    onClick={() => { setMemoryOn((v) => !v); play("tap"); }}
                    data-tip="When on, Sukoon holds a soft memory of your days, so reflections can notice gently across time. Off by default.">
                    {memoryOn ? "memory on" : "memory off"}
                  </button>
                )}
              </div>
            </div>

            {companionOn && memoryOn && (companionMemory || lifeDigest) && (
              <div className="memoryCard">
                <button className="memoryReveal" onClick={() => { setMemoryRevealed((v) => !v); play("nav"); }}>
                  <span>🌿 Sukoon holds a soft memory of your days</span>
                  <span className={"memoryChevron" + (memoryRevealed ? " memoryChevronOpen" : "")}>›</span>
                </button>
                {memoryRevealed && (
                  <div className="memoryBody">
                    {companionMemory && <p className="memoryText">{companionMemory}</p>}
                     {lifeDigest && (
  <details className="memoryFacts">
    <summary>and the plain facts it draws on</summary>
    <pre className="memoryFactsText">{lifeDigest}</pre>
  </details>
)}
                    <button className="memoryForget" onClick={() => { setCompanionMemory(""); setMemoryRevealed(false); play("delete"); flash("Gently forgotten"); }}>
                      forget everything
                    </button>
                  </div>
                )}
              </div>
            )}

             <div className="gratitudeCard">
              <p className="gratitudeLabel">Today I'm grateful for</p>
              <div className="gratitudeSlots">
                {todaysGratitude.map((g) => (
                  <span key={g.id} className="gratChip"><span>🌾 {g.text}</span>
                    <button onClick={() => removeGratitude(g.id)} aria-label="Remove">×</button></span>
                ))}
                {Array.from({ length: Math.max(0, 3 - todaysGratitude.length) }).map((_, i) => (
                  <input key={"g" + i} className="gratInput" value={gratDraft[i] || ""}
                    onChange={(e) => setGratDraftAt(i, e.target.value)}
                    onKeyDown={(e) => { keySound(e); if (e.key === "Enter") commitGratitude(i); }}
                    onBlur={() => (gratDraft[i] || "").trim() && commitGratitude(i)}
                    placeholder={["something small…", "someone…", "a moment…"][todaysGratitude.length + i] || "something…"}
                    aria-label="Something you're grateful for" />
                ))}
              </div>
            </div>

            {onThisDay && (
  <div className="onThisDay">
    <p className="onThisDayLead">
      <span className="onThisDayMark"><LeafMark /></span>
      {memoryLead(onThisDay.entry, onThisDay.tag)}
    </p>
    <p className="onThisDayText">{onThisDay.entry.mood ? onThisDay.entry.mood + " " : ""}{onThisDay.entry.text.slice(0, 180)}{onThisDay.entry.text.length > 180 ? "…" : ""}</p>
    <p className="onThisDayDate">{fmtDay(onThisDay.entry.stamp)}, {new Date(onThisDay.entry.stamp).getFullYear()}</p>
  </div>
)}

            <div className="jCompose">
              <div className="moodRow">
                {MOODS.map(([e, label]) => (
                  <button key={label} className={"mood" + (entryMood === e ? " moodOn" : "")}
                    data-tip={label} onClick={() => { setEntryMood(entryMood === e ? null : e); play("tap"); }}>
                    <span>{e}</span><small>{label}</small>
                  </button>
                ))}
              </div>
              <textarea ref={journalTextRef} rows={6} value={entryText} onChange={(e) => setEntryText(e.target.value)} onKeyDown={keySound}
                placeholder="Write it down, and set it down… (press / to focus)" aria-label="Journal entry" />
              {entryTags.length > 0 && (
                <div className="draftTagRow">
                  {entryTags.map((tag) => (
                    <span key={tag} className="draftTagChip">#{tag}<button onClick={() => removeEntryTag(tag)} aria-label={`Remove tag ${tag}`}>×</button></span>
                  ))}
                </div>
              )}
              <div className="jFoot">
                <span className="soft">{entryText.trim() ? entryText.trim().split(/\s+/).length + " words" : "no rush"}</span>
                <input className="tagIn jTagIn" value={entryTagInput} onChange={(e) => setEntryTagInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commitEntryTag(); } }}
                  onBlur={() => entryTagInput.trim() && commitEntryTag()}
                  placeholder="+ tag a theme" aria-label="Add a tag" />
                <button className="primary" onClick={saveEntry}>Keep this entry</button>
              </div>
            </div>

            {(moodTrend.length >= 2 || lengthTrend.length >= 2) && (
              <div className="trendPair">
                {moodTrend.length >= 2 && <MoodTrend points={moodTrend} />}
                {lengthTrend.length >= 2 && <LengthTrend points={lengthTrend} />}
              </div>
            )}

            {journal.length > 0 && (
              <div className="jSearch">
                <svg className="jSearchIcon" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M20 20l-4.35-4.35" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
               <input value={journalQuery} onChange={(e) => setJournalQuery(e.target.value)}
                  placeholder="Search your journal… try a mood, like “heavy”" aria-label="Search journal entries" />
                {journalQuery && <button className="jSearchClear" onClick={() => setJournalQuery("")} aria-label="Clear search">×</button>}
              </div>
            )}

            {allJournalTags.length > 0 && (
              <div className="tagFilterRow">
                {allJournalTags.map((tag) => (
                  <button key={tag} className={"tagFilterChip" + (journalTagFilter === tag ? " tagFilterOn" : "")}
                    onClick={() => { setJournalTagFilter((f) => (f === tag ? null : tag)); play("nav"); }}>
                    #{tag}
                  </button>
                ))}
                {journalTagFilter && <button className="tagFilterClear" onClick={() => setJournalTagFilter(null)}>clear ×</button>}
              </div>
            )}

            {journal.length === 0 ? (
              <Empty msg="A quiet page, waiting for its first line." />
            ) : filteredJournal.length === 0 ? (
              <Empty msg={journalQuery ? `Nothing found for "${journalQuery}".` : "No entries with this theme yet."} />
            ) : (
              <ul className="jList">
                {filteredJournal.map((j) => (
                  <li key={j.id} className="jEntry">
                    <div className="jMeta">
                      <span className="jMood">{j.mood || "·"}</span>
                      <span className="jDate">{fmtDay(j.stamp)} · {fmtTime(j.stamp)}</span>
                      <button className="miniEdit" onClick={() => exportEntry(j)} data-tip="Export just this entry">export</button>
                      {editingJournalId !== j.id && <button className="miniEdit" onClick={() => startEditEntry(j)}>edit</button>}
                      <button className="x" onClick={() => removeEntry(j.id)} aria-label="Delete entry">×</button>
                    </div>
                    {j.prompt && <p className="jPrompt">{j.prompt}</p>}
                    {editingJournalId === j.id ? (
                      <div className="jEditWrap">
                        <textarea className="jEditArea" autoFocus rows={4} value={editJournalText}
                          onChange={(e) => setEditJournalText(e.target.value)} onKeyDown={keySound} />
                        <div className="jEditBtns">
                          <button className="miniCancel" onClick={() => setEditingJournalId(null)}>Cancel</button>
                          <button className="miniSave" onClick={() => commitEditEntry(j.id)}>Save</button>
                        </div>
                      </div>
                    ) : (
                      <p className="jBody">{j.text}</p>
                    )}
                    {(j.tags || []).length > 0 && (
                      <div className="jTagRow">
                        {j.tags.map((tag) => <span key={tag} className="jTagChip">#{tag}</span>)}
                      </div>
                    )}
                    {j.companion ? (
                      <div className={"companionLine" + (j.companionDistress ? " companionCare" : "")}>
                        {!j.companionDistress && <span className="companionMark"><LeafMark /></span>}
                        <p>{j.companion}</p>
                      </div>
                    ) : companionOn && editingJournalId !== j.id ? (
                      <button className="reflectBtn" onClick={() => reflectOnEntry(j)} disabled={reflectingId === j.id}>
                        {reflectingId === j.id ? "reflecting…" : "reflect with me"}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* ══════════ REVIEW ══════════ */}
        {view === "review" && (
          <section className="narrow">
            {companionOn && letters.length > 0 && (
              <>
                <div className="letterCard">
                  <p className="letterEyebrow">A letter for your week · {letters[0].label || lastWeekDigest.label}</p>
                  {letters[0].text.split("\n").filter(Boolean).map((para, i) => (
                    <p key={i} className="letterBody">{para}</p>
                  ))}
                  <span className="letterSeal"><LeafMark /></span>
                </div>
                {letters.length > 1 && (
                  <div className="archiveCard">
                    <button className="archiveHead" onClick={() => { setArchiveOpen((o) => !o); play("nav"); }}>
                      <span>🌿 Past letters <b>{letters.length - 1}</b></span>
                      <span className={"archiveChevron" + (archiveOpen ? " archiveChevronOpen" : "")}>›</span>
                    </button>
                    {archiveOpen && (
                      <div className="archiveList">
                        {letters.slice(1).map((l) => (
                          <div key={l.weekKey} className="archiveItem">
                            <p className="archiveItemLabel">{l.label || "an earlier week"}</p>
                            {l.text.split("\n").filter(Boolean).map((para, i) => (
                              <p key={i} className="archiveItemBody">{para}</p>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            <div className="jHero">
              <p className="eyebrow">{reviewRange === "week" ? "This week" : reviewMonthStats.label}</p>
              <h1 className="prompt">A quiet <em>look back</em>.</h1>
              <div className="rangeToggle" role="radiogroup" aria-label="Review range">
                <button role="radio" aria-checked={reviewRange === "week"} className={"rangePill" + (reviewRange === "week" ? " rangeOn" : "")}
                  onClick={() => { setReviewRange("week"); play("nav"); }}>Week</button>
                <button role="radio" aria-checked={reviewRange === "month"} className={"rangePill" + (reviewRange === "month" ? " rangeOn" : "")}
                  onClick={() => { setReviewRange("month"); play("nav"); }}>Month</button>
              </div>
            </div>

            {reviewRange === "week" ? (
              <>
                <div className="reviewChips">
                  <span className="chip"><b>{weekStats.totalDone}</b> intention{weekStats.totalDone === 1 ? "" : "s"} completed</span>
                  <span className="chip"><b>{weekStats.totalJournal}</b> journal entr{weekStats.totalJournal === 1 ? "y" : "ies"}</span>
                  <span className="chip"><b>{streak}</b> day streak {streak > 0 ? "🌱" : ""}</span>
                </div>

                 {(weekStory.length > 0 || patterns.length > 0) && (
  <div className="weekStory">
    {weekStory.map((line, i) => <p key={i} className="weekStoryLine">{line}</p>)}
    {patterns.map((line, i) => <p key={"p" + i} className="weekStoryLine">{line}</p>)}
    <p className="weekStoryClose">Keep protecting your peace.</p>
  </div>
)}
                <div className="reviewCard">
                  <h3>Days, at a glance</h3>
                  <div className="weekBars">
                    {weekStats.days.map((d) => (
                      <div key={d.key} className={"weekBarCol" + (d.today ? " weekToday" : "")}>
                        <div className="weekBarTrack">
                          <div className="weekBarFill" style={{ height: (d.doneCt / weekStats.maxDone) * 100 + "%" }} />
                        </div>
                        <span className="weekBarCount">{d.doneCt || ""}</span>
                        <span className="weekBarLabel">{d.label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {weekMood.length >= 2 ? (
                  <div className="reviewCard">
                    <MoodTrend points={weekMood} />
                  </div>
                ) : (
                  <Empty msg="Give yourself a few quiet days — we'll reflect together when there's more to look back on." />
                )}

                <div className="noteCard">
                  <p>{weekStats.totalDone === 0 ? "A quiet week. That's alright too." : weekStats.totalDone >= 14 ? "A full week, gently carried." : "Steady, unhurried progress."}</p>
                </div>
              </>
            ) : (
              <>
                <div className="reviewChips">
                  <span className="chip"><b>{reviewMonthStats.totalDone}</b> intention{reviewMonthStats.totalDone === 1 ? "" : "s"} completed</span>
                  <span className="chip"><b>{reviewMonthStats.totalJournal}</b> journal entr{reviewMonthStats.totalJournal === 1 ? "y" : "ies"}</span>
                  <span className="chip"><b>{reviewMonthStats.activeDayCount}</b> active day{reviewMonthStats.activeDayCount === 1 ? "" : "s"}</span>
                  {reviewMonthStats.totalPocket > 0 && <span className="chip"><b>{reviewMonthStats.totalPocket}</b> kept in pocket</span>}
                </div>

                <div className="reviewCard">
                  <div className="monthHead">
                    <h3>{reviewMonthStats.label}</h3>
                    <div className="monthNav">
                      <button onClick={() => { setReviewMonthOffset((o) => o - 1); play("nav"); }} aria-label="Previous month">‹</button>
                      <button onClick={() => { setReviewMonthOffset((o) => Math.min(0, o + 1)); play("nav"); }} aria-label="Next month" disabled={reviewMonthOffset === 0}>›</button>
                    </div>
                  </div>
                  <MonthCard offset={reviewMonthOffset} setOffset={setReviewMonthOffset} meta={dayMeta} play={play} bare />
                </div>

                {reviewMonthStats.topTags.length > 0 && (
                  <div className="reviewCard">
                    <h3>Themes this month</h3>
                    <div className="themeRow">
                      {reviewMonthStats.topTags.map(([tag, n]) => (
                        <span key={tag} className="themeChip">#{tag} <b>{n}</b></span>
                      ))}
                    </div>
                  </div>
                )}

                {reviewMonthStats.moods.length >= 2 ? (
                  <div className="reviewCard">
                    <MoodTrend points={reviewMonthStats.moods} />
                  </div>
                ) : (
                  <Empty msg="A few more gentle days, and a shape will begin to show here." />
                )}

                <div className="noteCard">
                  <p>{reviewMonthStats.totalDone === 0 ? "A quiet month. That's alright too." : reviewMonthStats.activeDayCount >= 20 ? "A month, gently and steadily carried." : "Small moments, adding up quietly."}</p>
                </div>
              </>
            )}
          </section>
        )}

        {/* ══════════ POCKET ══════════ */}
        {view === "pocket" && (
          <section className="narrow">
            <div className="jHero">
              <p className="eyebrow">Pocket</p>
              <h1 className="prompt">Things worth <em>keeping</em>.</h1>
            </div>

            <div className="compose pocketCompose">
              <input ref={pocketInputRef} value={pTitle} onChange={(e) => setPTitle(e.target.value)}
                onKeyDown={(e) => { keySound(e); if (e.key === "Enter") savePocket(); }}
                placeholder="A quote, an idea, a little treasure… (press / to focus)" aria-label="Pocket item" />
              <div className="catRow">
                <input className="linkIn" value={pLink} onChange={(e) => setPLink(e.target.value)}
                  onKeyDown={(e) => { keySound(e); if (e.key === "Enter") savePocket(); }}
                  placeholder="link (optional)" aria-label="Optional link" />
                <button className="addBtn" onClick={savePocket}>Keep</button>
              </div>
            </div>

            {pocket.length === 0 ? <Empty msg="Your pocket is empty — tuck something lovely in." /> : (
              <div className="pGrid">
                {pocket.map((p, i) => (
                  <div key={p.id} className={"pCard v" + (i % 4)}>
                    <button className="x pX" onClick={() => removePocket(p.id)} aria-label="Remove">×</button>
                    <p className="pTitle">{p.title}</p>
                     {p.type === "thought" && <span className="pThoughtTag">✎ a stray thought</span>}
                    {p.link && p.type !== "thought" && (
                      <a className="pLink" href={p.link.startsWith("http") ? p.link : "https://" + p.link} target="_blank" rel="noreferrer">
                        {p.link.replace(/^https?:\/\//, "").slice(0, 32)}{p.link.length > 40 ? "…" : ""} ↗
                      </a>
                    )}
                    <span className="pDate">{fmtDay(p.stamp)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        </div>

        <footer className="foot">everything is saved as you go · sukoon means calm · press 1 2 3 4 to switch, / to write, c to clear completed</footer>
      </main>

      {toast && (
        <div className="toast">
          <span>{toast.msg}</span>
          {toast.undo && <button className="toastUndo" onClick={performUndo}>Undo</button>}
        </div>
      )}

      {celebrate && (
        <div className="celebrate" role="status" aria-live="polite">
          <div className="celebrateWash" />
          <div className="petals">
            {Array.from({ length: 14 }).map((_, i) => (
              <span key={i} className="petal" style={{ left: (i * 7.1) % 100 + "%", animationDelay: (i * 0.16) + "s", animationDuration: (3.2 + (i % 5) * 0.4) + "s" }} />
            ))}
          </div>
          <p className="celebrateText">The day is complete.</p>
        </div>
      )}
       {panicMode && (
  <div className="panicOverlay" role="dialog" aria-modal="true" aria-label="A quiet moment">
    <div className="panicBg" onClick={exitPanic} />
    <div className="panicContent">
      <p className="panicLine">Nothing else needs you right now. Just breathe.</p>
      <BreathCard play={play} />
      <button className="panicExit" onClick={exitPanic}>I'm ready</button>
    </div>
  </div>
)}
    </div>
  );
}

/* ═══ breathing card — the signature ═══ */
function BreathCard({ play }) {
  const [running, setRunning] = useState(false);
  const [closing, setClosing] = useState(false);
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [breaths, setBreaths] = useState(0);
  const [patternKey, setPatternKey] = useState("calm");
  const timerRef = useRef(null);
  const runningRef = useRef(false);
  const patternRef = useRef(patternKey);
  const stopBtnRef = useRef(null);

  const requestStop = useCallback(() => {
    runningRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    setClosing(true);
    setTimeout(() => { setClosing(false); setRunning(false); setPhaseIdx(0); }, 1650);
  }, []);

  const advance = useCallback((i) => {
    if (!runningRef.current) return;
    const steps = PATTERNS[patternRef.current].steps;
    setPhaseIdx(i);
    if (i % steps.length === 0 && i > 0) setBreaths((b) => b + 1);
    play(steps[i % steps.length].sound);
    timerRef.current = setTimeout(() => advance(i + 1), steps[i % steps.length].secs * 1000);
  }, [play]);

  const start = () => {
    patternRef.current = patternKey;
    runningRef.current = true; setRunning(true); setBreaths(0); setClosing(false);
    advance(0);
  };
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const active = running || closing;

  /* escape to stop, focus the stop control while the overlay is open */
  useEffect(() => {
    if (!active) return;
    const onKey = (e) => { if (e.key === "Escape" && !closing) requestStop(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, closing, requestStop]);
  useEffect(() => { if (running && !closing && stopBtnRef.current) stopBtnRef.current.focus(); }, [running, closing]);

  const steps = PATTERNS[patternKey].steps;
  const step = phaseIdx % steps.length;
  const cur = steps[step];

  return (
    <div className="breath">
      {!running && (
        <div className="patternRow" role="radiogroup" aria-label="Breathing pattern">
          {Object.entries(PATTERNS).map(([k, p]) => (
            <button key={k} className={"patternPill" + (patternKey === k ? " patOn" : "")}
              onClick={() => { setPatternKey(k); play("tap"); }} aria-checked={patternKey === k} role="radio">
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="orbStage" onClick={running ? requestStop : start} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); running ? requestStop() : start(); } }}
        aria-label={running ? "Stop breathing exercise" : "Start breathing exercise"}>
        <OrbVisual step={step} running={running} cur={cur} phaseIdx={phaseIdx} breaths={breaths} patternLabel={PATTERNS[patternKey].label} compact />
      </div>

      {active && (
        <div className="breathOverlay" role="dialog" aria-modal="true" aria-label="Breathing exercise">
          <div className="breathOverlayBg" onClick={!closing ? requestStop : undefined} />
          <div className="breathOverlayContent">
            {closing ? (
              <div className="breathClose">
                <span className="closeMark">✓</span>
                <p className="closeTitle">Well done</p>
                <p className="closeSub">{breaths} breath{breaths === 1 ? "" : "s"}, gently taken</p>
              </div>
            ) : (
              <>
                <div className="orbStageBig">
                  <OrbVisual step={step} running={running} cur={cur} phaseIdx={phaseIdx} breaths={breaths} />
                </div>
                <button ref={stopBtnRef} className="breathStop" onClick={requestStop}>I'm done</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function OrbVisual({ step, running, cur, phaseIdx, breaths, compact, patternLabel }) {
  const r = compact ? 54 : 66;
  const circ = 2 * Math.PI * r;
  return (
    <>
      <div className="orbHalo" />
      <div className="orb" style={{ transform: `scale(${cur.big ? SCALE_BIG : SCALE_SMALL})`, transitionDuration: running ? cur.secs + "s" : "1s" }} />
      {running && (
        <svg className="ring" viewBox={`0 0 ${r * 2 + 20} ${r * 2 + 20}`} key={phaseIdx}>
          <circle className="ringBg" cx={r + 10} cy={r + 10} r={r} />
          <circle className="ringFg" cx={r + 10} cy={r + 10} r={r}
            style={{ strokeDasharray: circ, "--circ": circ + "px", animationDuration: cur.secs + "s" }} />
        </svg>
      )}
      <div className="orbCore">
        {running ? (
          <><span className="orbPhase">{cur.phase}</span><span className="orbCount">{breaths} breath{breaths === 1 ? "" : "s"}</span></>
        ) : (
          <><span className="orbPhase">Take a breath</span><span className="orbCount">tap to begin · {patternLabel}</span></>
        )}
      </div>
    </>
  );
}

/* ═══ the garden — a small living scene that grows with the day (Finch-style loop) ═══ */
function GardenCard({ sprouts, flowers, kept, totalEver, streak, pod }) {
  const S = Math.min(6, sprouts);
  const F = Math.min(3, flowers);
  const sproutX = [24, 46, 68, 90, 112, 134];
  const flowerX = [158, 180, 202];
  const isNight = pod === "night" || pod === "evening";
  const grown = S + F + Math.min(2, kept);
   const maturity = totalEver >= 160 ? 4 : totalEver >= 71 ? 3 : totalEver >= 25 ? 2 : totalEver >= 8 ? 1 : 0;
  const MATURITY_NAME = ["a bare bed", "a first seedling", "a young sapling", "a growing tree", "a flourishing garden"][maturity];
  const trunkTop = [102, 90, 74, 56, 40][maturity];
  const canopyR = [0, 5, 10, 15, 20][maturity];
  const tuftCount = [2, 5, 8, 11, 15][maturity];
  const tufts = Array.from({ length: tuftCount }).map((_, i) => 12 + (i * 202) / Math.max(1, tuftCount - 1) + (i % 2 ? 3 : -3));
  const wilds = maturity >= 4 ? [40, 96, 150, 190] : maturity >= 3 ? [70, 176] : [];

  let caption;
  if (grown === 0) caption = "Your garden is resting. One small thing will wake it.";
  else if (F > 0 && S > 0) caption = "Sprouting and blooming — a good day for it.";
  else if (F > 0) caption = `${F} flower${F === 1 ? "" : "s"} from today's writing.`;
  else caption = `${S} sprout${S === 1 ? "" : "s"} today. It's coming alive.`;
  if (streak >= 7 && grown > 0) caption += " The season has turned lush.";

  const stem = (x, topY) => `M${x} 108 C ${x} 98 ${x} 92 ${x} ${topY}`;
  return (
    <div className="gardenCard">
      <div className="gardenHead">
        <h3>Your garden</h3>
        <span className="gardenTotal">🌱 {totalEver} tended · {MATURITY_NAME}</span>
      </div>
      <div className="gardenScene">
        <svg viewBox="0 0 226 122" className="gardenSvg" aria-label="A small garden that grows as you tend to your day">
          <defs>
            <linearGradient id="gSky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--orb2)" stopOpacity="0.45" />
              <stop offset="1" stopColor="var(--surface)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="226" height="122" rx="12" fill="url(#gSky)" />
          <circle cx="198" cy="26" r="12" fill={isNight ? "var(--lilac)" : "var(--pollen)"} opacity="0.85" />
           <g className="gcloud" opacity="0.5">
            <ellipse cx="54" cy="24" rx="15" ry="7" fill="var(--surface)" />
            <ellipse cx="66" cy="21" rx="11" ry="6" fill="var(--surface)" />
          </g>
          {isNight && <circle cx="193" cy="23" r="12" fill="var(--surface)" opacity="0.7" />}
          <path d="M0 96 Q 56 82 118 92 T 226 88 L226 122 L0 122 Z" fill="var(--moss-soft)" />
          <path d="M0 104 Q 60 96 120 102 T 226 100 L226 122 L0 122 Z" fill="var(--moss)" opacity="0.28" />
           {tufts.map((x, i) => (
            <path key={"tuft" + i} d={`M${x} 106 q -2 -6 -3 -9 M${x} 106 q 0 -7 0 -10 M${x} 106 q 2 -6 3 -9`}
              stroke="var(--moss)" strokeWidth="1.2" fill="none" strokeLinecap="round" opacity="0.5" />
          ))}
          {maturity === 0 ? (
            <g><ellipse cx="113" cy="104" rx="10" ry="3" fill="var(--moss-soft)" /><circle cx="113" cy="101" r="2" fill="var(--moss-deep)" opacity="0.6" /></g>
          ) : (
            <g className="gtree">
              <path d={`M113 104 L113 ${trunkTop + canopyR - 2}`} stroke="var(--moss-deep)" strokeWidth={maturity >= 3 ? 3 : 2} strokeLinecap="round" />
              <circle cx="113" cy={trunkTop} r={canopyR} fill="var(--moss)" opacity="0.9" />
              <circle cx={113 - canopyR * 0.6} cy={trunkTop + canopyR * 0.35} r={canopyR * 0.72} fill="var(--moss)" opacity="0.85" />
              <circle cx={113 + canopyR * 0.6} cy={trunkTop + canopyR * 0.3} r={canopyR * 0.72} fill="var(--moss-deep)" opacity="0.7" />
              <circle cx="113" cy={trunkTop - canopyR * 0.5} r={canopyR * 0.66} fill="var(--moss)" opacity="0.8" />
            </g>
          )}
          {wilds.map((x, i) => (
            <g key={"wild" + i}>
              <line x1={x} y1="104" x2={x} y2="98" stroke="var(--moss)" strokeWidth="1" />
              <circle cx={x} cy="97" r="2.2" fill={["var(--rose)", "var(--lilac)", "var(--pollen)"][i % 3]} />
            </g>
          ))}
          {Array.from({ length: S }).map((_, i) => {
            const x = sproutX[i];
            return (
              <g key={"s" + i} className="gplant" style={{ animationDelay: (i * 0.4) + "s", animationDuration: (5 + (i % 3) * 0.6) + "s" }}>
                <path d={stem(x, 84)} stroke="var(--moss)" strokeWidth="2" fill="none" strokeLinecap="round" />
                <path d={`M${x} 94 C ${x - 9} 92 ${x - 12} 86 ${x - 12} 84 C ${x - 6} 84 ${x - 1} 88 ${x} 94`} fill="var(--moss)" />
                <path d={`M${x} 98 C ${x + 8} 96 ${x + 11} 91 ${x + 11} 89 C ${x + 5} 89 ${x + 1} 92 ${x} 98`} fill="var(--moss-deep)" />
              </g>
            );
          })}
          {Array.from({ length: F }).map((_, i) => {
            const x = flowerX[i];
            const c = ["var(--rose)", "var(--lilac)", "var(--pollen)"][i % 3];
            const topY = 80;
            return (
              <g key={"f" + i} className="gplant" style={{ animationDelay: (i * 0.5 + 0.2) + "s", animationDuration: (5.4 + (i % 3) * 0.5) + "s" }}>
                <path d={stem(x, topY)} stroke="var(--moss)" strokeWidth="2" fill="none" strokeLinecap="round" />
                <path d={`M${x} 96 C ${x - 8} 95 ${x - 10} 90 ${x - 10} 89 C ${x - 5} 89 ${x - 1} 92 ${x} 96`} fill="var(--moss)" />
                {[0, 1, 2, 3, 4].map((p) => {
                  const a = (p / 5) * Math.PI * 2 - Math.PI / 2;
                  return <circle key={p} cx={x + Math.cos(a) * 5.6} cy={topY + Math.sin(a) * 5.6} r="3.4" fill={c} />;
                })}
                <circle cx={x} cy={topY} r="2.6" fill="var(--pollen)" />
              </g>
            );
          })}
           {Array.from({ length: Math.min(2, kept) }).map((_, i) => {
            const bx = 62 + i * 46, by = 42 + (i % 2) * 12;
            return (
              <g key={"b" + i} className="gflutter" style={{ animationDelay: (i * 0.8) + "s" }}>
                <ellipse cx={bx - 3.2} cy={by} rx="3.4" ry="2.4" fill="var(--lilac)" opacity="0.85" transform={`rotate(-24 ${bx - 3.2} ${by})`} />
                <ellipse cx={bx + 3.2} cy={by} rx="3.4" ry="2.4" fill="var(--rose)" opacity="0.85" transform={`rotate(24 ${bx + 3.2} ${by})`} />
                <line x1={bx} y1={by - 2.4} x2={bx} y2={by + 2.4} stroke="var(--ink)" strokeWidth="0.9" opacity="0.5" />
              </g>
            );
          })}
          {grown === 0 && <circle cx="113" cy="106" r="2.4" fill="var(--faint)" />}
        </svg>
      </div>
      <p className="gardenCaption">{caption}</p>
    </div>
  );
}

/* ═══ month heatmap ═══ */
function MonthCard({ offset, setOffset, meta, play, bare }) {
  const { cells, label } = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear(); const month = now.getMonth() + offset;
    const first = new Date(year, month, 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const arr = [];
    for (let i = 0; i < startDow; i++) arr.push(null);
    for (let d = 1; d <= daysInMonth; d++) arr.push(new Date(year, month, d));
    return { cells: arr, label: first.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) };
  }, [offset]);

  const todayKey = dayKey(Date.now());

  return (
    <div className={bare ? "monthCard monthCardBare" : "monthCard"}>
      {!bare && (
        <div className="monthHead">
          <h3>{label}</h3>
          <div className="monthNav">
            <button onClick={() => { setOffset((o) => o - 1); play("nav"); }} aria-label="Previous month">‹</button>
            <button onClick={() => { setOffset((o) => Math.min(0, o + 1)); play("nav"); }} aria-label="Next month" disabled={offset === 0}>›</button>
          </div>
        </div>
      )}
      <div className="monthDow">{["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className="monthGrid">
        {cells.map((d, i) => {
          if (!d) return <span key={i} className="mCell mEmpty" />;
          const k = dayKey(d.getTime());
          const m = meta[k] || { count: 0, mood: null, journal: false };
          const moodName = m.mood ? MOOD_NAME[m.mood] : null;
          const cls = "mCell"
            + (moodName ? " mMood-" + moodName : (m.count > 0 ? " mActive" : ""))
            + (k === todayKey ? " mToday" : "");
          const tip = `${d.toDateString()} · ${m.count} moment${m.count === 1 ? "" : "s"}`
            + (m.mood ? " · felt " + MOOD_NAME[m.mood] : "")
            + (m.journal ? " · journaled" : "");
          return (
            <span key={i} className={cls} data-tip={tip}>
              {d.getDate()}
              {m.journal && <i className="mDot" />}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ═══ mood trend sparkline ═══ */
function MoodTrend({ points }) {
  const w = 280, h = 56, pad = 8;
  const xs = points.map((_, i) => pad + (i * (w - pad * 2)) / Math.max(1, points.length - 1));
  const ys = points.map((p) => h - pad - ((p.v - 1) / 4) * (h - pad * 2));
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x},${ys[i]}`).join(" ");
  return (
    <div className="moodTrend">
      <p className="moodTrendLabel">Mood, last {points.length} entries</p>
      <svg viewBox={`0 0 ${w} ${h}`} className="moodTrendSvg">
        <path d={path} fill="none" className="moodLine" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        {xs.map((x, i) => <circle key={i} cx={x} cy={ys[i]} r="3" className="moodDot" />)}
      </svg>
    </div>
  );
}

/* ═══ entry-length trend — a companion sparkline, self-scaling ═══ */
function LengthTrend({ points }) {
  const w = 280, h = 56, pad = 8;
  const max = Math.max(1, ...points.map((p) => p.v));
  const xs = points.map((_, i) => pad + (i * (w - pad * 2)) / Math.max(1, points.length - 1));
  const ys = points.map((p) => h - pad - (p.v / max) * (h - pad * 2));
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x},${ys[i]}`).join(" ");
  return (
    <div className="moodTrend">
      <p className="moodTrendLabel">Entry length, last {points.length} entries</p>
      <svg viewBox={`0 0 ${w} ${h}`} className="moodTrendSvg">
        <path d={path} fill="none" className="lengthLine" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        {xs.map((x, i) => <circle key={i} cx={x} cy={ys[i]} r="3" className="lengthDot" />)}
      </svg>
    </div>
  );
}

function TimeField({ value, onChange }) {
  const [open, setOpen] = useState(null); // 'h' | 'm' | null
  const [pendingAmpm, setPendingAmpm] = useState("AM");
  const wrapRef = useRef(null);

  const has = /^\d{2}:\d{2}$/.test(value || "");
  const h24 = has ? parseInt(value.slice(0, 2), 10) : null;
  const min = has ? value.slice(3, 5) : "";
  const ampm = h24 === null ? pendingAmpm : h24 >= 12 ? "PM" : "AM";
  const h12 = h24 === null ? "" : String(((h24 + 11) % 12) + 1);

  const compose = (nh12, nmin, nap) => {
    if (!nh12 || nmin === "") { onChange(""); return; }
    let hh = parseInt(nh12, 10) % 12;
    if (nap === "PM") hh += 12;
    onChange(String(hh).padStart(2, "0") + ":" + String(nmin).padStart(2, "0"));
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(null); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const hours = Array.from({ length: 12 }, (_, i) => String(i + 1));
  const mins = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

  const pickHour = (h) => { compose(h, min || "00", ampm); setOpen("m"); };
  const pickMin = (m) => { compose(h12 || "12", m, ampm); setOpen(null); };
  const toggleAmpm = () => {
    const na = ampm === "AM" ? "PM" : "AM";
    if (has) compose(h12, min, na); else setPendingAmpm(na);
  };
  const clear = () => { onChange(""); setPendingAmpm("AM"); setOpen(null); };

  return (
    <div className={"timeField" + (has ? " timeFieldSet" : "")} ref={wrapRef}>
      <button type="button" className="timeSlot" onClick={() => setOpen(open === "h" ? null : "h")} aria-label="Hour">
        {h12 || "––"}
      </button>
      <span className="timeColon">:</span>
      <button type="button" className="timeSlot" onClick={() => setOpen(open === "m" ? null : "m")} aria-label="Minute">
        {min || "––"}
      </button>
      <button type="button" className="timeAmpm" onClick={toggleAmpm} aria-label="Toggle AM/PM">{ampm}</button>
      {has && <button type="button" className="timeClear" onClick={clear} aria-label="Clear time">×</button>}

      {open && (
        <div className="timePop">
          {(open === "h" ? hours : mins).map((v) => {
            const active = open === "h" ? v === h12 : v === min;
            return (
              <button key={v} type="button"
                className={"timeOpt" + (active ? " timeOptOn" : "")}
                onClick={() => (open === "h" ? pickHour(v) : pickMin(v))}>
                {v}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
function Icon({ name }) {
  const shapes = {
    repeat: <><path d="M16.5 3.5 20 7l-3.5 3.5"/><path d="M20 7H10a6 6 0 0 0-6 6"/><path d="M7.5 20.5 4 17l3.5-3.5"/><path d="M4 17h10a6 6 0 0 0 6-6"/></>,
    steps: <><path d="M4 7l1.6 1.6L8.2 6"/><path d="M12 7h8"/><path d="M4 13l1.6 1.6L8.2 11"/><path d="M12 13h8"/><path d="M12 18h6"/></>,
    calendar: <><rect x="4" y="5" width="16" height="15" rx="2.4"/><path d="M4 9.5h16"/><path d="M8.5 3.5v3M15.5 3.5v3"/></>,
    bell: <><path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4.4 1.8 5.5 1.8 5.5H4.7S6.5 14.4 6.5 10Z"/><path d="M10.4 19a1.7 1.7 0 0 0 3.2 0"/></>,
    star: <path d="M12 3.4l2.7 5.6 6.1.9-4.4 4.4 1 6.1L12 17.3l-5.4 3.1 1-6.1-4.4-4.4 6.1-.9L12 3.4Z"/>,
    bookmark: <path d="M7 4h10a1 1 0 0 1 1 1v14.4a.6.6 0 0 1-.94.5L12 16.8l-5.06 3.6A.6.6 0 0 1 6 19.9V5a1 1 0 0 1 1-1Z"/>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2.4"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
  };
  return <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">{shapes[name] || null}</svg>;
}
/* ═══ small pieces ═══ */
function LeafMark() {
  return (
    <svg className="leaf" viewBox="0 0 28 28" aria-hidden="true">
      <path d="M14 25C7 22 4.5 15 6 7c8-1.5 15 1 18 8-2 6-6 9-10 10z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" transform="scale(.86) translate(2 1)" />
      <path d="M8.5 21.5C12 17 16 13 21 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" transform="scale(.86) translate(2 1)" />
    </svg>
  );
}

function Arc({ pct }) {
  const c = Math.PI * 30; // semicircle
  return (
    <div className="arcWrap" aria-label={pct + "% of intentions complete"}>
      <svg viewBox="0 0 76 44">
        <defs>
          <linearGradient id="skarc" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--moss)" /><stop offset="1" stopColor="var(--rose)" />
          </linearGradient>
        </defs>
        <path d="M8 40 A 30 30 0 0 1 68 40" fill="none" className="arcBg" strokeWidth="7" strokeLinecap="round" />
        <path d="M8 40 A 30 30 0 0 1 68 40" fill="none" stroke="url(#skarc)" strokeWidth="7" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c - (c * pct) / 100} className="arcFg" />
      </svg>
      <span className="arcPct">{pct}<em>%</em></span>
    </div>
  );
}

function TinyWins({ items }) {
  if (items.length === 0) return null;
  return (
    <div className="tinyWins">
      <p className="tinyWinsLabel">Already true today</p>
      <div className="tinyWinsRow">
        {items.map((it) => (
          <span key={it.id} className="tinyWinChip">
            <i>{it.icon}</i>{it.text.slice(0, 42)}{it.text.length > 42 ? "…" : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── auth: a quiet door, not a checkpoint ─────────────────────────── */
function AuthGate() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const send = async () => {
    const e = email.trim();
    if (!e || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { setErr("That doesn't look like an email."); return; }
    setBusy(true); setErr("");
    const { error } = await supabase.auth.signInWithOtp({
      email: e, options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    setBusy(false);
    if (error) setErr("Couldn't send the link. Try again in a moment.");
    else setSent(true);
  };

  return (
    <div className="sk" data-theme="dawn">
      <style>{CSS}</style>
      <div className="authWrap">
        <div className="authCard">
        <p className="eyebrow">Sukoon</p>
        {sent ? (
          <>
            <h1 className="authTitle"><em>Check your email.</em></h1>
            <p className="authSub">A link is on its way to {email.trim()}. Open it, and you're in — no password to remember.</p>
            <button className="authGhost" onClick={() => { setSent(false); setEmail(""); }}>use a different email</button>
          </>
        ) : (
          <>
            <h1 className="authTitle"><em>A quiet place to return to.</em></h1>
            <p className="authSub">Enter your email and we'll send you a link. New here or returning — it's the same door.</p>
            <input className="authInput" type="email" autoComplete="email" placeholder="you@example.com"
              value={email} disabled={busy}
              onChange={(e) => { setEmail(e.target.value); setErr(""); }}
              onKeyDown={(e) => e.key === "Enter" && send()} />
            {err && <p className="authErr">{err}</p>}
            <button className="authBtn" onClick={send} disabled={busy || !email.trim()}>
              {busy ? "Sending…" : "Send me a link"}
            </button>
          </>
        )}
        </div>
      </div>
    </div>
  );
}

export default function Root() {
  const [session, setSession] = useState(undefined); // undefined = still checking

  useEffect(() => {
    if (!supabase) { setSession(null); return; } // no backend → local-only, no gate
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return (
    <div className="sk" data-theme="dawn">
      <style>{CSS}</style>
      <div className="authWrap"><div className="authCard"><p className="authSub">One moment…</p></div></div>
    </div>
  );
  if (!session && supabase) return <AuthGate />;

  // set before SukoonApp's load effect ever runs
  setStoreUser(session?.user?.id ?? null);
  // remount on account switch — no state bleeds between users
  return <Sukoon key={session?.user?.id ?? "local"} session={session} />;
}

function FocusCard({ item, onToggle, onClear }) {
  if (!item) return null;
  return (
    <div className="focusCard">
      <div className="focusHead">
        <span className="focusLabel">✦ Today's one thing</span>
        <button className="focusClear" onClick={onClear} data-tip="Remove as focus" aria-label="Remove as today's focus">×</button>
      </div>
      <button className="focusRow" onClick={onToggle}>
        <span className="focusTick" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <span className="focusText">{item.text}</span>
      </button>
    </div>
  );
}

function Empty({ msg }) {
  return (
    <div className="empty">
      <svg viewBox="0 0 64 40" aria-hidden="true">
        <path d="M10 32c4-10 12-16 22-16 8 0 15 4 20 10" fill="none" className="eHill" strokeWidth="2" strokeLinecap="round" />
        <circle cx="46" cy="12" r="5" className="eSun" />
        <path d="M14 34h36" className="eGround" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <p>{msg}</p>
    </div>
  );
}

/* ═════════════════════════════  STYLES  ═══════════════════════════ */
const CSS = String.raw`
@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:ital,wght@0,400..700;1,400..700&display=swap');

/* ── themes ── */
.sk[data-theme="dawn"]{
  --bg:#EDEFE5; --bg2:#E4E8DA;
  --surface:#F9FAF4; --surface2:#F1F3E9; --border:#DDE2CF; --border2:#CDD4BD;
  --ink:#2C382E; --muted:#75816F; --faint:#9AA592;
  --moss:#5B7A52; --moss-deep:#42603B; --moss-soft:#E3EBD9;
  --rose:#C0766C; --rose-deep:#A65C52; --rose-soft:#F5E4DE;
  --lilac:#8D84B5; --lilac-soft:#E9E5F2;
  --pollen:#C79B4B; --pollen-soft:#F3EAD3;
  --orb1:#BCD3AE; --orb2:#E9C8B4; --orb3:#C4BCDD;
  --sh:0 18px 44px -24px rgba(72,92,64,.35);
  --sh-sm:0 8px 22px -14px rgba(72,92,64,.28);
}
.sk[data-theme="dusk"]{
  --bg:#171D18; --bg2:#131813;
  --surface:#1F281F; --surface2:#243024; --border:#2E3B2E; --border2:#3C4C3B;
  --ink:#E8ECDF; --muted:#93A08C; --faint:#6B7867;
  --moss:#8FB07F; --moss-deep:#A9C79A; --moss-soft:#2A3826;
  --rose:#D28C80; --rose-deep:#E0A296; --rose-soft:#3A2B27;
  --lilac:#A79DCB; --lilac-soft:#2C2A3A;
  --pollen:#D4AC5F; --pollen-soft:#38301D;
  --orb1:#41573C; --orb2:#5E4438; --orb3:#443F5C;
  --sh:0 20px 48px -22px rgba(0,0,0,.6);
  --sh-sm:0 8px 22px -14px rgba(0,0,0,.55);
}

/* time-of-day atmosphere — a faint, drifting tint over either theme */
.sk[data-pod="morning"]{ --atmos:#F3C9A8; --atmos-o:.30; }
.sk[data-pod="afternoon"]{ --atmos:#EDDA9E; --atmos-o:.20; }
.sk[data-pod="evening"]{ --atmos:#C98F8A; --atmos-o:.28; }
.sk[data-pod="night"]{ --atmos:#8D84B5; --atmos-o:.26; }

*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
.sk{
  min-height:100vh; font-family:'Instrument Sans',sans-serif; color:var(--ink); font-size:15px;
  position:relative;
  background:
    radial-gradient(1000px 360px at 12% -8%, color-mix(in srgb, var(--season) 16%, transparent) 0%, transparent 58%),
    radial-gradient(760px 460px at 50% -10%, color-mix(in srgb, var(--atmos) calc(var(--atmos-o) * 100%), transparent) 0%, transparent 62%),
    radial-gradient(900px 520px at 85% -12%, color-mix(in srgb, var(--orb2) 38%, transparent) 0%, transparent 62%),
    radial-gradient(760px 520px at -10% 30%, color-mix(in srgb, var(--orb1) 42%, transparent) 0%, transparent 60%),
    radial-gradient(700px 500px at 55% 115%, color-mix(in srgb, var(--orb3) 30%, transparent) 0%, transparent 60%),
    linear-gradient(var(--bg), var(--bg2));
  transition:background 1.2s ease;
  padding-bottom:40px;
}
button{font-family:inherit; color:inherit; cursor:pointer}
h1,h2,h3{margin:0; font-weight:500}
em{font-style:italic}

/* ── header ── */
.top{max-width:1080px; margin:0 auto; padding:26px 24px 8px; display:flex; align-items:center; gap:18px}
.brand{display:flex; align-items:center; gap:8px; color:var(--moss)}
.leaf{width:24px; height:24px}
.brandName{font-family:'Instrument Serif',serif; font-size:22px; letter-spacing:.01em; color:var(--ink)}
.nav{margin:0 auto; display:flex; gap:4px; background:color-mix(in srgb, var(--surface) 72%, transparent);
  border:1px solid var(--border); border-radius:999px; padding:4px; backdrop-filter:blur(8px)}
.navPill{position:relative; border:none; background:transparent; color:var(--muted); font-size:14px; font-weight:500;
  padding:8px 20px; border-radius:999px; transition:all .25s}
.navPill:hover{color:var(--ink)}
.navPill.on{background:var(--ink); color:var(--bg)}
.navDot{position:absolute; top:8px; right:10px; width:5px; height:5px; border-radius:50%; background:var(--rose)}
.navPill.on .navDot{background:var(--pollen)}
.topBtns{display:flex; gap:8px}
.round{width:38px; height:38px; border:1px solid var(--border); background:color-mix(in srgb, var(--surface) 72%, transparent);
  border-radius:50%; display:grid; place-items:center; color:var(--muted); transition:all .2s; backdrop-filter:blur(8px)}
.round svg{width:17px; height:17px}
.round:hover{color:var(--ink); border-color:var(--border2)}
.round.active{color:var(--moss)}
.round:active{transform:scale(.92)}

/* ── page ── */
.page{max-width:1080px; margin:0 auto; padding:26px 24px 0; display:flex; flex-direction:column; gap:30px; animation:pageIn .5s ease both}
@keyframes pageIn{from{opacity:0}to{opacity:1}}
.viewFade{animation:viewIn .45s cubic-bezier(.22,1,.36,1) both}
@keyframes viewIn{from{opacity:0; transform:translateY(14px)}to{opacity:1; transform:none}}

/* skeleton (pre-load) */
.skeleton{max-width:1080px; margin:0 auto; padding:26px 24px}
.skelTop{display:flex; justify-content:space-between; margin-bottom:40px}
.skelHero{display:grid; grid-template-columns:1.35fr 1fr; gap:28px; align-items:center; margin-bottom:36px}
.skelRows{display:flex; flex-direction:column; gap:10px}
.skelPill,.skelLine,.skelRow,.skelOrb{background:linear-gradient(90deg, var(--surface) 25%, var(--surface2) 50%, var(--surface) 75%);
  background-size:200% 100%; animation:shimmer 1.6s ease-in-out infinite; border-radius:12px}
.skelPill{height:20px; width:80px}
.skelPill.w120{width:120px} .skelPill.round{border-radius:999px}
.skelLine{height:16px; margin-bottom:10px; width:60%}
.skelLine.w40{width:40%; height:12px} .skelLine.w70.big{width:70%; height:38px} .skelLine.w50{width:50%}
.skelOrb{width:180px; height:180px; border-radius:50%; justify-self:center}
.skelRow{height:52px; border-radius:16px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* hero */
.hero{display:grid; grid-template-columns:minmax(0,1.35fr) minmax(260px,1fr); gap:28px; align-items:center}
.eyebrow{margin:0 0 10px; font-size:12px; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--faint)}
h1{font-family:'Instrument Serif',serif; font-size:clamp(34px,4.6vw,52px); line-height:1.06; letter-spacing:-.01em}
h1 em{color:var(--moss)}
.period{color:var(--rose)}
.sub{margin:14px 0 0; font-size:16px; color:var(--muted); line-height:1.6; max-width:42ch}
.heroChips{display:flex; flex-wrap:wrap; gap:8px; margin-top:20px}
.chip{font-size:12.5px; font-weight:500; color:var(--muted); border:1px solid var(--border); background:color-mix(in srgb, var(--surface) 65%, transparent);
  padding:7px 13px; border-radius:999px; backdrop-filter:blur(6px)}
.chip b{color:var(--ink); font-weight:650; font-variant-numeric:tabular-nums}
.chipDone{color:var(--moss); border-color:color-mix(in srgb, var(--moss) 45%, var(--border))}

/* week ribbon */
.ribbon{display:flex; gap:6px; margin-top:16px}
.ribDay{width:22px; height:22px; border-radius:50%; border:1px solid var(--border); display:grid; place-items:center; background:color-mix(in srgb, var(--surface) 60%, transparent)}
.ribDay i{width:7px; height:7px; border-radius:50%; background:var(--border2); transition:background .3s}
.ribDay.ribOn i{background:var(--moss)}
.ribDay.ribToday{border-color:var(--moss); box-shadow:0 0 0 2px color-mix(in srgb, var(--moss) 22%, transparent)}

/* breathing card — signature */
.breath{display:flex; flex-direction:column; align-items:center; gap:12px; justify-self:center}
.patternRow{display:flex; gap:6px; flex-wrap:wrap; justify-content:center}
.patternPill{border:1px solid var(--border); background:var(--surface); color:var(--muted); font-size:11.5px; font-weight:600;
  padding:6px 12px; border-radius:999px; transition:all .2s}
.patternPill:hover{border-color:var(--border2); color:var(--ink)}
.patternPill.patOn{background:var(--moss-soft); border-color:var(--moss); color:var(--moss-deep)}
.orbStage{position:relative; width:225px; height:225px; display:grid; place-items:center; cursor:pointer; border-radius:50%}
.orbHalo{position:absolute; inset:-8px; border-radius:50%; border:1px dashed var(--border2); animation:slowSpin 40s linear infinite; opacity:.7}
@keyframes slowSpin{to{transform:rotate(360deg)}}
.orb{position:absolute; width:150px; height:150px; border-radius:50%;
  background:radial-gradient(circle at 34% 30%, var(--orb2) 0%, var(--orb1) 46%, var(--orb3) 100%);
  filter:blur(.4px); box-shadow:var(--sh), inset 0 2px 14px rgba(255,255,255,.35);
  transform:scale(.72); transition-property:transform; transition-timing-function:cubic-bezier(.45,0,.35,1);
  animation:idlePulse 5.5s ease-in-out infinite}
.orbStageBig .orb{animation:orbGlow 5.5s ease-in-out infinite; width:210px; height:210px}
@keyframes orbGlow{
  0%,100%{box-shadow:var(--sh), inset 0 2px 14px rgba(255,255,255,.35), 0 0 46px 8px color-mix(in srgb, var(--pollen) 24%, transparent)}
  50%{box-shadow:var(--sh), inset 0 2px 14px rgba(255,255,255,.35), 0 0 74px 18px color-mix(in srgb, var(--rose) 30%, transparent)}
}
@keyframes idlePulse{0%,100%{transform:scale(.7)}50%{transform:scale(.78)}}
.orbCore{position:relative; z-index:2; display:flex; flex-direction:column; align-items:center; gap:4px; pointer-events:none; text-align:center}
.orbPhase{font-family:'Instrument Serif',serif; font-size:20px; font-style:italic; color:var(--ink); text-shadow:0 1px 8px color-mix(in srgb, var(--bg) 70%, transparent)}
.orbCount{font-size:11.5px; font-weight:550; letter-spacing:.06em; color:var(--muted); text-transform:lowercase; font-variant-numeric:tabular-nums}
.breathStop{border:1px solid var(--border); background:var(--surface); color:var(--muted); font-size:13px; font-weight:550;
  padding:9px 20px; border-radius:999px; transition:all .2s; margin-top:8px}
.breathStop:hover{color:var(--ink); border-color:var(--border2)}

/* progress ring around the orb */
.ring{position:absolute; inset:0; width:100%; height:100%; transform:rotate(-90deg); z-index:1}
.ringBg{fill:none; stroke:color-mix(in srgb, var(--ink) 10%, transparent); stroke-width:2.5}
.ringFg{fill:none; stroke:var(--moss); stroke-width:2.5; stroke-linecap:round;
  animation-name:ringWipe; animation-timing-function:linear; animation-fill-mode:forwards}
@keyframes ringWipe{ from{stroke-dashoffset:var(--circ)} to{stroke-dashoffset:0} }
.panicOverlay{position:fixed; inset:0; z-index:90; display:grid; place-items:center}
.panicBg{position:absolute; inset:0; background:color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter:blur(14px) saturate(1.05); animation:overlayIn .5s ease both}
.panicContent{position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; gap:18px; animation:overlayRise .5s cubic-bezier(.22,1,.36,1) both; text-align:center; padding:0 20px}
.panicLine{margin:0; font-family:'Instrument Serif',serif; font-style:italic; font-size:clamp(18px,2.6vw,24px); color:var(--ink); max-width:32ch}
.panicExit{border:1px solid var(--border); background:var(--surface); color:var(--muted); font-size:13.5px; font-weight:600; padding:10px 22px; border-radius:999px; transition:all .2s}
.panicExit:hover{color:var(--ink); border-color:var(--border2)}
.panicBtn:hover{color:var(--lilac)}
/* full-focus breathing overlay */
.breathOverlay{position:fixed; inset:0; z-index:50; display:grid; place-items:center}
.breathOverlayBg{position:absolute; inset:0; background:color-mix(in srgb, var(--bg) 78%, transparent); backdrop-filter:blur(10px) saturate(1.05); animation:overlayIn .4s ease both}
@keyframes overlayIn{from{opacity:0}to{opacity:1}}
.breathOverlayContent{position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; gap:6px; animation:overlayRise .45s cubic-bezier(.22,1,.36,1) both}
@keyframes overlayRise{from{opacity:0; transform:translateY(16px) scale(.97)}to{opacity:1; transform:none}}
.orbStageBig{position:relative; width:320px; height:320px; display:grid; place-items:center}
.orbStageBig .orbHalo{inset:-10px}
.breathClose{display:flex; flex-direction:column; align-items:center; gap:8px; text-align:center; animation:closeIn .5s ease both}
@keyframes closeIn{from{opacity:0; transform:scale(.9)}to{opacity:1; transform:none}}
.closeMark{width:52px; height:52px; border-radius:50%; background:var(--moss-soft); color:var(--moss-deep); display:grid; place-items:center; font-size:22px; margin-bottom:4px}
.closeTitle{margin:0; font-family:'Instrument Serif',serif; font-size:26px; font-style:italic; color:var(--ink)}
.closeSub{margin:0; font-size:13.5px; color:var(--muted); font-variant-numeric:tabular-nums}

/* layout grid */
.grid{display:grid; grid-template-columns:minmax(0,1.5fr) minmax(260px,1fr); gap:24px; align-items:start; margin-top:28px}
.col{display:flex; flex-direction:column; gap:14px; min-width:0}
.secHead{display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap}
.secHeadRight{display:flex; align-items:center; gap:10px; flex-wrap:wrap}
h2{font-family:'Instrument Serif',serif; font-size:24px}
h3{font-family:'Instrument Serif',serif; font-size:18px}
.filters{display:flex; gap:5px}
.fPill{border:1px solid var(--border); background:transparent; color:var(--muted); font-size:12.5px; font-weight:550;
  padding:6px 14px; border-radius:999px; transition:all .2s}
.fPill:hover{border-color:var(--border2); color:var(--ink)}
.fPill.fOn.f-all{background:var(--ink); border-color:var(--ink); color:var(--bg)}
.fPill.fOn.f-work{background:var(--moss-soft); border-color:var(--moss); color:var(--moss-deep)}
.fPill.fOn.f-personal{background:var(--rose-soft); border-color:var(--rose); color:var(--rose-deep)}

/* sort toggle + active-filter badge */
.sortToggle{display:flex; gap:4px; background:var(--surface); border:1px solid var(--border); border-radius:999px; padding:3px}
.sortPill{border:none; background:transparent; color:var(--muted); font-size:11.5px; font-weight:600; padding:5px 11px; border-radius:999px; transition:all .2s}
.sortPill:hover{color:var(--ink)}
.sortPill.sortOn{background:var(--ink); color:var(--bg)}
.activeFilterBadge{border:1px solid color-mix(in srgb, var(--lilac) 45%, var(--border)); background:var(--lilac-soft); color:var(--lilac);
  font-size:11.5px; font-weight:650; padding:6px 12px; border-radius:999px; transition:all .2s}
.activeFilterBadge:hover{opacity:.85}

/* composer */
.compose{display:flex; flex-direction:column; gap:10px; background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:12px; box-shadow:var(--sh-sm)}
.compose input{border:none; outline:none; background:transparent; padding:9px 8px; font:500 15.5px 'Instrument Sans'; color:var(--ink)}
.compose input::placeholder{color:var(--faint); font-style:italic; font-family:'Instrument Serif',serif; font-size:16.5px}
.catRow{display:flex; gap:8px; align-items:center; border-top:1px solid var(--border); padding-top:10px; flex-wrap:wrap}
.cat{border:1px solid var(--border); background:transparent; color:var(--muted); font-size:12.5px; font-weight:550; padding:7px 15px; border-radius:999px; transition:all .2s}
.cat.work.catOn{background:var(--moss-soft); border-color:var(--moss); color:var(--moss-deep)}
.cat.personal.catOn{background:var(--rose-soft); border-color:var(--rose); color:var(--rose-deep)}
.cat.repeat{font-size:12px}
.cat.repeat.catOn{background:var(--pollen-soft); border-color:var(--pollen); color:var(--pollen)}
.cat.someday{font-size:12px}
.cat.someday.catOn{background:var(--lilac-soft); border-color:var(--lilac); color:var(--lilac)}
.timeIn{border:1px solid var(--border); background:var(--surface2); color:var(--ink); font-size:12.5px; font-weight:550;
  padding:6px 10px; border-radius:999px; outline:none; font-family:'Instrument Sans'}
.timeIn:focus{border-color:var(--moss)}
.addBtn,.primary{margin-left:auto; border:none; background:var(--ink); color:var(--bg); font-size:13.5px; font-weight:600;
  padding:9px 20px; border-radius:999px; transition:transform .15s, opacity .2s; box-shadow:var(--sh-sm)}
.addBtn:hover,.primary:hover{opacity:.9}
.addBtn:active,.primary:active{transform:scale(.96)}
.linkIn{flex:1; border:none; outline:none; background:transparent; font:500 13.5px 'Instrument Sans'; color:var(--ink); padding:6px 8px}
.linkIn::placeholder{color:var(--faint)}
.tagIn{border:1px solid var(--border); background:var(--surface2); color:var(--ink); font-size:12.5px; font-weight:550;
  padding:6px 10px; border-radius:999px; outline:none; font-family:'Instrument Sans'; width:84px}
.tagIn:focus{border-color:var(--lilac); width:120px}
.tagIn::placeholder{color:var(--faint)}
.jTagIn{width:110px}
.draftTagRow{display:flex; flex-wrap:wrap; gap:6px; padding:0 8px}
.draftTagChip{display:inline-flex; align-items:center; gap:5px; font-size:11.5px; font-weight:600; color:var(--lilac);
  background:var(--lilac-soft); padding:4px 6px 4px 10px; border-radius:999px}
.draftTagChip button{border:none; background:transparent; color:inherit; font-size:14px; line-height:1; padding:0 2px; opacity:.7}
.draftTagChip button:hover{opacity:1}

/* recurrence day-picker (composer + row editing) */
.dayPickRow{display:flex; gap:5px; padding:0 8px 4px}
.dayPick{border:1px solid var(--border); background:var(--surface2); color:var(--muted); font-size:11px; font-weight:650;
  width:30px; height:26px; border-radius:8px; transition:all .18s}
.dayPick:hover{border-color:var(--border2); color:var(--ink)}
.dayPick.dayPickOn{background:var(--pollen-soft); border-color:var(--pollen); color:var(--pollen)}
.recurEditRow{display:flex; align-items:center; gap:6px; flex-wrap:wrap; background:var(--surface); border:1px dashed var(--border2);
  border-radius:14px; padding:9px 12px; margin:-3px 0 2px}
.recurEditLabel{font-size:11.5px; font-weight:600; color:var(--faint); margin-right:2px}
.recurEditClear{border:none; background:transparent; color:var(--rose-deep); font-size:11.5px; font-weight:650; padding:5px 8px; margin-left:auto}
.recurEditClear:hover{text-decoration:underline}
.recurEditDone{border:none; background:var(--ink); color:var(--bg); font-size:11.5px; font-weight:650; padding:6px 14px; border-radius:999px}

/* starter suggestions — first-run onboarding */
.starters{display:flex; flex-direction:column; gap:10px; padding:6px 2px 2px; animation:rise .4s ease both}
.startersLabel{margin:0; font-size:12px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--faint)}
.starterRow{display:flex; flex-wrap:wrap; gap:8px}
.starterChip{display:flex; align-items:center; gap:8px; border:1px dashed var(--border2); background:var(--surface);
  color:var(--ink); font-size:13.5px; font-weight:500; padding:10px 16px; border-radius:999px; transition:all .2s}
.starterChip:hover{border-style:solid; transform:translateY(-1px); box-shadow:var(--sh-sm)}
.starterChip:active{transform:scale(.97)}
.starterChip.work:hover{border-color:var(--moss); background:var(--moss-soft)}
.starterChip.personal:hover{border-color:var(--rose); background:var(--rose-soft)}
.starterIcon{font-size:15px}

/* tag filtering */
.tagFilterRow{display:flex; flex-wrap:wrap; align-items:center; gap:6px}
.tagFilterChip{border:1px solid var(--border); background:var(--surface); color:var(--muted); font-size:12px; font-weight:600;
  padding:5px 12px; border-radius:999px; transition:all .2s}
.tagFilterChip:hover{border-color:var(--border2); color:var(--ink)}
.tagFilterChip.tagFilterOn{background:var(--lilac-soft); border-color:var(--lilac); color:var(--lilac)}
.tagFilterClear{border:none; background:transparent; color:var(--faint); font-size:11.5px; font-weight:600; padding:5px 8px}
.tagFilterClear:hover{color:var(--rose-deep)}

/* task rows */
.dragHint{margin:0; font-size:11px; font-weight:550; letter-spacing:.04em; color:var(--faint); font-style:italic; font-family:'Instrument Serif',serif}
.list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:9px}
.rowGroup{display:flex; flex-direction:column; gap:6px}
.row{display:flex; align-items:center; gap:11px; flex-wrap:nowrap; background:var(--surface); border:1px solid var(--border); border-radius:16px;
  padding:13px 14px; box-shadow:var(--sh-sm); animation:rise .35s ease both; transition:border-color .25s, transform .25s, opacity .3s, box-shadow .2s; cursor:pointer}
.row:hover{border-color:var(--border2); transform:translateY(-1px)}
.row.done{opacity:.5}
.row.done .rowText{text-decoration:line-through; text-decoration-color:var(--faint); text-decoration-thickness:1px}
.row.dragging{opacity:.35}
.row.dragOver{border-color:var(--moss); box-shadow:0 0 0 2px color-mix(in srgb, var(--moss) 25%, transparent), var(--sh-sm)}
.handle{flex:none; width:18px; text-align:center; color:var(--faint); font-size:15px; line-height:1; cursor:grab; padding:4px 2px; border-radius:6px; transition:color .18s}
.handle:hover{color:var(--muted)}
.handle:active{cursor:grabbing}
.handleOff{cursor:default; opacity:.3}
.handleOff:hover{color:var(--faint)}
.tick{width:26px; height:26px; flex:none; border-radius:50%; border:1.5px solid var(--border2); background:transparent;
  display:grid; place-items:center; transition:all .25s cubic-bezier(.3,1.4,.4,1)}
.tick:hover{border-color:var(--moss)}
.tick:active{transform:scale(.82)}
.tick svg{width:13px; height:13px; stroke:var(--bg); stroke-dasharray:24; stroke-dashoffset:24; transition:stroke-dashoffset .3s ease .05s}
.row.done .tick{background:var(--moss); border-color:var(--moss)}
.row.personal.done .tick{background:var(--rose); border-color:var(--rose)}
.row.done .tick svg{stroke-dashoffset:0}
.rowText{flex:1 1 auto; min-width:0; font-size:14.5px; line-height:1.45; border-radius:8px; padding:2px 4px; margin:-2px -4px; transition:background .15s;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.rowText:hover{background:color-mix(in srgb, var(--ink) 5%, transparent)}
.recurMark{font-size:11px; opacity:.8; margin-right:5px}
.rowEdit{flex:1; min-width:0; font:500 14.5px 'Instrument Sans'; color:var(--ink); background:var(--surface2); border:1px solid var(--moss);
  border-radius:8px; padding:5px 8px; outline:none}
.tag{flex:none; font-size:10.5px; font-weight:650; letter-spacing:.08em; text-transform:uppercase; padding:4px 10px; border-radius:999px}
.tag.work{background:var(--moss-soft); color:var(--moss-deep)}
.tag.personal{background:var(--rose-soft); color:var(--rose-deep)}
.rowTag{flex:none; display:inline-flex; align-items:center; gap:3px; font-size:11px; font-weight:600; color:var(--lilac);
  background:var(--lilac-soft); padding:3px 4px 3px 9px; border-radius:999px}
.rowTag button{border:none; background:transparent; color:inherit; font-size:13px; line-height:1; padding:0 3px; opacity:.7}
.rowTag button:hover{opacity:1}
.rowTagInput{flex:none; width:70px; font-size:11.5px; font-weight:550; color:var(--ink); background:var(--surface2);
  border:1px solid var(--lilac); border-radius:999px; padding:4px 10px; outline:none}
.timeBadge{flex:none; font-size:10.5px; font-weight:650; color:var(--muted); font-variant-numeric:tabular-nums; background:var(--surface2); padding:4px 9px; border-radius:999px}
.stepsBadge{flex:none; border:1px solid var(--border); background:var(--surface2); color:var(--muted); font-size:10.5px; font-weight:650;
  padding:4px 9px; border-radius:999px; transition:all .18s}
.stepsBadge:hover{border-color:var(--border2); color:var(--ink)}
.stepsBadge.stepsDone{background:var(--moss-soft); border-color:var(--moss); color:var(--moss-deep)}
.recurBadge{font-size:10.5px; opacity:1; color:var(--pollen)}
.rowIcon{flex:none; border:none; background:transparent; color:var(--faint); font-size:14px; padding:4px 6px; border-radius:8px; opacity:.5; transition:all .18s}
.row:hover .rowIcon{opacity:.9}
.rowIcon:hover{opacity:1; background:color-mix(in srgb, var(--ink) 6%, transparent)}
.rowIcon.reminderOn{opacity:1; color:var(--pollen)}
.x{flex:none; border:none; background:transparent; color:var(--faint); font-size:17px; line-height:1; padding:4px 8px; border-radius:8px; opacity:0; transition:all .18s}
.row:hover .x,.jEntry:hover .x,.pCard:hover .x,.subRow .x,.somedayRow .x{opacity:.85}
.x:hover{color:var(--rose-deep); background:var(--rose-soft); opacity:1}
.x:active{transform:scale(.85)}

/* sub-checklist */
.subPanel{background:var(--surface2); border:1px dashed var(--border2); border-radius:14px; padding:10px 12px; display:flex; flex-direction:column; gap:8px; margin-left:32px}
.subPanelHead{display:flex; align-items:center; justify-content:space-between; margin-bottom:2px}
.subPanelLabel{font-size:11px; font-weight:650; letter-spacing:.06em; text-transform:uppercase; color:var(--faint)}
.subPanelClose{border:none; background:transparent; color:var(--faint); font-size:16px; line-height:1; padding:2px 6px; border-radius:8px; transition:all .18s}
.subPanelClose:hover{color:var(--rose-deep); background:var(--rose-soft)}
.subList{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px}
.subRow{display:flex; align-items:center; gap:8px}
.subTick{width:19px; height:19px; flex:none; border-radius:50%; border:1.5px solid var(--border2); background:transparent; display:grid; place-items:center; transition:all .2s}
.subTick svg{width:10px; height:10px; stroke:var(--bg); stroke-dasharray:20; stroke-dashoffset:20; transition:stroke-dashoffset .25s ease}
.subRow.subDone .subTick{background:var(--moss); border-color:var(--moss)}
.subRow.subDone .subTick svg{stroke-dashoffset:0}
.subText{flex:1; font-size:13px; line-height:1.4}
.subRow.subDone .subText{text-decoration:line-through; color:var(--faint)}
.subAddRow{display:flex; gap:8px; align-items:center}
.subAddRow input{flex:1; border:1px solid var(--border); background:var(--surface); color:var(--ink); font-size:13px; padding:6px 10px; border-radius:999px; outline:none}
.subAddRow input:focus{border-color:var(--moss)}
.subAddBtn{border:none; background:var(--ink); color:var(--bg); font-size:12px; font-weight:600; padding:6px 14px; border-radius:999px}

/* someday bucket */
.somedayCard{border:1px dashed var(--border2); border-radius:16px; background:color-mix(in srgb, var(--surface) 60%, transparent); overflow:hidden}
.somedayHead{width:100%; display:flex; align-items:center; justify-content:space-between; border:none; background:transparent; padding:12px 16px; font-size:13px; font-weight:600; color:var(--muted)}
.somedayHead b{color:var(--ink); font-variant-numeric:tabular-nums}
.somedayChevron{transition:transform .2s; color:var(--faint)}
.somedayOpenChevron{transform:rotate(90deg)}
.somedayList{list-style:none; margin:0; padding:0 12px 12px; display:flex; flex-direction:column; gap:6px}
.somedayRow{display:flex; align-items:center; gap:10px; background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:9px 12px}
.somedayRow .tag{width:8px; height:8px; padding:0; border-radius:50%}
.somedayText{flex:1; font-size:13.5px; line-height:1.4; min-width:0; word-break:break-word}
.somedayPull{flex:none; border:1px solid var(--moss); background:var(--moss-soft); color:var(--moss-deep); font-size:11px; font-weight:650; padding:5px 11px; border-radius:999px}
.somedayPull:hover{opacity:.85}

/* day panel */
.side{gap:16px}
.dayCard{display:flex; align-items:center; gap:16px; background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:18px; box-shadow:var(--sh-sm)}
.arcWrap{position:relative; width:82px; flex:none}
.arcBg{stroke:var(--surface2)}
.arcFg{transition:stroke-dashoffset .9s cubic-bezier(.22,1,.36,1)}
.arcPct{position:absolute; left:0; right:0; bottom:2px; text-align:center; font-family:'Instrument Serif',serif; font-size:19px; font-variant-numeric:tabular-nums}
.arcPct em{font-style:normal; font-size:11px; color:var(--muted)}
.dayText{display:flex; flex-direction:column; gap:3px}
.dayText strong{font-size:14.5px; font-weight:600; font-variant-numeric:tabular-nums}
.dayText span{font-size:12.5px; color:var(--muted); line-height:1.5}

/* month heatmap */
.monthCard{background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:16px 18px; box-shadow:var(--sh-sm); display:flex; flex-direction:column; gap:10px}
.monthCardBare{background:transparent; border:none; box-shadow:none; padding:0}
.monthHead{display:flex; align-items:center; justify-content:space-between}
.monthNav{display:flex; gap:4px}
.monthNav button{width:24px; height:24px; border:1px solid var(--border); background:transparent; border-radius:8px; color:var(--muted); font-size:13px; display:grid; place-items:center}
.monthNav button:hover:not(:disabled){color:var(--ink); border-color:var(--border2)}
.monthNav button:disabled{opacity:.35; cursor:default}
.monthDow{display:grid; grid-template-columns:repeat(7,1fr); text-align:center; font-size:10px; font-weight:600; color:var(--faint); letter-spacing:.04em}
.monthGrid{display:grid; grid-template-columns:repeat(7,1fr); gap:3px}
.mCell{position:relative; aspect-ratio:1; display:grid; place-items:center; font-size:10px; font-weight:550; color:var(--muted); border-radius:7px; background:var(--surface2); font-variant-numeric:tabular-nums; transition:background .3s}
.mCell.mEmpty{background:transparent}
.mCell.mActive{background:color-mix(in srgb, var(--moss) 22%, var(--surface2)); color:var(--ink)}
.mCell.mMood-bright{background:color-mix(in srgb, #E7C766 40%, var(--surface2)); color:var(--ink)}
.mCell.mMood-light{background:color-mix(in srgb, #EBB98C 40%, var(--surface2)); color:var(--ink)}
.mCell.mMood-steady{background:color-mix(in srgb, #A9C79A 44%, var(--surface2)); color:var(--ink)}
.mCell.mMood-foggy{background:color-mix(in srgb, #B7ADD8 42%, var(--surface2)); color:var(--ink)}
.mCell.mMood-heavy{background:color-mix(in srgb, #8D84B5 38%, var(--surface2)); color:var(--ink)}
.mCell.mToday{box-shadow:0 0 0 1.5px var(--rose) inset}
.mDot{position:absolute; top:3px; right:3px; width:4px; height:4px; border-radius:50%; background:var(--lilac); box-shadow:0 0 0 1px color-mix(in srgb, var(--surface) 70%, transparent)}

.trailCard{background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:18px; box-shadow:var(--sh-sm); display:flex; flex-direction:column; gap:12px}
.trailEmpty{margin:0; font-size:13px; color:var(--muted); line-height:1.6}
.trail{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px}
.tr{display:flex; align-items:baseline; gap:10px}
.trDot{width:7px; height:7px; border-radius:50%; flex:none; background:var(--moss); transform:translateY(-1px)}
.tr.personal .trDot{background:var(--rose)}
.tr.journal .trDot{background:var(--lilac)}
.tr.pocket .trDot{background:var(--pollen)}
.trText{flex:1; min-width:0; font-size:13px; line-height:1.45; word-break:break-word}
.trTime{font-size:11px; color:var(--faint); font-variant-numeric:tabular-nums}
.noteCard{border-left:3px solid var(--pollen); padding:4px 0 4px 22px; position:relative}
.noteCard p{margin:0; position:relative; font-family:'Instrument Serif',serif; font-style:italic; font-size:16.5px; line-height:1.5; color:var(--muted)}
.noteCard p::before{content:"“"; position:absolute; left:-14px; top:2px; font-size:1.5em; line-height:1; color:var(--rose); opacity:.55}
.noteCard p::after{content:"”"; color:var(--rose); opacity:.55}

/* journal view */
.narrow{max-width:640px; margin:0 auto; width:100%; display:flex; flex-direction:column; gap:20px}
.jHero{text-align:center; padding:6px 0 2px; position:relative}
.prompt{font-size:clamp(26px,3.6vw,36px); line-height:1.2}
.prompt em{color:var(--moss)}
.exportLink{border:1px solid var(--border); background:var(--surface); color:var(--muted);
  font-size:11.5px; font-weight:600; padding:6px 12px; border-radius:999px; transition:all .2s}
.exportLink:hover{color:var(--ink); border-color:var(--border2)}
.jHeroActions{display:flex; gap:8px; align-items:center; justify-content:center; flex-wrap:wrap; margin-top:14px}
.rangeToggle{display:inline-flex; gap:4px; margin-top:16px; background:var(--surface); border:1px solid var(--border); border-radius:999px; padding:4px}
.rangePill{border:none; background:transparent; color:var(--muted); font-size:12.5px; font-weight:600; padding:6px 16px; border-radius:999px; transition:all .2s}
.rangePill.rangeOn{background:var(--ink); color:var(--bg)}
/* "on this day" — same voice as the hero recall: leaf, serif, moss */
.onThisDay{background:color-mix(in srgb, var(--moss-soft) 55%, var(--surface)); border:1px solid color-mix(in srgb, var(--moss) 28%, var(--border)); border-radius:18px; padding:14px 18px; display:flex; flex-direction:column; gap:7px}
.onThisDayLead{margin:0; display:flex; align-items:flex-start; gap:8px; font-family:'Instrument Serif',serif; font-size:14px; line-height:1.5; color:var(--moss-deep)}
.onThisDayMark{flex:none; color:var(--moss); width:15px; height:15px; margin-top:1px}
.onThisDayMark .leaf{width:15px; height:15px}
.onThisDayText{margin:0; font-family:'Instrument Serif',serif; font-style:italic; font-size:15px; line-height:1.6; color:var(--ink)}
.onThisDayDate{margin:0; font-size:10.5px; font-weight:600; letter-spacing:.04em; color:var(--faint); font-variant-numeric:tabular-nums}
.jCompose{display:flex; flex-direction:column; gap:12px; background:var(--surface); border:1px solid var(--border); border-radius:22px; padding:16px; box-shadow:var(--sh-sm)}
.moodRow{display:flex; gap:6px; justify-content:center; flex-wrap:wrap}
.mood{display:flex; flex-direction:column; align-items:center; gap:2px; border:1px solid var(--border); background:transparent;
  padding:8px 12px 6px; border-radius:14px; transition:all .2s; min-width:58px}
.mood span{font-size:17px}
.mood small{font-size:10px; font-weight:600; letter-spacing:.05em; color:var(--muted); text-transform:lowercase}
.mood:hover{border-color:var(--border2)}
.mood:active{transform:scale(.92)}
.moodOn{border-color:var(--moss); background:var(--moss-soft)}
.moodOn small{color:var(--moss-deep)}
.jCompose textarea{border:none; outline:none; resize:vertical; background:var(--surface2); border-radius:14px; padding:14px 16px;
  font:400 15px/1.7 'Instrument Sans'; color:var(--ink); min-height:130px}
.jCompose textarea::placeholder{color:var(--faint); font-family:'Instrument Serif',serif; font-style:italic; font-size:16px}
.jCompose textarea:focus{box-shadow:0 0 0 1.5px var(--moss)}
.jFoot{display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap}
.soft{font-size:12px; color:var(--faint); font-style:italic; font-family:'Instrument Serif',serif}

/* mood + length trend pair */
.trendPair{display:flex; gap:14px; flex-wrap:wrap}
.trendPair .moodTrend{flex:1; min-width:220px}
.moodTrend{background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:14px 16px; box-shadow:var(--sh-sm)}
.moodTrendLabel{margin:0 0 6px; font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--faint)}
.moodTrendSvg{width:100%; height:56px; display:block}
.moodLine{stroke:var(--moss)}
.moodDot{fill:var(--surface); stroke:var(--moss); stroke-width:1.6}
.lengthLine{stroke:var(--lilac)}
.lengthDot{fill:var(--surface); stroke:var(--lilac); stroke-width:1.6}

.reviewChips{display:flex; flex-wrap:wrap; gap:8px; justify-content:center}
.reviewCard{background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:18px; box-shadow:var(--sh-sm); display:flex; flex-direction:column; gap:14px}
.weekBars{display:flex; justify-content:space-between; gap:8px; align-items:flex-end}
.weekBarCol{display:flex; flex-direction:column; align-items:center; gap:5px; flex:1}
.weekBarTrack{width:100%; max-width:26px; height:80px; background:var(--surface2); border-radius:8px; display:flex; align-items:flex-end; overflow:hidden}
.weekBarFill{width:100%; background:linear-gradient(var(--rose), var(--moss)); border-radius:8px; transition:height .6s cubic-bezier(.22,1,.36,1); min-height:3px}
.weekBarCount{font-size:11px; font-weight:650; color:var(--muted); font-variant-numeric:tabular-nums; min-height:14px}
.weekBarLabel{font-size:10.5px; font-weight:600; color:var(--faint)}
.weekToday .weekBarLabel{color:var(--moss-deep)}

.themeRow{display:flex; flex-wrap:wrap; gap:8px}
.themeChip{border:1px solid color-mix(in srgb, var(--lilac) 40%, var(--border)); background:var(--lilac-soft); color:var(--lilac);
  font-size:12.5px; font-weight:600; padding:6px 12px; border-radius:999px}
.themeChip b{color:var(--ink); font-weight:700}

.jSearch{display:flex; align-items:center; gap:9px; background:var(--surface); border:1px solid var(--border); border-radius:999px; padding:9px 15px; box-shadow:var(--sh-sm)}
.jSearchIcon{width:15px; height:15px; color:var(--faint); flex:none}
.jSearch input{flex:1; border:none; outline:none; background:transparent; font:500 13.5px 'Instrument Sans'; color:var(--ink)}
.jSearch input::placeholder{color:var(--faint); font-style:italic; font-family:'Instrument Serif',serif}
.jSearchClear{flex:none; border:none; background:transparent; color:var(--faint); font-size:16px; line-height:1; padding:2px 7px; border-radius:8px; transition:all .18s}
.jSearchClear:hover{color:var(--rose-deep); background:var(--rose-soft)}

.jList{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:12px}
.jEntry{background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:16px 18px; box-shadow:var(--sh-sm); animation:rise .35s ease both; transition:border-color .25s}
.jEntry:hover{border-color:var(--border2)}
.jMeta{display:flex; align-items:center; gap:9px}
.jMood{font-size:15px}
.jDate{flex:1; font-size:11.5px; font-weight:600; color:var(--faint); letter-spacing:.04em; font-variant-numeric:tabular-nums}
.miniEdit{border:none; background:transparent; color:var(--faint); font-size:11.5px; font-weight:600; padding:3px 6px; border-radius:6px; opacity:0; transition:opacity .18s}
.jEntry:hover .miniEdit{opacity:.85}
.miniEdit:hover{color:var(--moss-deep); opacity:1}
.jPrompt{margin:10px 0 0; font-family:'Instrument Serif',serif; font-style:italic; font-size:14.5px; color:var(--muted)}
.jBody{margin:7px 0 0; font-size:14.5px; line-height:1.85; white-space:pre-wrap}
.jTagRow{display:flex; flex-wrap:wrap; gap:6px; margin-top:10px}
.jTagChip{font-size:11px; font-weight:600; color:var(--lilac); background:var(--lilac-soft); padding:3px 10px; border-radius:999px}
.jEditWrap{margin-top:8px; display:flex; flex-direction:column; gap:8px}
.jEditArea{font:400 14.5px/1.7 'Instrument Sans'; color:var(--ink); background:var(--surface2); border:1px solid var(--moss); border-radius:12px; padding:10px 12px; outline:none; resize:vertical}
.jEditBtns{display:flex; justify-content:flex-end; gap:8px}
.miniCancel{border:1px solid var(--border); background:transparent; color:var(--muted); font-size:12px; font-weight:600; padding:6px 14px; border-radius:999px}
.miniSave{border:none; background:var(--ink); color:var(--bg); font-size:12px; font-weight:600; padding:6px 16px; border-radius:999px}

/* pocket */
.pocketCompose input::placeholder{font-family:'Instrument Serif',serif; font-style:italic}
.pGrid{display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:14px}
.pCard{position:relative; border:1px solid var(--border); border-radius:18px; padding:16px 16px 12px; background:var(--surface);
  box-shadow:var(--sh-sm); display:flex; flex-direction:column; gap:7px; animation:rise .35s ease both; transition:border-color .25s, transform .25s}
.pCard:hover{border-color:var(--border2); transform:translateY(-2px)}
.pCard::after{content:""; position:absolute; top:12px; left:16px; width:22px; height:3px; border-radius:99px}
.v0::after{background:var(--moss)} .v1::after{background:var(--rose)} .v2::after{background:var(--lilac)} .v3::after{background:var(--pollen)}
.pTitle{margin:12px 0 0; font-size:14px; line-height:1.55; word-break:break-word; font-weight:500}
.pLink{font-size:12px; font-weight:600; color:var(--moss-deep); text-decoration:none; word-break:break-all}
.pLink:hover{text-decoration:underline}
.pDate{font-size:10.5px; color:var(--faint); font-variant-numeric:tabular-nums}
.pX{position:absolute; top:8px; right:8px}

/* completion celebration */
.celebrate{position:fixed; inset:0; z-index:60; display:grid; place-items:center; pointer-events:none; overflow:hidden}
.celebrateWash{position:absolute; inset:0; background:radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--moss) 22%, transparent) 0%, transparent 70%), color-mix(in srgb, var(--moss-soft) 55%, transparent);
  animation:washInOut 2.7s ease forwards}
@keyframes washInOut{0%{opacity:0}18%{opacity:1}78%{opacity:1}100%{opacity:0}}
.celebrateText{position:relative; z-index:1; font-family:'Instrument Serif',serif; font-style:italic; font-size:clamp(24px,4vw,34px); color:var(--moss-deep);
  animation:celebTextInOut 2.7s ease forwards}
@keyframes celebTextInOut{0%{opacity:0; transform:translateY(10px)}20%{opacity:1; transform:none}75%{opacity:1}100%{opacity:0; transform:translateY(-6px)}}
.petals{position:absolute; inset:0}
.petal{position:absolute; top:-6%; width:9px; height:9px; border-radius:60% 0 60% 0; background:var(--rose); opacity:.75;
  animation-name:petalFall; animation-timing-function:ease-in; animation-fill-mode:forwards}
.petal:nth-child(3n){background:var(--moss)}
.petal:nth-child(4n){background:var(--pollen)}
@keyframes petalFall{
  0%{transform:translateY(0) rotate(0deg); opacity:0}
  10%{opacity:.8}
  100%{transform:translateY(112vh) rotate(340deg); opacity:0}
}

/* shared */
.empty{display:flex; flex-direction:column; align-items:center; gap:6px; padding:30px 18px; text-align:center; color:var(--muted); font-size:13.5px;
  border:1px dashed var(--border2); border-radius:20px; font-style:italic; font-family:'Instrument Serif',serif}
.empty svg{width:82px; opacity:.9; animation:bob 4s ease-in-out infinite}
.eHill{stroke:var(--moss)} .eGround{stroke:var(--border2)} .eSun{fill:var(--pollen)}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@keyframes rise{from{opacity:0; transform:translateY(10px)}to{opacity:1; transform:none}}
.foot{text-align:center; color:var(--faint); font-size:12px; font-style:italic; font-family:'Instrument Serif',serif; padding:26px 0 8px; letter-spacing:.03em}
.toast{position:fixed; bottom:26px; left:50%; transform:translateX(-50%); background:var(--ink); color:var(--bg); display:flex; align-items:center; gap:12px;
  font-size:13px; font-weight:550; padding:11px 14px 11px 22px; border-radius:999px; box-shadow:var(--sh); animation:toastIn .3s ease both; z-index:70}
.toastUndo{border:1px solid color-mix(in srgb, var(--bg) 40%, transparent); background:transparent; color:var(--bg); font-size:12px; font-weight:700;
  padding:5px 13px; border-radius:999px; letter-spacing:.02em}
.toastUndo:hover{background:color-mix(in srgb, var(--bg) 15%, transparent)}
@keyframes toastIn{from{opacity:0; transform:translate(-50%,10px)}to{opacity:1; transform:translate(-50%,0)}}
button:focus-visible, input:focus-visible, textarea:focus-visible, [role="button"]:focus-visible{outline:2px solid var(--moss); outline-offset:3px; border-radius:8px}
::selection{background:color-mix(in srgb, var(--moss) 30%, transparent)}

/* responsive */
@media (max-width:900px){
  .hero{grid-template-columns:1fr; text-align:center}
  .heroText{display:flex; flex-direction:column; align-items:center}
  .grid{grid-template-columns:1fr}
  .orbStage{width:200px; height:200px}
  .orbStageBig{width:260px; height:260px}
  .orbStageBig .orb{width:170px; height:170px}
  .skelHero{grid-template-columns:1fr}
}
@media (max-width:560px){
  .top{flex-wrap:wrap; justify-content:space-between}
  .nav{order:3; width:100%; justify-content:center; margin-top:4px}
  .page{padding:20px 16px 0}
  h1{font-size:34px}
  .jHeroActions{margin-top:12px}
  .secHeadRight{width:100%; justify-content:space-between}
  .subPanel{margin-left:0}
}
/* daily affirmation — a larger, quieter line beneath the greeting */
.affirmation{margin:16px 0 2px; font-family:'Instrument Serif',serif; font-style:italic; font-size:clamp(17px,2vw,20px);
  line-height:1.5; color:var(--moss-deep); display:flex; align-items:baseline; gap:9px; max-width:42ch}
.affirmationMark{font-style:normal; font-size:12px; color:var(--season); flex:none; transform:translateY(-1px)}

/* memory recall — a quiet echo of a real past entry; tapping opens the journal */
.recall{margin:14px 0 2px; display:flex; align-items:flex-start; gap:9px; text-align:left;
  border:none; background:transparent; padding:0; cursor:pointer; max-width:46ch;
  color:var(--muted); animation:riseFade .6s ease both; transition:color .2s}
.recall:hover{color:var(--ink)}
.recallMark{flex:none; color:var(--moss); width:16px; height:16px; margin-top:1px}
.recallMark .leaf{width:16px; height:16px}
.recallText{font-size:14.5px; line-height:1.6}
.recallText b{font-weight:600; color:var(--moss-deep)}
.recallText em{font-family:'Instrument Serif',serif; font-style:italic; color:var(--ink)}
@media (max-width:900px){ .recall{justify-content:center; margin-left:auto; margin-right:auto; max-width:38ch} }

/* the garden — a featured, tinted card so it reads apart from the plain surfaces */
.gardenCard{position:relative; background:linear-gradient(165deg, color-mix(in srgb, var(--moss-soft) 55%, var(--surface)) 0%, var(--surface) 62%);
  border:1px solid var(--border); border-radius:22px; padding:16px 18px 14px; box-shadow:var(--sh-sm); display:flex; flex-direction:column; gap:10px; overflow:hidden}
.gardenHead{display:flex; align-items:center; justify-content:space-between; gap:10px}
.gardenTotal{font-size:11px; font-weight:600; color:var(--muted); font-variant-numeric:tabular-nums; white-space:nowrap}
.gardenScene{border-radius:14px; overflow:hidden}
.gardenSvg{width:100%; height:auto; display:block}
.gplant{transform-box:fill-box; transform-origin:bottom center; animation:gsway 5.5s ease-in-out infinite}
@keyframes gsway{0%,100%{transform:rotate(-2.2deg)}50%{transform:rotate(2.2deg)}}
.gardenCaption{margin:0; font-family:'Instrument Serif',serif; font-style:italic; font-size:14px; line-height:1.5; color:var(--muted)}

/* gratitude — three small things, a warm-tinted card */
.gratitudeCard{background:linear-gradient(160deg, color-mix(in srgb, var(--pollen-soft) 55%, var(--surface)) 0%, var(--surface) 62%);
  border:1px solid var(--border); border-radius:20px; padding:15px 18px; box-shadow:var(--sh-sm); display:flex; flex-direction:column; gap:11px}
.gratitudeLabel{margin:0; font-family:'Instrument Serif',serif; font-style:italic; font-size:16px; color:var(--ink)}
.gratitudeSlots{display:flex; flex-direction:column; gap:8px}
.gratInput{border:1px solid var(--border); background:var(--surface2); color:var(--ink); font:400 14px 'Instrument Sans'; padding:9px 14px; border-radius:12px; outline:none}
.gratInput:focus{border-color:var(--pollen)}
.gratInput::placeholder{color:var(--faint); font-style:italic; font-family:'Instrument Serif',serif}
.gratChip{display:flex; align-items:center; justify-content:space-between; gap:8px; background:var(--surface2); border:1px solid var(--border);
  border-radius:12px; padding:9px 12px 9px 14px; font-size:14px; color:var(--ink); animation:rise .3s ease both}
.gratChip button{border:none; background:transparent; color:var(--faint); font-size:16px; line-height:1; padding:0 4px; flex:none}
.gratChip button:hover{color:var(--rose-deep)}

@media (max-width:900px){ .affirmation{justify-content:center; text-align:center; margin-left:auto; margin-right:auto} }
/* ambient soundscapes */
.ambientCard{background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:16px 18px; box-shadow:var(--sh-sm); display:flex; flex-direction:column; gap:11px}
.ambientHead{display:flex; align-items:center; justify-content:space-between}
.ambientStop{border:1px solid var(--border); background:transparent; color:var(--muted); font-size:11px; font-weight:600; padding:4px 12px; border-radius:999px; transition:all .2s}
.ambientStop:hover{color:var(--rose-deep); border-color:var(--rose)}
.ambientRow{display:grid; grid-template-columns:1fr 1fr; gap:7px}
.ambientChip{position:relative; display:flex; align-items:center; gap:7px; border:1px solid var(--border); background:var(--surface2); color:var(--muted);
  font-size:12.5px; font-weight:550; padding:9px 13px; border-radius:12px; transition:all .2s}
.ambientChip:hover{border-color:var(--border2); color:var(--ink)}
.ambientIcon{font-size:14px}
.ambientChip.ambientOn{background:var(--moss-soft); border-color:var(--moss); color:var(--moss-deep)}
.ambientWave{position:absolute; right:11px; width:6px; height:6px; border-radius:50%; background:var(--moss); animation:ambientPulse 1.6s ease-in-out infinite}
@keyframes ambientPulse{0%,100%{opacity:.35; transform:scale(.8)}50%{opacity:1; transform:scale(1.15)}}
/* mood-adaptive atmosphere — overrides the time-of-day tint only when a mood is logged today.
   Placed after the [data-pod] rules so it wins by source order at equal specificity. */
.sk[data-mood="bright"]{ --atmos:#EDDA9E; --atmos-o:.34; }
.sk[data-mood="light"]{ --atmos:#F3C9A8; --atmos-o:.30; }
.sk[data-mood="steady"]{ --atmos:#BCD3AE; --atmos-o:.24; }
.sk[data-mood="foggy"]{ --atmos:#C4BCDD; --atmos-o:.16; }
.sk[data-mood="heavy"]{ --atmos:#8D84B5; --atmos-o:.20; }
/* heavier days ask for a calmer room: slow the breathing orb, soften the drift */
.sk[data-mood="heavy"] .orb, .sk[data-mood="foggy"] .orb{ animation-duration:8s }
.sk[data-mood="heavy"] .orbHalo{ animation-duration:64s; opacity:.5 }
.sk[data-mood="heavy"] .petal{ opacity:.55 }
/* now */
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.001s !important; transition-duration:.001s !important}
}

/* themed tooltips, replacing native browser title="" tooltips */
[data-tip]{position:relative}
[data-tip]:hover::after, [data-tip]:focus-visible::after{
  content:attr(data-tip);
  position:absolute; bottom:calc(100% + 9px); left:50%; transform:translateX(-50%);
  background:var(--ink); color:var(--bg); font:500 11.5px/1.4 'Instrument Sans';
  padding:6px 11px; border-radius:8px; white-space:nowrap;
  box-shadow:var(--sh-sm); z-index:80; pointer-events:none;
  animation:tipIn .15s ease both;
}
[data-tip]:hover::before, [data-tip]:focus-visible::before{
  content:""; position:absolute; bottom:calc(100% + 4px); left:50%; transform:translateX(-50%);
  border:5px solid transparent; border-top-color:var(--ink); z-index:80; pointer-events:none;
}
.tipWrap{display:inline-flex; position:relative}
@keyframes tipIn{from{opacity:0; transform:translateX(-50%) translateY(4px)}to{opacity:1; transform:translateX(-50%) translateY(0)}}

/* review week story */
.weekStory{background:var(--surface); border:1px solid var(--border); border-left:3px solid var(--moss); border-radius:18px; padding:16px 20px; box-shadow:var(--sh-sm); display:flex; flex-direction:column; gap:8px}
.weekStoryLine{margin:0; font-family:'Instrument Serif',serif; font-size:17px; line-height:1.55; color:var(--ink)}
.weekStoryClose{margin:4px 0 0; font-size:13px; font-style:italic; color:var(--muted)}

/* hero promise line */
.heroPromise{margin:12px 0 2px; font-size:15px; line-height:1.6; color:var(--muted); max-width:46ch}
.heroPromise b{color:var(--moss-deep); font-weight:650; font-variant-numeric:tabular-nums}
@media (max-width:900px){ .heroPromise{margin-left:auto; margin-right:auto; text-align:center} }

/* energy / tomorrow nudge — the same presence, noticing rather than remembering */
.energyNudge{display:flex; align-items:flex-start; gap:8px; max-width:46ch;
  font-family:'Instrument Serif',serif; font-style:italic; color:var(--moss-deep)}
.energyNudgeMark{flex:none; color:var(--moss); width:15px; height:15px; margin-top:2px}
.energyNudgeMark .leaf{width:15px; height:15px}
@media (max-width:900px){ .energyNudge{justify-content:center; text-align:center; margin-left:auto; margin-right:auto} }

.tinyWins{display:flex; flex-direction:column; gap:9px; margin-top:14px; animation:riseFade .5s ease both}
.tinyWinsLabel{margin:0 0 2px; font-size:11px; font-weight:650; letter-spacing:.08em; text-transform:uppercase; color:var(--faint)}
.tinyWinsRow{display:flex; flex-wrap:wrap; gap:8px}
.tinyWinChip{display:inline-flex; align-items:center; gap:7px; font-size:12.5px; font-weight:500; color:var(--moss-deep);
  background:var(--moss-soft); border:1px solid color-mix(in srgb, var(--moss) 30%, transparent); padding:6px 13px; border-radius:999px}
.tinyWinChip i{font-style:normal; font-size:11px}

/* garden butterflies */
.gflutter{transform-box:fill-box; transform-origin:center; animation:gflutterMove 6s ease-in-out infinite}
@keyframes gflutterMove{0%,100%{transform:translate(0,0) rotate(-4deg)}50%{transform:translate(7px,-9px) rotate(4deg)}}

/* seasonal accent — orthogonal tint, central-India calendar */
.sk[data-season="spring"]{ --season:#8FB86A; --season-soft:#E7F0DB; }
.sk[data-season="summer"]{ --season:#E0A54B; --season-soft:#F6EBD1; }
.sk[data-season="monsoon"]{ --season:#5E86A8; --season-soft:#DEE8EF; }
.sk[data-season="autumn"]{ --season:#C0764A; --season-soft:#F1E2D4; }
.sk[data-season="winter"]{ --season:#8093B8; --season-soft:#E4E9F1; }
.sk[data-theme="dusk"][data-season="spring"]{ --season-soft:#26311F; }
.sk[data-theme="dusk"][data-season="summer"]{ --season-soft:#332916; }
.sk[data-theme="dusk"][data-season="monsoon"]{ --season-soft:#1E2A33; }
.sk[data-theme="dusk"][data-season="autumn"]{ --season-soft:#33231A; }
.sk[data-theme="dusk"][data-season="winter"]{ --season-soft:#232838; }
.seasonTag{color:var(--season); font-weight:650; text-transform:capitalize; letter-spacing:.04em}

/* the aging tree sways slower and gentler than the day's sprouts */
.gtree{transform-box:fill-box; transform-origin:bottom center; animation:gsway 7.5s ease-in-out infinite}
/* motion polish — gentle staggered entrances; the global reduced-motion guard already covers these */
@keyframes riseFade{from{opacity:0; transform:translateY(9px)}to{opacity:1; transform:none}}

.heroText > *{animation:riseFade .55s cubic-bezier(.22,1,.36,1) both}
.heroText > *:nth-child(1){animation-delay:.02s}
.heroText > *:nth-child(2){animation-delay:.09s}
.heroText > *:nth-child(3){animation-delay:.16s}
.heroText > *:nth-child(4){animation-delay:.23s}
.heroText > *:nth-child(5){animation-delay:.30s}
.heroText > *:nth-child(6){animation-delay:.37s}
.heroText > *:nth-child(7){animation-delay:.44s}
.heroText > *:nth-child(8){animation-delay:.51s}
.heroText > *:nth-child(9){animation-delay:.58s}

.side > *{animation:riseFade .5s cubic-bezier(.22,1,.36,1) both}
.side > *:nth-child(1){animation-delay:.06s}
.side > *:nth-child(2){animation-delay:.13s}
.side > *:nth-child(3){animation-delay:.20s}
.side > *:nth-child(4){animation-delay:.27s}
.side > *:nth-child(5){animation-delay:.34s}
.side > *:nth-child(6){animation-delay:.41s}
.side > *:nth-child(7){animation-delay:.48s}
.gcloud{transform-box:view-box; animation:gdrift 26s ease-in-out infinite}
@keyframes gdrift{0%,100%{transform:translateX(0)}50%{transform:translateX(14px)}}
/* journal companion — a quiet presence under an entry */
.reflectBtn{margin-top:12px; border:1px dashed var(--border2); background:transparent; color:var(--muted); font-size:12px; font-weight:600; font-style:italic; font-family:'Instrument Serif',serif; padding:7px 15px; border-radius:999px; transition:all .2s}
.reflectBtn:hover:not(:disabled){border-style:solid; border-color:var(--moss); color:var(--moss-deep); background:var(--moss-soft)}
.reflectBtn:disabled{opacity:.6; cursor:default}
.companionLine{display:flex; align-items:flex-start; gap:10px; margin-top:14px; padding:13px 16px; background:var(--moss-soft); border-radius:14px; animation:riseFade .6s ease both}
.companionMark{flex:none; color:var(--moss); width:18px; height:18px; margin-top:1px}
.companionMark .leaf{width:18px; height:18px}
.companionLine p{margin:0; font-family:'Instrument Serif',serif; font-style:italic; font-size:15px; line-height:1.6; color:var(--moss-deep)}
.companionCare{background:var(--lilac-soft); border:1px solid color-mix(in srgb, var(--lilac) 40%, var(--border)); flex-direction:column; gap:6px}
.companionCare p{color:var(--ink); font-style:normal; font-family:'Instrument Sans'; font-size:14px}
/* companion memory — consent pill + the reveal */
.memoryPillOn{background:var(--lilac-soft); border-color:var(--lilac); color:var(--lilac)}
.memoryCard{border:1px solid color-mix(in srgb, var(--lilac) 30%, var(--border)); background:color-mix(in srgb, var(--lilac-soft) 55%, var(--surface)); border-radius:16px; overflow:hidden; animation:riseFade .5s ease both}
.memoryReveal{width:100%; display:flex; align-items:center; justify-content:space-between; gap:10px; border:none; background:transparent; padding:13px 16px; font-family:'Instrument Serif',serif; font-style:italic; font-size:14.5px; color:var(--lilac); text-align:left}
.memoryChevron{transition:transform .2s; font-style:normal}
.memoryChevronOpen{transform:rotate(90deg)}
.memoryBody{padding:0 16px 14px; display:flex; flex-direction:column; gap:10px}
.memoryText{margin:0; font-size:13.5px; line-height:1.7; color:var(--ink); white-space:pre-wrap}
.memoryForget{align-self:flex-start; border:1px solid var(--border); background:var(--surface); color:var(--muted); font-size:11.5px; font-weight:600; padding:6px 13px; border-radius:999px; transition:all .2s}
.memoryForget:hover{color:var(--rose-deep); border-color:var(--rose)}

.memoryFacts{font-size:12px; color:var(--muted)}
.memoryFacts summary{cursor:pointer; font-family:'Instrument Serif',serif; font-style:italic; padding:2px 0}
.memoryFactsText{margin:8px 0 0; font:400 12px/1.7 'Instrument Sans'; color:var(--muted); white-space:pre-wrap; background:var(--surface2); border-radius:10px; padding:10px 12px}

/* weekly letter — correspondence, not a dashboard */
.letterCard{position:relative; background:linear-gradient(168deg, color-mix(in srgb, var(--pollen-soft) 45%, var(--surface)) 0%, var(--surface) 70%);
  border:1px solid var(--border); border-radius:22px; padding:26px 28px 24px; box-shadow:var(--sh); display:flex; flex-direction:column; gap:14px; overflow:hidden; animation:riseFade .6s ease both}
.letterEyebrow{margin:0; font-size:11px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--pollen)}
.letterBody{margin:0; font-family:'Instrument Serif',serif; font-size:18px; line-height:1.7; color:var(--ink)}
.letterSeal{align-self:flex-end; width:24px; height:24px; color:var(--moss); opacity:.7}
.letterSeal .leaf{width:24px; height:24px}
/* letter archive — a quiet shelf of past letters */
.archiveCard{border:1px solid var(--border); background:color-mix(in srgb, var(--pollen-soft) 30%, var(--surface)); border-radius:16px; overflow:hidden}
.archiveHead{width:100%; display:flex; align-items:center; justify-content:space-between; gap:10px; border:none; background:transparent; padding:13px 18px; font-size:13px; font-weight:600; color:var(--muted)}
.archiveHead b{color:var(--ink); font-variant-numeric:tabular-nums}
.archiveChevron{transition:transform .2s; color:var(--faint)}
.archiveChevronOpen{transform:rotate(90deg)}
.archiveList{padding:0 18px 16px; display:flex; flex-direction:column; gap:16px}
.archiveItem{padding-top:14px; border-top:1px solid var(--border)}
.archiveItemLabel{margin:0 0 8px; font-size:10.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--pollen)}
.archiveItemBody{margin:0 0 6px; font-family:'Instrument Serif',serif; font-size:15px; line-height:1.65; color:var(--ink)}
/* time field — fully custom, matches Sukoon open and closed */
.timeField{position:relative; display:inline-flex; align-items:center; gap:2px; padding:4px 6px; border:1px solid var(--border); border-radius:999px; background:var(--surface); transition:border-color .2s, background .2s}
.timeField.timeFieldSet{border-color:color-mix(in srgb, var(--moss) 40%, var(--border)); background:var(--moss-soft)}
.timeSlot{border:none; background:transparent; font-family:'Instrument Serif',serif; font-size:15px; color:var(--ink); padding:2px 6px; border-radius:8px; cursor:pointer; min-width:22px; text-align:center; transition:background .15s}
.timeSlot:hover{background:color-mix(in srgb, var(--moss) 14%, transparent)}
.timeColon{font-family:'Instrument Serif',serif; font-size:15px; color:var(--muted); margin:0 -1px}
.timeAmpm{border:none; background:transparent; font-family:'Satoshi',sans-serif; font-size:11px; font-weight:700; letter-spacing:.06em; color:var(--moss-deep); padding:4px 8px; border-radius:999px; cursor:pointer; transition:background .15s}
.timeAmpm:hover{background:color-mix(in srgb, var(--moss) 16%, transparent)}
.timeClear{border:none; background:transparent; color:var(--faint); font-size:15px; line-height:1; padding:2px 5px; border-radius:999px; cursor:pointer; transition:color .15s, background .15s}
.timeClear:hover{color:var(--rose-deep); background:color-mix(in srgb, var(--rose) 14%, transparent)}

.timePop{position:absolute; top:calc(100% + 8px); left:0; z-index:90;
  display:grid; grid-template-columns:repeat(3, 1fr); gap:2px;
  max-height:184px; overflow-y:auto; padding:8px;
  background:var(--surface); border:1px solid var(--border); border-radius:14px;
  box-shadow:0 10px 30px rgba(0,0,0,.12); animation:tipIn .16s ease both;
  scrollbar-width:thin; scrollbar-color:var(--border) transparent}
.timePop::-webkit-scrollbar{width:7px}
.timePop::-webkit-scrollbar-thumb{background:var(--border); border-radius:99px}
.timeOpt{border:none; background:transparent; font-family:'Instrument Serif',serif; font-size:14px; color:var(--ink); padding:7px 0; border-radius:8px; cursor:pointer; transition:background .12s, color .12s}
.timeOpt:hover{background:color-mix(in srgb, var(--moss) 16%, transparent)}
.timeOptOn{background:var(--moss); color:var(--bg); font-weight:600}
/* ── premium icon system — stroke glyphs, palette-tinted, replace the emoji chrome ── */
.ic{width:16px;height:16px;display:block;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.rowIcon{display:inline-grid;place-items:center;border-radius:999px}
.rowIcon svg{pointer-events:none}
.recurMark{display:inline-grid;place-items:center;vertical-align:-2px;margin-right:6px}
.recurMark .ic{width:12.5px;height:12.5px}
.recurBadge{gap:5px}
.recurBadge .ic{width:13px;height:13px}
.cat{display:inline-flex;align-items:center;gap:6px}
.cat .ic{width:14px;height:14px}
.somedayHead span:first-child{display:inline-flex;align-items:center;gap:7px}
.somedayHead .ic{width:15px;height:15px}

/* ── action cluster — right-aligned, tight, revealed on hover as one calm group ── */
.rowActions{display:inline-flex;align-items:center;gap:3px;margin-left:auto;flex:none}
.rowActions .rowIcon:hover{background:color-mix(in srgb, var(--moss) 12%, transparent)}

/* one calm line: the text yields, never the badges */
.row .rowTag, .row .rowTagInput, .row .timeBadge, .row .stepsBadge,
.row .tag, .row .energyBadge{flex:none}
/* the two state badges read as a pair: how heavy, what kind */
.row .energyBadge{margin-right:-6px}

@media (hover:hover){
  .row .rowActions{max-width:0;opacity:0;overflow:hidden;pointer-events:none;transition:max-width .25s ease,opacity .2s ease}
  .row:not(.editing):hover .rowActions,
  .row:not(.editing):focus-within .rowActions{max-width:300px;opacity:1;overflow:visible;pointer-events:auto}
}

/* ── editing: field owns the line, everything else steps aside ── */
.row.editing{flex-wrap:nowrap}
.row.editing .rowEdit{flex:1 1 auto;min-width:0}
.row.editing .rowTag,
.row.editing .rowTagInput,
.row.editing .stepsBadge,
.row.editing .timeBadge,
.row.editing .tag,
.row.editing .rowIcon,
.row.editing .rowActions{display:none}

.thoughtCard{background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:16px 18px; box-shadow:var(--sh-sm); display:flex; flex-direction:column; gap:10px}
.thoughtLabel{margin:0; font-family:'Instrument Serif',serif; font-style:italic; font-size:14px; color:var(--muted)}
.thoughtRow{display:flex; gap:8px; align-items:center}
.thoughtRow input{flex:1; border:1px solid var(--border); background:var(--surface2); color:var(--ink); font-size:13.5px; padding:9px 13px; border-radius:999px; outline:none}
.thoughtRow input:focus{border-color:var(--lilac)}
.thoughtRow input::placeholder{color:var(--faint); font-style:italic; font-family:'Instrument Serif',serif}
.thoughtSave{border:none; background:var(--ink); color:var(--bg); font-size:12.5px; font-weight:600; padding:8px 16px; border-radius:999px; flex:none}
.pThoughtTag{font-size:10.5px; font-weight:650; color:var(--lilac); letter-spacing:.03em}
.focusCard{background:linear-gradient(160deg, color-mix(in srgb, var(--pollen-soft) 60%, var(--surface)) 0%, var(--surface) 70%);
  border:1px solid color-mix(in srgb, var(--pollen) 35%, var(--border)); border-radius:20px; padding:14px 18px; box-shadow:var(--sh-sm);
  display:flex; flex-direction:column; gap:10px; margin-top:24px; animation:riseFade .5s ease both}
.focusHead{display:flex; align-items:center; justify-content:space-between}
.focusLabel{font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--pollen)}
.focusClear{border:none; background:transparent; color:var(--faint); font-size:16px; line-height:1; padding:2px 7px; border-radius:8px; transition:all .18s}
.focusClear:hover{color:var(--rose-deep); background:var(--rose-soft)}
.focusRow{display:flex; align-items:center; gap:12px; border:none; background:transparent; text-align:left; padding:0; width:100%}
.focusTick{width:28px; height:28px; flex:none; border-radius:50%; border:1.5px solid var(--pollen); display:grid; place-items:center; transition:all .2s}
.focusTick svg{width:14px; height:14px; stroke:var(--bg); stroke-dasharray:24; stroke-dashoffset:24}
.focusRow:hover .focusTick{background:color-mix(in srgb, var(--pollen) 18%, transparent)}
.focusText{font-family:'Instrument Serif',serif; font-style:italic; font-size:19px; line-height:1.4; color:var(--ink)}
.rowIcon.focusOn{opacity:1; color:var(--pollen)}

/* ritual bundles — a few intentions laid down together in one gentle motion */
.ritualCard{display:flex; flex-direction:column; gap:10px; padding:2px 2px 4px}
.ritualLabel{margin:0; font-size:12px; font-weight:600; letter-spacing:.04em; color:var(--faint)}
.ritualRow{display:flex; flex-wrap:wrap; gap:9px}
.ritualChip{display:flex; align-items:center; gap:10px; border:1px solid var(--border); background:var(--surface);
  padding:10px 16px; border-radius:16px; transition:all .2s; box-shadow:var(--sh-sm); text-align:left}
.ritualChip:hover{border-color:var(--moss); background:var(--moss-soft); transform:translateY(-1px)}
.ritualChip:active{transform:scale(.97)}
.ritualIcon{font-size:19px; flex:none}
.ritualText{display:flex; flex-direction:column; gap:1px}
.ritualText b{font-size:13.5px; font-weight:600; color:var(--ink)}
.ritualText small{font-size:11px; color:var(--muted); font-style:italic; font-family:'Instrument Serif',serif}
@media (max-width:560px){ .ritualRow{flex-direction:column} .ritualChip{width:100%} }
.cat.energy.catOn{background:var(--surface2); border-color:var(--border2)}
.energyBadge{font-size:13px; opacity:1}
.authWrap{min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--bg)}
.authCard{width:100%; max-width:420px; background:var(--surface); border:1px solid var(--border); border-radius:24px;
  padding:34px 32px; box-shadow:var(--sh-sm); display:flex; flex-direction:column; gap:14px; animation:rise .5s ease both}
.authTitle{margin:0; font-family:'Instrument Serif',serif; font-size:clamp(26px,4vw,32px); font-weight:400; line-height:1.25; color:var(--ink)}
.authTitle em{font-style:italic}
.authSub{margin:0; font-size:14.5px; line-height:1.65; color:var(--muted); max-width:38ch}
.authInput{margin-top:6px; width:100%; font:400 15px 'Instrument Sans'; color:var(--ink); background:var(--surface2);
  border:1px solid var(--border); border-radius:14px; padding:13px 16px; outline:none; transition:border-color .2s}
.authInput:focus{border-color:var(--moss)}
.authInput::placeholder{color:var(--faint)}
.authInput:disabled{opacity:.6}
.authBtn{margin-top:2px; border:none; background:var(--ink); color:var(--bg); font:600 14.5px 'Instrument Sans';
  padding:13px 18px; border-radius:14px; transition:opacity .2s, transform .15s}
.authBtn:hover:not(:disabled){transform:translateY(-1px)}
.authBtn:disabled{opacity:.45}
.authGhost{align-self:flex-start; border:none; background:transparent; color:var(--muted); font-size:12.5px;
  font-family:'Instrument Serif',serif; font-style:italic; padding:4px 0; text-decoration:underline; text-underline-offset:3px}
.authErr{margin:0; font-size:13px; color:var(--rose-deep)}
`;
