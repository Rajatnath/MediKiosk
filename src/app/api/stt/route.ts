// src/app/api/stt/route.ts
// Sarvam AI — Speech-to-Text (Saaras model)

import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audioFile = formData.get('audio') as File;
    const lang = formData.get('lang') as string || 'hi';

    if (!audioFile) {
      return NextResponse.json({ error: 'No audio file' }, { status: 400 });
    }

    const apiKey = process.env.SARVAM_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Sarvam API key not set' }, { status: 500 });
    }

    // Map lang to Sarvam language code
    const languageCode = lang === 'hi' ? 'hi-IN' : 'en-IN';

    const arrayBuffer = await audioFile.arrayBuffer();

    // Normalize and strip parameters (e.g. "audio/webm;codecs=opus" -> "audio/webm")
    const rawMime = (audioFile.type || '').toLowerCase();
    const cleanMime = rawMime.split(';')[0].trim();

    // Inspect magic bytes for 100% reliable container detection
    const header = Buffer.from(arrayBuffer.slice(0, 16));
    let targetMime = 'audio/webm';
    let filename = 'recording.webm';

    if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
      // EBML header -> WebM (Chrome, Firefox, Edge)
      targetMime = 'audio/webm';
      filename = 'recording.webm';
    } else if (header.toString('ascii', 0, 4) === 'RIFF') {
      // RIFF header -> WAV
      targetMime = 'audio/wav';
      filename = 'recording.wav';
    } else if (header.toString('ascii', 0, 4) === 'OggS') {
      // OggS header -> OGG
      targetMime = 'audio/ogg';
      filename = 'recording.ogg';
    } else if (header.toString('ascii', 4, 8) === 'ftyp') {
      // ISO/IEC Base Media / MP4 / M4A (Safari iOS / macOS)
      targetMime = 'audio/mp4';
      filename = 'recording.mp4';
    } else if (cleanMime.includes('mp4') || cleanMime.includes('m4a') || cleanMime.includes('aac')) {
      targetMime = cleanMime.includes('aac') ? 'audio/aac' : 'audio/mp4';
      filename = cleanMime.includes('aac') ? 'recording.aac' : 'recording.mp4';
    } else if (cleanMime.includes('wav')) {
      targetMime = 'audio/wav';
      filename = 'recording.wav';
    } else if (cleanMime.includes('ogg')) {
      targetMime = 'audio/ogg';
      filename = 'recording.ogg';
    } else if (cleanMime === 'video/webm' || cleanMime === 'audio/webm') {
      targetMime = 'audio/webm';
      filename = 'recording.webm';
    } else {
      targetMime = 'audio/webm';
      filename = 'recording.webm';
    }

    const sarvamFormData = new FormData();
    // Strictly pass clean targetMime without parameters to satisfy Sarvam's exact whitelist
    const safeBlob = new Blob([arrayBuffer], { type: targetMime });
    sarvamFormData.append('file', safeBlob, filename);
    sarvamFormData.append('model', 'saaras:v3'); // Upgrade to latest Sarvam STT model
    sarvamFormData.append('language_code', languageCode);
    sarvamFormData.append('with_timestamps', 'false');

    const response = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: {
        'api-subscription-key': apiKey,
      },
      body: sarvamFormData,
      signal: AbortSignal.timeout(30000) // Increase timeout to 30s
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Sarvam STT error:', response.status, err);
      return NextResponse.json({ error: 'STT failed', details: err }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json({ transcript: data.transcript || '' });
  } catch (err) {
    console.error('STT route error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
