// ffprobe-static ships no type declarations. It exports the bundled binary path.
declare module 'ffprobe-static' {
  const ffprobe: { path: string; version?: string };
  export = ffprobe;
}
