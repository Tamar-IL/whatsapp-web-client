/**
 * WhatsApp-style voice/audio player.
 *
 * Custom controls (circular play/pause, a progress track, elapsed/total time)
 * instead of the browser's default <audio controls>, to match the WhatsApp look.
 */
import { useRef, useState } from 'react';

function fmt(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AudioPlayer({ src, onError }: { src: string; onError?: () => void }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.pause();
    else void a.play();
  }

  function onSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const a = audioRef.current;
    if (!a) return;
    const t = Number(e.target.value);
    a.currentTime = t;
    setCurrent(t);
  }

  const pct = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-black/[0.03] px-2 py-1.5">
      <button
        type="button"
        onClick={toggle}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-primary text-white"
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current"><path d="M8 5v14l11-7z" /></svg>
        )}
      </button>

      <div className="flex min-w-[140px] flex-1 flex-col">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step="0.1"
          value={current}
          onChange={onSeek}
          className="h-1 w-full cursor-pointer appearance-none rounded-full"
          style={{
            background: `linear-gradient(to right, var(--c-brand-action) ${pct}%, rgba(0,0,0,0.15) ${pct}%)`,
          }}
        />
        <div className="mt-1 text-[10px] text-ink-muted">
          {fmt(current)} {duration ? `/ ${fmt(duration)}` : ''}
        </div>
      </div>

      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onTimeUpdate={(e) => setCurrent((e.target as HTMLAudioElement).currentTime)}
        onLoadedMetadata={(e) => setDuration((e.target as HTMLAudioElement).duration)}
        onError={onError}
      />
    </div>
  );
}
