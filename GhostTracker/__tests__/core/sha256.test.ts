/**
 * SHA-256 against the FIPS 180-4 / NIST test vectors, and the node-ID
 * derivation used for privacy (thesis §6.3.2–6.3.3).
 */
// Node's crypto is the reference implementation (core tsconfig has no Node typings)
declare const require: (m: string) => any;
const { createHash } = require('crypto') as {
  createHash: (alg: string) => { update: (s: string, enc?: string) => { digest: (e: string) => string } };
};
import { sha256Hex, nodeIdFor, isNodeId, NODE_ID_SALT } from '../../src/utils/sha256';

describe('sha256', () => {
  it('matches the NIST vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches Node crypto across padding boundaries and UTF-8', () => {
    for (const len of [55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const s = 'x'.repeat(len);
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
    const text = 'Jayavi – ජයවී 🏃';
    expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });
});

describe('node IDs', () => {
  it('are 16 lowercase hex characters derived from the device ID and salt', () => {
    const id = nodeIdFor('f9b4-2a01-0668-6709-da6b-fb8b');
    expect(isNodeId(id)).toBe(true);
    expect(id).toBe(createHash('sha256').update('f9b4-2a01-0668-6709-da6b-fb8b' + NODE_ID_SALT).digest('hex').slice(0, 16));
  });

  it('are deterministic and differ between devices', () => {
    expect(nodeIdFor('a')).toBe(nodeIdFor('a'));
    expect(nodeIdFor('a')).not.toBe(nodeIdFor('b'));
  });

  it('do not contain the device ID', () => {
    const raw = '87e2-5900-7ea7-f160-67c2-ee3b';
    expect(nodeIdFor(raw)).not.toContain(raw.slice(0, 4));
  });
});
