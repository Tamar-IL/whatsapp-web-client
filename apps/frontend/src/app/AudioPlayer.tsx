/**
 * WhatsApp-style voice/audio player.
 *
 * Custom controls (circular play/pause, a progress track, elapsed/total time)
 * instead of the browser's default <audio controls>, to match the WhatsApp look.
 *
 * Accurate progress: WhatsApp voice notes (Ogg/Opus) carry no duration in
 * their header, so with only the metadata loaded the browser GUESSES the
 * length — the bar crawled and then jumped to the end on the first play, and
 * only behaved on the second (by then the whole file was known). Now the file
 * is downloaded in full before the first play and its exact length is
 * measured by decoding it, so the very first play is already correct.
 */
import { useEffect, useRef, useState } from 'react';
import { EmailMediaButton } from './EmailMediaButton';
import { useAppData } from './AppData';

/** Speeds the 1×/1.5×/2× pill cycles through, like WhatsApp. */
const SPEEDS = [1, 1.5, 2];

function fmt(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AudioPlayer({
  src,
  messageId,
  onError,
}: {
  src: string;
  messageId: string;
  onError?: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [exact, setExact] = useState(false);
  const [playSrc, setPlaySrc] = useState(src);
  const [loadingFull, setLoadingFull] = useState(false);
  const blobUrl = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  /** True once the length was measured by decoding — then the element's guess is ignored. */
  const measured = useRef(false);

  // New message → start over with the plain URL; free the previous blob.
  useEffect(() => {
    setPlaySrc(src);
    setExact(false);
    measured.current = false;
    setDuration(0);
    setCurrent(0);
    return () => {
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
      blobUrl.current = null;
    };
  }, [src]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  /** Download the whole file and measure its real length. Returns false on failure. */
  async function loadFull(): Promise<boolean> {
    if (exact) return true;
    setLoadingFull(true);
    try {
      const res = await fetch(src, { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const bytes = await res.arrayBuffer();
      const blob = new Blob([bytes], { type: res.headers.get('content-type') ?? 'audio/ogg' });
      let real = 0;
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        const decoded = await ctx.decodeAudioData(bytes.slice(0));
        real = decoded.duration;
        void ctx.close();
      } catch {
        // Some formats can't be decoded here; the fully-loaded element still reports it right.
      }
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
      blobUrl.current = URL.createObjectURL(blob);
      if (real > 0) {
        measured.current = true;
        setDuration(real);
      }
      setExact(true);
      setPlaySrc(blobUrl.current);
      return true;
    } catch {
      return false;
    } finally {
      setLoadingFull(false);
    }
  }

  /** Smooth progress while playing (timeupdate alone fires only ~4×/s). */
  function tick() {
    const a = audioRef.current;
    if (a) setCurrent(a.currentTime);
    rafRef.current = requestAnimationFrame(tick);
  }
  const { settings, features } = useAppData();
  const defaultSpeed = settings?.audio.defaultSpeed ?? 1;
  const [speed, setSpeed] = useState(defaultSpeed);

  // Follow the default from Settings until the operator picks a speed here.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setSpeed(defaultSpeed);
  }, [defaultSpeed]);

  // playbackRate resets when the element reloads its source, so re-apply it.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  function cycleSpeed() {
    touched.current = true;
    setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length] ?? 1);
  }

  async function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      return;
    }
    if (!exact) {
      const resumeAt = a.currentTime;
      const ok = await loadFull();
      if (ok) {
        // React swaps the src; wait for the element to load it, then play from the same spot.
        await new Promise((r) => requestAnimationFrame(r));
        const el = audioRef.current;
        if (!el) return;
        await new Promise<void>((resolve) => {
          if (el.readyState >= 1) return resolve();
          el.addEventListener('loadedmetadata', () => resolve(), { once: true });
        });
        el.currentTime = resumeAt;
        el.playbackRate = speed;
        void el.play();
        return;
      }
    }
    void a.play();
  }

  function onSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const a = audioRef.current;
    if (!a) return;
    const t = Number(e.target.value);
    a.currentTime = t;
    setCurrent(t);
  }

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-black/[0.03] px-2 py-1.5">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={loadingFull}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-primary text-white disabled:opacity-70"
        title={playing ? 'Pause' : 'Play'}
      >
        {loadingFull ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
        ) : playing ? (
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><path d="M8 5v14l11-7z" /></svg>
        )}
      </button>

      {features.playbackSpeed && (
        <button
          type="button"
          onClick={cycleSpeed}
          title="Playback speed"
          className={
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums transition ' +
            (speed !== 1 ? 'bg-brand-link text-white' : 'bg-black/10 text-ink-muted hover:bg-black/15')
          }
        >
          {speed}×
        </button>
      )}

      <div className="flex min-w-[140px] flex-1 flex-col">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step="0.1"
          value={Math.min(current, duration || current)}
          onChange={onSeek}
          className="wa-range w-full cursor-pointer"
          style={{
            background: `linear-gradient(to right, #8696a0 ${pct}%, rgba(0,0,0,0.15) ${pct}%)`,
          }}
        />
        <div className="mt-1 flex items-center justify-between text-[10px] text-ink-muted">
          <span>{fmt(current)} {duration ? `/ ${fmt(duration)}` : ''}</span>
          <EmailMediaButton messageId={messageId} label="email" />
        </div>
      </div>

      <audio
        ref={audioRef}
        src={playSrc}
        preload="metadata"
        onPlay={() => {
          setPlaying(true);
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(tick);
        }}
        onPause={() => {
          setPlaying(false);
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }}
        onEnded={() => {
          setPlaying(false);
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
          setCurrent(0);
        }}
        onTimeUpdate={(e) => !rafRef.current && setCurrent((e.target as HTMLAudioElement).currentTime)}
        onLoadedMetadata={(e) => {
          const a = e.target as HTMLAudioElement;
          // Keep a measured length; otherwise take the element's (possibly estimated) one.
          if (!measured.current && isFinite(a.duration)) setDuration(a.duration);
          a.playbackRate = speed;
        }}
        onDurationChange={(e) => {
          const d = (e.target as HTMLAudioElement).duration;
          if (!measured.current && isFinite(d) && d > 0) setDuration(d);
        }}
        onError={onError}
      />
    </div>
  );
}
