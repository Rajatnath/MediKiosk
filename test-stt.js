const fs = require('fs');
const apiKey = process.env.SARVAM_API_KEY;

// Create a dummy file (1kb of zeros)
fs.writeFileSync('dummy.wav', Buffer.alloc(1200));

async function test(model) {
  const formData = new FormData();
  const fileBlob = new Blob([fs.readFileSync('dummy.wav')], { type: 'audio/wav' });
  formData.append('file', fileBlob, 'dummy.wav');
  formData.append('model', model);
  formData.append('language_code', 'hi-IN');
  formData.append('with_timestamps', 'false');

  const response = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: {
      'api-subscription-key': apiKey,
    },
    body: formData
  });
  
  const text = await response.text();
  console.log(`Model: ${model}, Status: ${response.status}, Response: ${text}`);
}

(async () => {
  await test('saarika:v2.5');
  await test('saaras:v1');
})();
