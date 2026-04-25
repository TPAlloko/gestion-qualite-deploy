// Exécuter une seule fois : node generate-vapid.js
// Puis ajouter les deux variables dans Railway → Settings → Variables
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('\nCopie ces lignes dans Railway → Variables :\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('\n');
