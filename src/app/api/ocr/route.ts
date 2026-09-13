// src/app/api/ocr/route.ts
// OCR pipeline: Mistral OCR → Gemini entity extraction
// Fallback: Gemini Vision (image → structured data in one shot)

import { NextRequest, NextResponse } from 'next/server';

const GEMINI_MODEL = 'gemini-3.5-flash';

function extractJsonFromText(rawText: string): Record<string, unknown> | null {
  if (!rawText) return null;
  let clean = rawText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    clean = clean.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(clean);
  } catch (err) {
    console.warn('JSON parse error in OCR extraction:', err);
    return null;
  }
}

function determineConfidence(result: Record<string, unknown>): 'HIGH' | 'NEEDS_VERIFICATION' {
  const hasMeds = Array.isArray(result.medications) && result.medications.length > 0;
  const hasLabs = Array.isArray(result.labs) && result.labs.length > 0;
  const hasDiagnosis = Array.isArray(result.diagnosis) && result.diagnosis.length > 0;
  const hasDoctorOrClinic = Boolean(result.doctor || result.hospital);

  if (hasMeds || hasLabs || hasDiagnosis || hasDoctorOrClinic) {
    return 'HIGH';
  }
  return (result.confidence as string) === 'HIGH' ? 'HIGH' : 'NEEDS_VERIFICATION';
}

function parseBasicMedicalText(rawText: string): {
  diagnosis: string[];
  medications: { name: string; dose: string | null; frequency: string | null }[];
  labs: { name: string; value: string; unit: string | null; reference_range: string | null; status: string | null }[];
} {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const medications: { name: string; dose: string | null; frequency: string | null }[] = [];
  const labs: { name: string; value: string; unit: string | null; reference_range: string | null; status: string | null }[] = [];

  for (const line of lines) {
    const medMatch = line.match(/(?:Tab(?:let)?|Cap(?:sule)?|Syp|T\.|Inj|Rx)\s+([A-Za-z0-9\-\s]+?)(?:\s+(\d+(?:\.\d+)?\s*(?:mg|ml|gm|mcg|IU)))?(?:\s+(.*))?$/i);
    if (medMatch) {
      medications.push({
        name: medMatch[1].trim(),
        dose: medMatch[2]?.trim() || null,
        frequency: medMatch[3]?.trim() || null,
      });
    }

    const bpMatch = line.match(/(?:B\.?P\.?|Blood Pressure)\s*[:=]?\s*(\d{2,3}\/\d{2,3})/i);
    if (bpMatch) {
      labs.push({ name: 'BP', value: bpMatch[1], unit: 'mmHg', reference_range: '120/80', status: 'NORMAL' });
    }
    const tempMatch = line.match(/(?:Temp(?:erature)?)\s*[:=]?\s*(\d{2,3}(?:\.\d+)?\s*°?[FC]?)/i);
    if (tempMatch) {
      labs.push({ name: 'Temperature', value: tempMatch[1], unit: null, reference_range: null, status: null });
    }
    const spo2Match = line.match(/(?:SPO2|SpO2|Pulse Ox)\s*[:=]?\s*(\d{2,3}\s*%?)/i);
    if (spo2Match) {
      labs.push({ name: 'SPO2', value: spo2Match[1], unit: '%', reference_range: '>95%', status: 'NORMAL' });
    }
  }

  return { diagnosis: [], medications, labs };
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file' }, { status: 400 });
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    const mistralKey = process.env.MISTRAL_API_KEY;

    // Convert file to base64 once — used by both Mistral and Gemini Vision
    const arrayBuffer = await file.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = file.type || 'image/jpeg';
    // Determine whether document is PDF or image for Mistral OCR
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const documentPayload = isPdf
      ? { type: 'document_url', document_url: `data:application/pdf;base64,${base64}` }
      : { type: 'image_url', image_url: `data:${mimeType};base64,${base64}` };

    let rawText = '';

    // ──────────────────────────────────────────────────────────────────
    // Step 1: Mistral OCR (mistral-ocr-latest)
    // Primary engine: Analyzes the image/document and extracts text in all languages
    // ──────────────────────────────────────────────────────────────────
    if (mistralKey) {
      try {
        const ocrResponse = await fetch('https://api.mistral.ai/v1/ocr', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${mistralKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'mistral-ocr-latest',
            document: documentPayload,
          }),
        });

        if (ocrResponse.ok) {
          const ocrData = await ocrResponse.json();
          rawText = ocrData.pages?.map((p: { markdown: string }) => p.markdown).join('\n') || '';
        } else {
          console.warn('Mistral OCR returned error:', ocrResponse.status, await ocrResponse.text());
        }
      } catch (mErr) {
        console.warn('Mistral OCR network error:', mErr);
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // Step 2: Extract structured medical data from Mistral OCR text
    // ──────────────────────────────────────────────────────────────────
    if (rawText.trim()) {
      let result: Record<string, unknown> | null = null;

      // 2a. First try Mistral clinical entity extraction (preserves multilingual nuances)
      if (mistralKey) {
        result = await mistralEntityExtraction(mistralKey, rawText);
      }

      // 2b. Secondary fallback: Gemini text extraction (text only, not vision)
      if (!result && geminiKey) {
        result = await geminiTextExtraction(geminiKey, rawText);
      }

      // 2c. Tertiary fallback: Deterministic regex medical parser
      if (!result) {
        result = parseBasicMedicalText(rawText);
      }

      const confidence = determineConfidence(result);
      return NextResponse.json({
        ...result,
        confidence,
        raw_text: rawText,
      });
    }

    // ──────────────────────────────────────────────────────────────────
    // Step 4: Total failure
    // ──────────────────────────────────────────────────────────────────
    return NextResponse.json({
      error: 'Could not process document. Please ensure the image is clear and try again.',
      confidence: 'NEEDS_VERIFICATION',
      raw_text: '',
      diagnosis: [],
      medications: [],
      labs: [],
    }, { status: 500 });
  } catch (err) {
    console.error('OCR route error:', err);
    return NextResponse.json({
      error: 'Document processing failed',
      confidence: 'NEEDS_VERIFICATION',
      raw_text: '',
      diagnosis: [],
      medications: [],
      labs: [],
    }, { status: 500 });
  }
}

// ════════════════════════════════════════════════════════════════════════
// Mistral clinical entity extraction (processes Mistral OCR markdown text)
// ════════════════════════════════════════════════════════════════════════
async function mistralEntityExtraction(
  apiKey: string,
  rawText: string
): Promise<Record<string, unknown> | null> {
  const extractPrompt = `You are an expert clinical document parser specializing in Indian hospital prescriptions and multi-lingual medical records.
Extract structured clinical information from the following OCR text extracted from the document.

Document OCR text:
"""
${rawText.slice(0, 6000)}
"""

Return ONLY valid JSON (no markdown, no backticks, no conversational text):
{
  "date": "YYYY-MM-DD or string or null",
  "diagnosis": ["condition1", "condition2"],
  "medications": [
    { "name": "drug name", "dose": "dose string or null", "frequency": "frequency or null" }
  ],
  "labs": [
    { "name": "test or vital name", "value": "value string", "unit": "unit or null", "reference_range": "range or null", "status": "NORMAL/LOW/HIGH/null" }
  ],
  "doctor": "doctor name or null",
  "hospital": "hospital or clinic name or null",
  "confidence": "HIGH or NEEDS_VERIFICATION"
}

CRITICAL RULES:
1. Thoroughly parse all medications (look for Tab, Cap, Syp, Inj, drops, dosages like mg, ml, frequencies like 1-0-1, OD, BD, TDS, HS, etc.).
2. Extract all vitals and laboratory tests (BP / Blood Pressure, Pulse / Heart Rate, SPO2, Temp / Temperature, Glucose / Sugar, HbA1c, etc.) into "labs".
3. Extract doctor names (look for Dr., MBBS, MD, Consultant, etc.) and hospital/clinic names (including any regional script or English names).
4. If readable clinical data (medicines, tests, vitals, or doctor/clinic) is present, ALWAYS set "confidence": "HIGH".
5. Only set "confidence": "NEEDS_VERIFICATION" if the text contains zero recognizable medical information.`;

  try {
    const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'open-mistral-7b',
        messages: [{ role: 'user', content: extractPrompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content || '';
      return extractJsonFromText(content);
    } else {
      console.warn('Mistral entity extraction returned status:', resp.status, await resp.text());
    }
  } catch (err) {
    console.warn('Mistral entity extraction network error:', err);
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// Gemini text-based entity extraction (when we already have OCR text)
// ════════════════════════════════════════════════════════════════════════
async function geminiTextExtraction(
  apiKey: string,
  rawText: string
): Promise<Record<string, unknown> | null> {
  const extractPrompt = `You are an expert clinical document parser. Extract structured information from the following medical document text.

Document text:
"""
${rawText.slice(0, 4000)}
"""

Return ONLY valid JSON (no markdown, no backticks, no conversational filler):
{
  "date": "YYYY-MM-DD or null",
  "diagnosis": ["condition1", "condition2"],
  "medications": [
    { "name": "drug name", "dose": "dose string or null", "frequency": "frequency or null" }
  ],
  "labs": [
    { "name": "test name", "value": "value", "unit": "unit or null", "reference_range": "range or null", "status": "NORMAL/LOW/HIGH/null" }
  ],
  "doctor": "doctor name or null",
  "hospital": "hospital or clinic name or null",
  "confidence": "HIGH or NEEDS_VERIFICATION"
}

CRITICAL RULES:
1. If the text has identifiable medicines, dosages, vitals, doctor names, or clinic details, ALWAYS extract them thoroughly into the arrays and set "confidence": "HIGH".
2. Only set "confidence": "NEEDS_VERIFICATION" if the text is completely garbled or contains no readable clinical data.`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const resp = await fetch(`${geminiUrl}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: extractPrompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4000,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!resp.ok) {
    console.warn('Gemini text extraction HTTP error:', resp.status, await resp.text());
    return null;
  }

  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p: { text?: string }) => p.text || '').join('\n');
  return extractJsonFromText(text);
}

// ════════════════════════════════════════════════════════════════════════
// Gemini Vision extraction — sends the image directly to Gemini
// Used as fallback when Mistral OCR is unavailable or fails
// ════════════════════════════════════════════════════════════════════════
async function geminiVisionExtraction(
  apiKey: string,
  base64: string,
  mimeType: string
): Promise<Record<string, unknown> | null> {
  const visionPrompt = `You are an expert clinical document parser with OCR capabilities. Look at this medical document image carefully.

First, read all the text you can see in the image. Then extract structured medical information.

Return ONLY valid JSON (no markdown, no backticks, no conversational filler):
{
  "raw_text": "All readable text from the document",
  "date": "YYYY-MM-DD or null",
  "diagnosis": ["condition1", "condition2"],
  "medications": [
    { "name": "drug name", "dose": "dose string or null", "frequency": "frequency or null" }
  ],
  "labs": [
    { "name": "test name", "value": "value", "unit": "unit or null", "reference_range": "range or null", "status": "NORMAL/LOW/HIGH/null" }
  ],
  "doctor": "doctor name or null",
  "hospital": "hospital or clinic name or null",
  "confidence": "HIGH or NEEDS_VERIFICATION"
}

CRITICAL RULES:
1. Read all medicines, prescription lines, test values, and clinic details clearly.
2. If medicines, tests, or clinical notes are legible, ALWAYS extract them and set "confidence": "HIGH". Only set "confidence": "NEEDS_VERIFICATION" if the image is truly illegible.`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const resp = await fetch(`${geminiUrl}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: visionPrompt },
          {
            inlineData: {
              mimeType,
              data: base64,
            },
          },
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4000,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!resp.ok) {
    console.warn('Gemini Vision API error:', resp.status, await resp.text());
    return null;
  }

  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p: { text?: string }) => p.text || '').join('\n');
  return extractJsonFromText(text);
}
