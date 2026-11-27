/**
 * WhatsApp-style voice/audio player.
 *
 * Custom controls (circular play/pause, a progress track, elapsed/total time)
 * instead of the browser's default <audio controls>, to match the WhatsApp look.
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
          value={current}
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
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onTimeUpdate={(e) => setCurrent((e.target as HTMLAudioElement).currentTime)}
        onLoadedMetadata={(e) => {
          const a = e.target as HTMLAudioElement;
          setDuration(a.duration);
          a.playbackRate = speed;
        }}
        onError={onError}
      />
    </div>
  );
}
