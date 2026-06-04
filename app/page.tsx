'use client';

import { useRef, useState, useCallback } from 'react';

type Stage = 'idle' | 'loading-ffmpeg' | 'extracting' | 'chunking' | 'transcribing' | 'done' | 'error';

interface Segment { start: number; end: number; text: string; }
interface Result  { text: string; segments: Segment[]; }

const CHUNK_MAX_BYTES  = 24 * 1024 * 1024; // Groq 25 MB limit
const SEGMENT_SECONDS  = 600;               // 10-min chunks
// FFmpeg (MEMFS) is seekable → handles .mov/moov-at-end files fine up to ~1 GB browser memory
const LARGE_FILE_BYTES = 1 * 1024 * 1024 * 1024; // > 1 GB falls back to Web Audio
const FFMPEG_CDN       = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
const LARGE_FILE_SPEED = 2;               // 2× — accuracy over speed; Whisper handles 2× speech with full accuracy
const ACCEPTED = '.mp4,.mkv,.mov,.avi,.webm,.m4v,.flv,.wmv,.ts,.mpeg,.mpg';

/* ─── Large-file audio extraction via AudioContext ──────────────────────────
   Routes video audio through an AudioContext (not connected to speakers) so
   MediaRecorder captures it cleanly. Never loads the file into memory.
   Runs at LARGE_FILE_SPEED× — Whisper handles up to ~2× speech accurately. */
async function extractAudioViaWebAudio(
  file: File,
  segSecs: number,
  onProgress: (frac: number) => void,
  onStatus: (msg: string) => void,
): Promise<{ blob: Blob; name: string }[]> {
  const videoUrl = URL.createObjectURL(file);
  const video    = document.createElement('video');
  video.preload  = 'metadata';
  video.src      = videoUrl;

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(
      new Error(`Cannot load video: ${video.error?.message ?? 'unknown'}`));
    setTimeout(() => reject(new Error('Video metadata load timed out')), 30_000);
  });

  const totalDur = video.duration;
  if (!isFinite(totalDur) || totalDur <= 0)
    throw new Error('Could not read video duration.');

  // Build AudioContext pipeline: video → source → dest (NOT → destination = no speakers)
  const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext;
  const audioCtx = new AudioCtx();

  // resume() MUST be called — AudioContext starts suspended even inside a click handler
  // once execution crosses an async boundary (awaiting metadata above).
  await audioCtx.resume();
  if (audioCtx.state !== 'running')
    throw new Error('AudioContext could not start. Try clicking Transcribe again.');

  const source = audioCtx.createMediaElementSource(video);
  const dest   = audioCtx.createMediaStreamDestination();
  source.connect(dest); // intentionally NOT connected to audioCtx.destination

  const mimeType = [
    'audio/webm;codecs=opus', 'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4;codecs=aac', 'audio/mp4',
  ].find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) ?? '';

  const ext      = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  const segCount = Math.ceil(totalDur / segSecs);
  const estMin   = Math.ceil((totalDur / LARGE_FILE_SPEED) / 60);
  const results: { blob: Blob; name: string }[] = [];

  for (let i = 0; i < segCount; i++) {
    const segStart = i * segSecs;
    const segEnd   = Math.min((i + 1) * segSecs, totalDur);

    onStatus(segCount > 1
      ? `Extracting audio ${Math.round(segStart / 60)}–${Math.round(segEnd / 60)} min ` +
        `(${i + 1}/${segCount}, ~${estMin} min total at ${LARGE_FILE_SPEED}×)…`
      : `Extracting audio (~${estMin} min at ${LARGE_FILE_SPEED}× speed)…`);

    const segBlob = await new Promise<Blob>((resolve, reject) => {
      // Use dest.stream directly — same AudioContext output, stays live across seeks
      const recorder = new MediaRecorder(dest.stream, {
        mimeType: mimeType || undefined,
        audioBitsPerSecond: 32_000,
      });
      const parts: BlobPart[] = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) parts.push(e.data); };
      recorder.onstop  = () => resolve(new Blob(parts, { type: mimeType || 'audio/webm' }));
      recorder.onerror = (e: any) => reject(e.error ?? new Error('MediaRecorder error'));

      // Seek first; only start recording after seeked fires so no silence at the start
      video.currentTime = segStart;
      video.onseeked = () => {
        video.onseeked    = null;
        video.playbackRate = LARGE_FILE_SPEED;
        recorder.start(500);
        video.play().catch(reject);
      };

      const poll = setInterval(() => {
        const frac = (i + Math.max(0, (video.currentTime - segStart) / (segEnd - segStart))) / segCount;
        onProgress(frac);
        if (video.currentTime >= segEnd - 0.05 || video.ended) {
          clearInterval(poll);
          video.pause();
          if (recorder.state === 'recording') recorder.stop();
        }
      }, 300);

      // Safety: segment real-time duration + 30 s buffer
      setTimeout(() => {
        clearInterval(poll);
        video.pause();
        if (recorder.state === 'recording') recorder.stop();
      }, ((segEnd - segStart) / LARGE_FILE_SPEED) * 1000 + 30_000);
    });

    results.push({ blob: segBlob, name: `seg_${i}.${ext}` });
  }

  video.src = '';
  URL.revokeObjectURL(videoUrl);
  await audioCtx.close();
  return results;
}

/* ─── Page component ────────────────────────────────────────────────────── */
export default function Home() {
  const ffmpegRef = useRef<any>(null);
  const [stage,        setStage]        = useState<Stage>('idle');
  const [progress,     setProgress]     = useState(0);
  const [statusMsg,    setStatusMsg]    = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [result,       setResult]       = useState<Result | null>(null);
  const [error,        setError]        = useState('');
  const [isDragging,   setIsDragging]   = useState(false);
  const [showSegments, setShowSegments] = useState(false);
  const [copied,       setCopied]       = useState(false);

  /* ── FFmpeg lazy-loader (single-threaded core — only used for small files) */
  const ensureFFmpeg = useCallback(async () => {
    if (ffmpegRef.current) return ffmpegRef.current as any;
    const { FFmpeg }    = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({
      coreURL: await toBlobURL(`${FFMPEG_CDN}/ffmpeg-core.js`,   'text/javascript'),
      wasmURL: await toBlobURL(`${FFMPEG_CDN}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpegRef.current = ffmpeg;
    return ffmpeg;
  }, []);

  /* ── File selection ────────────────────────────────────── */
  const handleFile = useCallback((file: File) => {
    setSelectedFile(file); setResult(null);
    setError(''); setStage('idle'); setProgress(0); setShowSegments(false);
  }, []);

  /* ── Groq API proxy call ───────────────────────────────── */
  const transcribeChunk = async (blob: Blob, name: string) => {
    const fd = new FormData();
    fd.append('file', blob, name);
    const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Server error ${res.status}`);
    }
    return res.json() as Promise<{ text: string; segments: Segment[] }>;
  };

  /* ── Main pipeline ─────────────────────────────────────── */
  const handleTranscribe = useCallback(async () => {
    if (!selectedFile) return;
    setError(''); setResult(null); setProgress(0);

    try {
      let chunks: { blob: Blob; name: string }[];
      const isLarge = selectedFile.size > LARGE_FILE_BYTES;

      /* ── Path A: small files (<= 200 MB) — FFmpeg.wasm ── */
      if (!isLarge) {
        setStage('loading-ffmpeg');
        setStatusMsg('Loading audio processor (one-time, ~10 MB)…');
        const ffmpeg = await ensureFFmpeg();
        const { fetchFile } = await import('@ffmpeg/util');

        setStage('extracting');
        setStatusMsg('Extracting & compressing audio…');
        setProgress(5);

        const ext = (selectedFile.name.split('.').pop() ?? 'mp4')
          .toLowerCase().replace(/[^a-z0-9]/g, '');
        const inputName = `input.${ext}`;

        ffmpeg.on('progress', ({ progress: p }: { progress: number }) =>
          setProgress(5 + Math.round(p * 48)));

        await ffmpeg.writeFile(inputName, await fetchFile(selectedFile));
        await ffmpeg.exec([
          '-i', inputName, '-vn',
          '-acodec', 'libmp3lame', '-ar', '16000', '-ac', '1', '-b:a', '32k',
          'full_audio.mp3',
        ]);
        ffmpeg.off('progress');
        await ffmpeg.deleteFile(inputName).catch(() => {});

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fullAudio = new Uint8Array((await ffmpeg.readFile('full_audio.mp3') as any).buffer as ArrayBuffer);
        await ffmpeg.deleteFile('full_audio.mp3').catch(() => {});
        setProgress(55);

        if (fullAudio.byteLength > CHUNK_MAX_BYTES) {
          setStage('chunking');
          setStatusMsg('Splitting long audio into segments…');
          await ffmpeg.writeFile('full_audio.mp3', fullAudio);
          await ffmpeg.exec([
            '-i', 'full_audio.mp3', '-f', 'segment',
            '-segment_time', String(SEGMENT_SECONDS), '-c', 'copy', 'chunk_%03d.mp3',
          ]);
          await ffmpeg.deleteFile('full_audio.mp3').catch(() => {});
          chunks = [];
          let ci = 0;
          while (true) {
            const cname = `chunk_${String(ci).padStart(3, '0')}.mp3`;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const raw = new Uint8Array((await ffmpeg.readFile(cname) as any).buffer as ArrayBuffer);
              chunks.push({ blob: new Blob([raw.buffer], { type: 'audio/mpeg' }), name: `chunk_${ci}.mp3` });
              await ffmpeg.deleteFile(cname).catch(() => {});
              ci++;
            } catch { break; }
          }
        } else {
          chunks = [{ blob: new Blob([fullAudio.buffer], { type: 'audio/mpeg' }), name: 'audio.mp3' }];
        }

      /* ── Path B: large files (> 200 MB) — Web Audio API ── */
      } else {
        setStage('extracting');
        setProgress(5);
        chunks = await extractAudioViaWebAudio(
          selectedFile, SEGMENT_SECONDS,
          frac => setProgress(5 + Math.round(frac * 55)),
          msg  => setStatusMsg(msg),
        );
      }

      setProgress(60);

      /* ── Transcribe all chunks via Groq ─────────────────── */
      setStage('transcribing');
      let combinedText = '';
      const allSegments: Segment[] = [];
      let segOffset = 0;

      for (let i = 0; i < chunks.length; i++) {
        setStatusMsg(chunks.length > 1
          ? `Transcribing segment ${i + 1} / ${chunks.length}…`
          : 'Transcribing with Groq Whisper…');
        setProgress(60 + Math.round((i / chunks.length) * 38));

        const r = await transcribeChunk(chunks[i].blob, chunks[i].name);
        if (combinedText && !combinedText.endsWith(' ')) combinedText += ' ';
        combinedText += r.text;
        for (const seg of r.segments ?? [])
          allSegments.push({ ...seg, start: seg.start + segOffset, end: seg.end + segOffset });
        if (chunks.length > 1) segOffset += SEGMENT_SECONDS;
      }

      setProgress(100);
      setResult({ text: combinedText.trim(), segments: allSegments });
      setStage('done');
      setStatusMsg('');

    } catch (e: any) {
      const msg = (e instanceof Error && e.message) ? e.message
        : typeof e === 'string' ? e
        : e?.message ?? 'Something went wrong.';
      setError(msg);
      setStage('error');
    }
  }, [selectedFile, ensureFFmpeg]);

  /* ── Helpers ───────────────────────────────────────────── */
  const downloadTxt = useCallback(() => {
    if (!result) return;
    const blob = new Blob([result.text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (selectedFile?.name.replace(/\.[^.]+$/, '') ?? 'transcript') + '_transcript.txt';
    a.click();
    URL.revokeObjectURL(url);
  }, [result, selectedFile]);

  const copyText = useCallback(async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [result]);

  const fmt = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

  const isProcessing = ['loading-ffmpeg', 'extracting', 'chunking', 'transcribing'].includes(stage);
  const wordCount    = result ? result.text.split(/\s+/).filter(Boolean).length : 0;
  const isLargeFile  = selectedFile ? selectedFile.size > LARGE_FILE_BYTES : false;

  /* ── Render ────────────────────────────────────────────── */
  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
               background: #0f0f13; color: #e0e0e8; min-height: 100vh; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #1a1a24; }
        ::-webkit-scrollbar-thumb { background: #3a3a50; border-radius: 3px; }
      `}</style>

      <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
                     padding: '40px 20px', minHeight: '100vh' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, letterSpacing: '-0.5px', marginBottom: 6,
                     background: 'linear-gradient(135deg,#a78bfa,#60a5fa)',
                     WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Video to Text
        </h1>
        <p style={{ color: '#6b7280', marginBottom: 40, fontSize: '0.95rem' }}>
          Transcribe any English video — free, powered by Groq Whisper
        </p>

        <div style={{ background: '#1a1a24', border: '1px solid #2a2a38', borderRadius: 16,
                      padding: 32, width: '100%', maxWidth: 720 }}>

          {/* Drop zone */}
          <div
            onClick={() => !isProcessing && document.getElementById('file-input')?.click()}
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={e => { e.preventDefault(); setIsDragging(false);
              const f = e.dataTransfer.files[0]; if (f && !isProcessing) handleFile(f); }}
            style={{
              border: `2px dashed ${isDragging ? '#a78bfa' : '#3a3a50'}`,
              borderRadius: 12, padding: '48px 20px', textAlign: 'center',
              cursor: isProcessing ? 'default' : 'pointer', transition: 'border-color .2s',
              background: isDragging ? 'rgba(167,139,250,.04)' : 'transparent',
            }}
          >
            <div style={{ fontSize: '3rem', marginBottom: 12 }}>🎬</div>
            <p style={{ color: '#e0e0e8', fontWeight: 600, marginBottom: 4 }}>
              {selectedFile ? selectedFile.name : 'Drop your video here'}
            </p>
            <p style={{ color: '#6b7280', fontSize: '0.875rem' }}>
              {selectedFile
                ? `${(selectedFile.size / 1024 / 1024).toFixed(1)} MB — click to change`
                : 'or click to browse — MP4, MKV, MOV, AVI, WebM and more • any size'}
            </p>
          </div>
          <input id="file-input" type="file" accept={ACCEPTED} style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />

          {/* Large-file notice */}
          {isLargeFile && !isProcessing && stage !== 'done' && (
            <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 8,
                          background: 'rgba(167,139,250,.08)', border: '1px solid rgba(167,139,250,.2)',
                          fontSize: '0.82rem', color: '#c4b5fd' }}>
              File &gt; 1 GB — will extract audio at {LARGE_FILE_SPEED}× speed via browser playback. For fastest results on very large files, use the local desktop version (run.sh) which uses native FFmpeg.
            </div>
          )}

          {/* Transcribe button */}
          <button
            onClick={handleTranscribe}
            disabled={!selectedFile || isProcessing}
            style={{
              width: '100%', marginTop: 20, padding: '14px',
              background: 'linear-gradient(135deg,#7c3aed,#2563eb)',
              color: '#fff', border: 'none', borderRadius: 10, fontSize: '1rem', fontWeight: 600,
              cursor: !selectedFile || isProcessing ? 'not-allowed' : 'pointer',
              opacity: !selectedFile || isProcessing ? 0.5 : 1, transition: 'opacity .2s',
            }}
          >
            {isProcessing ? 'Processing…' : 'Transcribe Video'}
          </button>

          {/* Progress */}
          {isProcessing && (
            <div style={{ marginTop: 24 }}>
              <div style={{ background: '#252535', borderRadius: 99, height: 6,
                            overflow: 'hidden', marginBottom: 8 }}>
                <div style={{
                  height: '100%', borderRadius: 99, transition: 'width .4s ease',
                  background: 'linear-gradient(90deg,#7c3aed,#2563eb)', width: `${progress}%`,
                  animation: 'pulse 1.5s ease-in-out infinite alternate',
                }} />
              </div>
              <p style={{ textAlign: 'center', fontSize: '0.85rem', color: '#9ca3af' }}>{statusMsg}</p>
              <style>{`@keyframes pulse{from{opacity:1}to{opacity:.6}}`}</style>
            </div>
          )}

          {/* Error */}
          {stage === 'error' && (
            <div style={{ marginTop: 20, background: 'rgba(239,68,68,.1)',
                          border: '1px solid rgba(239,68,68,.3)', color: '#f87171',
                          padding: 14, borderRadius: 8, fontSize: '0.875rem' }}>
              {error}
            </div>
          )}

          {/* Result */}
          {stage === 'done' && result && (
            <div style={{ marginTop: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                            alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: '0.875rem', color: '#9ca3af' }}>
                  {wordCount.toLocaleString()} words
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[
                    { label: copied ? 'Copied!' : 'Copy', action: copyText },
                    { label: 'Download .txt', action: downloadTxt },
                  ].map(btn => (
                    <button key={btn.label} onClick={btn.action} style={{
                      padding: '6px 14px', fontSize: '0.8rem', border: '1px solid #3a3a50',
                      background: '#252535', color: '#e0e0e8', borderRadius: 6, cursor: 'pointer',
                    }}>{btn.label}</button>
                  ))}
                </div>
              </div>

              <div style={{ background: '#0f0f13', border: '1px solid #2a2a38', borderRadius: 10,
                            padding: 20, maxHeight: 400, overflowY: 'auto',
                            fontSize: '0.9rem', lineHeight: 1.7, whiteSpace: 'pre-wrap', color: '#d1d5db' }}>
                {result.text}
              </div>

              {result.segments.length > 0 && (
                <>
                  <span onClick={() => setShowSegments(v => !v)}
                    style={{ marginTop: 16, display: 'inline-block', fontSize: '0.8rem',
                             color: '#6b7280', cursor: 'pointer', textDecoration: 'underline dotted' }}>
                    {showSegments ? 'Hide' : 'Show'} timestamped segments
                  </span>
                  {showSegments && (
                    <div style={{ marginTop: 12 }}>
                      {result.segments.map((seg, i) => (
                        <div key={i} style={{ display: 'flex', gap: 12, padding: '8px 12px',
                                             borderLeft: '2px solid #3a3a50', marginBottom: 6,
                                             fontSize: '0.82rem' }}>
                          <span style={{ minWidth: 110, color: '#6b7280', fontVariantNumeric: 'tabular-nums' }}>
                            {fmt(seg.start)} → {fmt(seg.end)}
                          </span>
                          <span style={{ color: '#c9d1d9' }}>{seg.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <p style={{ marginTop: 24, fontSize: '0.75rem', color: '#4b5563', textAlign: 'center' }}>
          Audio is processed locally in your browser · only the compressed audio is sent to Groq for transcription
        </p>
      </main>
    </>
  );
}
