// crypto/ecdsa.js — только встроенный Node.js crypto, без зависимостей
'use strict';
const crypto = require('crypto');

function toBase64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  const privHex = privateKey.toString('hex');
  const pubHex  = publicKey.toString('hex');
  return { privateKey: privHex, publicKey: pubHex, address: deriveAddress(pubHex) };
}

function deriveAddress(publicKeyHex) {
  const hash = crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex');
  return 'K' + hash.slice(0, 39).toUpperCase();
}

function addressFromPrivate(privateKeyHex) {
  try {
    const privKey = crypto.createPrivateKey({ key: Buffer.from(privateKeyHex, 'hex'), format: 'der', type: 'pkcs8' });
    const pubHex  = crypto.createPublicKey(privKey).export({ type: 'spki', format: 'der' }).toString('hex');
    return { publicKey: pubHex, address: deriveAddress(pubHex) };
  } catch { return null; }
}

function deriveKeyPairFromSeed(seedHex) {
  // Детерминированный ключ из seed: ищем валидный скаляр приватного ключа P-256.
  for (let i = 0; i < 256; i++) {
    const material = crypto.createHash('sha256').update(`${seedHex}:${i}`).digest();
    try {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(material);
      const pub = ecdh.getPublicKey(null, 'uncompressed'); // 0x04 || X(32) || Y(32)
      const x = pub.subarray(1, 33);
      const y = pub.subarray(33, 65);
      const jwk = {
        kty: 'EC',
        crv: 'P-256',
        d: toBase64Url(material),
        x: toBase64Url(x),
        y: toBase64Url(y)
      };
      const privObj = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
      const privateKey = privObj.export({ type: 'pkcs8', format: 'der' }).toString('hex');
      const publicKey = crypto.createPublicKey(privObj).export({ type: 'spki', format: 'der' }).toString('hex');
      return { privateKey, publicKey, address: deriveAddress(publicKey) };
    } catch {
      // Пробуем следующий материал.
    }
  }
  return null;
}

function sign(data, privateKeyHex) {
  try {
    const privKey = crypto.createPrivateKey({ key: Buffer.from(privateKeyHex, 'hex'), format: 'der', type: 'pkcs8' });
    const s = crypto.createSign('SHA256');
    s.update(typeof data === 'string' ? data : JSON.stringify(data));
    return s.sign(privKey, 'hex');
  } catch { return null; }
}

function verify(data, signature, publicKeyHex) {
  try {
    const pubKey = crypto.createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' });
    const v = crypto.createVerify('SHA256');
    v.update(typeof data === 'string' ? data : JSON.stringify(data));
    return v.verify(pubKey, signature, 'hex');
  } catch { return false; }
}

function txSignData(tx) {
  return `${tx.from}:${tx.to}:${tx.amount}:${tx.fee}:${tx.timestamp}:${tx.nonce}`;
}

module.exports = { generateKeyPair, deriveKeyPairFromSeed, deriveAddress, addressFromPrivate, sign, verify, txSignData };
