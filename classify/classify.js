// Classify court party names as company (any organisation) or individual via DeepSeek.
// Usage: node classify.js <total> [concurrency]   env: MONGODB_URI, DEEPSEEK_API_KEY
// Takes the first <total> names of a fixed shuffle and skips ones already in party_types.
const fs = require('fs');
const { MongoClient } = require('mongodb');

const LIMIT = Number(process.argv[2] || 100);
const CONCURRENCY = Number(process.argv[3] || 5);
const MODEL = 'deepseek-flash';
const DIR = '/var/www/email-warmup/ecourts';
const SYSTEM = `You classify party names from Indian High Court cause lists.
Answer "company" if the name is any organisation or non-human entity: company, firm, LLP, bank, society, trust, government, state, department, ministry, official post (e.g. "COMMISSIONER OF INCOME TAX"), board, corporation, university, municipality, union.
Answer "individual" if it is a natural person's name (initials, father's-name suffixes like "S/O" are still individual).
Reply with JSON only: {"type":"company"|"individual","confidence":0-1}`;

function sample(arr, n, seed = 42) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

async function classify(name) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: 'low',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: name }],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  const out = JSON.parse(body.choices[0].message.content);
  return { ...out, usage: body.usage };
}

(async () => {
  const names = new Set();
  for (const city of ['jaipur', 'jodhpur']) {
    const data = JSON.parse(fs.readFileSync(`${DIR}/parties-${city}.json`, 'utf-8'));
    for (const [name] of data.all) names.add(name);
  }
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const col = client.db('ecourts').collection('party_types');
  await col.createIndex({ name: 1 }, { unique: true });
  const done = new Set(await col.distinct('name'));
  const picked = sample([...names].sort(), LIMIT).filter(n => !done.has(n));
  console.log(`distinct parties: ${names.size}, already done: ${done.size}, classifying ${picked.length}`);

  const results = [];
  const queue = picked.slice();
  const tot = { prompt: 0, cached: 0, completion: 0, reasoning: 0 };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const name = queue.shift();
      let r;
      try {
        r = { name, ...(await classify(name)) };
      } catch (err) {
        r = { name, error: err.message };
      }
      results.push(r);
      if (r.usage) {
        tot.prompt += r.usage.prompt_tokens;
        tot.cached += r.usage.prompt_cache_hit_tokens || 0;
        tot.completion += r.usage.completion_tokens;
        tot.reasoning += r.usage.completion_tokens_details?.reasoning_tokens || 0;
      }
      if (r.type) {
        await col.updateOne({ name },
          { $set: { name, type: r.type, confidence: r.confidence, model: MODEL, classified_at: new Date() } },
          { upsert: true });
      }
      if (results.length % 250 === 0) console.log(`${results.length}/${picked.length}`, JSON.stringify(tot));
    }
  }));

  fs.writeFileSync(`results-${Date.now()}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ seconds: (Date.now() - t0) / 1000, errors: results.filter(r => r.error).length, tokens: tot }));
  console.log(`party_types now: ${await col.countDocuments()}`);
  await client.close();
})();
