const crypto = require('crypto');

const secret = crypto.randomBytes(32).toString('hex');

console.log('==============================================');
console.log('Generated JWT Secret (copy this to Render):');
console.log('==============================================');
console.log(secret);
console.log('==============================================');
console.log('Length:', secret.length, 'characters');
