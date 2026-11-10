const N = require('./src/sources/natsu/NatsuSource');
new N().getDetails('money-keeps-piling-up-no-matter-how-much-i-spend').then(r => {
  console.log('related count:', r.related.length);
  console.log(JSON.stringify(r.related, null, 2));
}).catch(e => console.error(e.message));
