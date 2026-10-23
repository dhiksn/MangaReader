const crypto = require('crypto');

/**
 * OpenSSL EVP_BytesToKey implementation used by CryptoJS AES.
 */
function evpBytesToKey(password, salt, keyLen = 32, ivLen = 16) {
  let prev = Buffer.alloc(0);
  const buffers = [];
  while (Buffer.concat(buffers).length < keyLen + ivLen) {
    const hash = crypto.createHash('md5');
    hash.update(prev);
    hash.update(password);
    hash.update(salt);
    prev = hash.digest();
    buffers.push(prev);
  }
  const combined = Buffer.concat(buffers);
  return {
    key: combined.subarray(0, keyLen),
    iv: combined.subarray(keyLen, keyLen + ivLen),
  };
}

/**
 * Decrypts a Base64-encoded ciphertext encrypted with CryptoJS.AES.encrypt(data, password)
 * @param {string} ciphertextB64 Base64 string starting with "Salted__"
 * @param {string} password Secret key / passphrase
 * @returns {string} Decrypted plaintext UTF-8 string
 */
function decryptCryptoJS(ciphertextB64, password) {
  const buf = Buffer.from(ciphertextB64, 'base64');
  if (buf.subarray(0, 8).toString('utf8') !== 'Salted__') {
    throw new Error('Invalid CryptoJS format: missing Salted__ header');
  }
  const salt = buf.subarray(8, 16);
  const ciphertext = buf.subarray(16);
  const { key, iv } = evpBytesToKey(Buffer.from(password, 'utf8'), salt, 32, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = {
  decryptCryptoJS,
  evpBytesToKey,
};
