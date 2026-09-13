// src/app/api/stt/route.ts
// Sarvam AI — Speech-to-Text (Saaras model)

import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audioFile = formData.get('audio') as File;
    const lang = formData.get('lang') as string || 'hi';

    console.log('\n--- DIAGNOSTICS: SERVER (INCOMING) ---');
    console.log('Incoming filename:', audioFile?.name);
    console.log('Incoming MIME type:', audioFile?.type);
    console.log('Incoming file size:', audioFile?.size);
    console.log('--------------------------------------');

    if (!audioFile) {
      return NextResponse.json({ error: 'No audio file' }, { status: 400 });
    }

    const apiKey = process.env.SARVAM_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Sarvam API key not set' }, { status: 500 });
    }

    // Map lang to Sarvam language code
    const languageCode = lang === 'hi' ? 'hi-IN' : 'en-IN';

    // Determine appropriate filename & extension based on incoming MIME type
    const mimeType = audioFile.type || '';
    let filename = 'recording.webm';
    if (mimeType.includes('mp4') || mimeType.includes('m4a')) {
      filename = 'recording.mp4';
    } else if (mimeType.includes('wav')) {
      filename = 'recording.wav';
    } else if (mimeType.includes('ogg') || mimeType.includes('opus')) {
      filename = 'recording.ogg';
    }

    const sarvamFormData = new FormData();
    const arrayBuffer = await audioFile.arrayBuffer();
    const safeBlob = new Blob([arrayBuffer], { type: mimeType || 'audio/webm' });
    sarvamFormData.append('file', safeBlob, filename);
    sarvamFormData.append('model', 'saarika:v2.5');
    sarvamFormData.append('language_code', languageCode);
    sarvamFormData.append('with_timestamps', 'false');

    console.log('\n--- DIAGNOSTICS: SERVER (RECONSTRUCTED) ---');
    console.log('Reconstructed file MIME type:', safeBlob.type);
    console.log('Reconstructed file size:', safeBlob.size);
    console.log('---------------------------------------------');

    const response = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: {
        'api-subscription-key': apiKey,
      },
      body: sarvamFormData,
      signal: AbortSignal.timeout(30000) // Increase timeout to 30s
    });

    console.log('\n--- DIAGNOSTICS: SERVER (SARVAM RESPONSE) ---');
    console.log('HTTP status:', response.status);

    if (!response.ok) {
      const err = await response.text();
      console.log('Error JSON body:', err);
      console.log('---------------------------------------------');
      return NextResponse.json({ error: 'STT failed', details: err }, { status: response.status });
    }

    const data = await response.json();
    console.log('Success payload:', JSON.stringify(data));
    console.log('---------------------------------------------');
    return NextResponse.json({ transcript: data.transcript || '' });
  } catch (err) {
    console.error('STT route error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
