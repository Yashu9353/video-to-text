import Groq from 'groq-sdk';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Lazy-init so build doesn't fail if GROQ_API_KEY is absent at build time
let _groq: Groq | null = null;
function getGroq(): Groq {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

export async function POST(req: NextRequest) {
  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json({ error: 'GROQ_API_KEY is not configured on the server.' }, { status: 500 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Failed to parse request.' }, { status: 400 });
  }

  const file = formData.get('file') as File | null;
  if (!file) {
    return NextResponse.json({ error: 'No audio file provided.' }, { status: 400 });
  }

  try {
    const transcription = await getGroq().audio.transcriptions.create({
      file,
      model: 'whisper-large-v3',
      language: 'en',
      response_format: 'verbose_json',
    });

    return NextResponse.json({
      text: (transcription as any).text ?? '',
      segments: ((transcription as any).segments ?? []).map((s: any) => ({
        start: s.start,
        end: s.end,
        text: s.text,
      })),
    });
  } catch (err: any) {
    const message = err?.error?.message ?? err?.message ?? 'Transcription failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
