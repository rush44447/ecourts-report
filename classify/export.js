// Export ecourts.party_types to the viewer as { name: 'c' | 'i' }.
const fs = require('fs');
const { MongoClient } = require('mongodb');
(async () => {
  const client = await MongoClient.connect(process.env.MONGODB_URI);
  const docs = await client.db('ecourts').collection('party_types').find({}, { projection: { _id: 0, name: 1, type: 1 } }).toArray();
  const out = Object.fromEntries(docs.map(d => [d.name, d.type === 'company' ? 'c' : 'i']));
  const file = '/var/www/email-warmup/ecourts/party-types.json';
  fs.writeFileSync(file + '.tmp', JSON.stringify(out));
  fs.renameSync(file + '.tmp', file);
  console.log('exported', docs.length, 'to', file);
  await client.close();
})();
